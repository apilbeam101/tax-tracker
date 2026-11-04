import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import { appVersion } from '../commands/info.ts'
import { leftoverCopies, removePlaintextCopies } from '../crypto/upgrade.ts'
import { BadRequestError, ConflictError, NotFoundError } from '../errors.ts'
import {
  type ArchiveStores,
  buildArchive,
  encryptArchive,
  type ImportMode,
  importArchive,
  parseArchive,
} from '../services/backup/archive.ts'
import { backupDir, backupPath, createBackup, listBackups } from '../services/backup/backups.ts'
import {
  cancelPendingRestore,
  hasPendingRestore,
  stageRestore,
} from '../services/backup/restore.ts'
import { recalcAllInstruments } from '../services/tax/recalc.ts'

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024

function archiveStores(app: Parameters<FastifyPluginAsync>[0]): ArchiveStores {
  return {
    db: app.db,
    instruments: app.instruments,
    transactions: app.transactions,
    vestSchedules: app.vestSchedules,
    prices: app.prices,
    fxRates: app.fxRates,
  }
}

export const backupRoutes: FastifyPluginAsync = async (app) => {
  const dataDir = () => app.runtime.dataDir

  // A restore upload is the raw .db file, not JSON.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  )

  // Copies of the data that are not encrypted (old backups, .bak files, Ghostfolio exports). Only
  // meaningful once the database itself is protected: until then every backup is such a copy and
  // nothing may be offered for deletion. Files that could not be read are listed apart and are
  // never deletable.
  const leftovers = () =>
    app.keyring.isProtected
      ? leftoverCopies(app.db, dataDir(), backupDir(dataDir()))
      : { deletable: [], unreadable: [] }

  app.get('/backup', async () => {
    const { deletable, unreadable } = leftovers()
    return {
      backups: listBackups(dataDir()),
      restorePending: hasPendingRestore(dataDir()),
      plaintextCopies: deletable,
      unreadableCopies: unreadable,
    }
  })

  app.post<{ Body: { copies: Array<{ name: string; location: 'backups' | 'data' }> } }>(
    '/backup/plaintext-copies/delete',
    {
      schema: {
        body: {
          type: 'object',
          required: ['copies'],
          properties: {
            copies: {
              type: 'array',
              maxItems: 200,
              items: {
                type: 'object',
                required: ['name', 'location'],
                properties: {
                  name: { type: 'string', maxLength: 255 },
                  location: { type: 'string', enum: ['backups', 'data'] },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      if (!app.keyring.isProtected) {
        throw new ConflictError(
          'Nothing is deleted while the database itself is not encrypted: its backups are all unencrypted',
        )
      }
      const removed = removePlaintextCopies(
        app.db,
        dataDir(),
        backupDir(dataDir()),
        req.body.copies,
      )
      return { removed: removed.length, ...leftovers() }
    },
  )

  app.post('/backup', async () => createBackup(app.db, dataDir(), 'manual'))

  app.get<{ Params: { name: string } }>('/backup/:name', async (req, reply) => {
    const path = backupPath(dataDir(), req.params.name)
    if (!path) throw new NotFoundError('No such backup')
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${req.params.name}"`)
      .send(createReadStream(path))
  })

  // Stages the uploaded file; the swap happens at the next start, before the database is opened.
  // With RESTORE_RESTART=exit (containers and services that restart on exit) the server then exits
  // by itself once the response has been sent; otherwise someone has to restart it. Anything written
  // between staging and the restart is lost, since the whole database is replaced.
  app.post<{ Body: Buffer }>('/backup/restore', async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new BadRequestError('Upload a backup file (.db)')
    }
    const staged = await stageRestore(
      app.runtime.dbPath ?? join(dataDir(), 'taxtracker.db'),
      req.body,
      { encryptionKey: app.runtime.unattendedKey },
    )
    const restarting = app.runtime.restoreRestart === 'exit'
    if (restarting) {
      reply.raw.once('finish', () => {
        setTimeout(() => {
          try {
            app.db.close()
          } catch {
            /* already closed */
          }
          process.exit(0)
        }, 200)
      })
    }
    return { staged: true, protected: staged.protected, sameKeys: staged.sameKeys, restarting }
  })

  app.delete('/backup/restore', async () => ({ cancelled: cancelPendingRestore(dataDir()) }))

  app.post<{ Body: { passphrase?: string; plaintext?: boolean; confirmPlaintext?: boolean } }>(
    '/export/archive',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            passphrase: { type: 'string', maxLength: 1024 },
            plaintext: { type: 'boolean' },
            confirmPlaintext: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { passphrase, plaintext, confirmPlaintext } = req.body ?? {}
      const archive = buildArchive(archiveStores(app), appVersion())
      let output: unknown
      if (plaintext) {
        if (!confirmPlaintext) {
          throw new BadRequestError('A plaintext export must be confirmed explicitly')
        }
        output = archive
      } else {
        if (!passphrase) throw new BadRequestError('Choose an export passphrase')
        output = await encryptArchive(archive, passphrase)
      }
      const stamp = new Date().toISOString().slice(0, 10)
      return reply
        .header('content-type', 'application/json')
        .header('content-disposition', `attachment; filename="tax-tracker-archive-${stamp}.json"`)
        .send(JSON.stringify(output))
    },
  )

  app.post<{
    Body: { archive: string; passphrase?: string; mode: ImportMode; confirmReplace?: boolean }
  }>(
    '/import/archive',
    {
      bodyLimit: MAX_ARCHIVE_BYTES,
      schema: {
        body: {
          type: 'object',
          required: ['archive', 'mode'],
          properties: {
            archive: { type: 'string' },
            passphrase: { type: 'string', maxLength: 1024 },
            mode: { type: 'string', enum: ['into-empty', 'replace'] },
            confirmReplace: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const { archive: text, passphrase, mode, confirmReplace } = req.body
      if (mode === 'replace' && !confirmReplace) {
        throw new BadRequestError('Replacing your data must be confirmed explicitly')
      }
      const archive = await parseArchive(text, passphrase)
      if (mode === 'replace') await createBackup(app.db, dataDir(), 'pre-import')
      const summary = importArchive(archiveStores(app), archive, mode, req.session.user!.id)
      recalcAllInstruments(app)
      return summary
    },
  )
}
