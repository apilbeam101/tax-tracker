import { describe, expect, it } from 'vitest'
import { applyCliEnv, parseCli, UsageError } from './cli-args.ts'

describe('parseCli', () => {
  it('defaults to start with no arguments', () => {
    expect(parseCli([]).command).toBe('start')
  })

  it('reads flags for start', () => {
    const cli = parseCli(['start', '--port', '0', '--host', '0.0.0.0', '--data-dir', 'x', '--open'])
    expect(cli).toMatchObject({
      command: 'start',
      port: '0',
      host: '0.0.0.0',
      dataDir: 'x',
      open: true,
    })
  })

  it('accepts flags without a command', () => {
    expect(parseCli(['--port', '8080'])).toMatchObject({ command: 'start', port: '8080' })
  })

  it('parses keys subcommands and rejects unknown ones', () => {
    expect(parseCli(['keys', 'rotate-recovery'])).toMatchObject({
      command: 'keys',
      subcommand: 'rotate-recovery',
    })
    expect(() => parseCli(['keys'])).toThrow(UsageError)
    expect(parseCli(['keys', 'rotate'])).toMatchObject({ command: 'keys', subcommand: 'rotate' })
    expect(() => parseCli(['keys', 'rotate-everything'])).toThrow(UsageError)
    expect(() => parseCli(['keys', 'add-unattended', 'extra'])).toThrow(UsageError)
  })

  it('takes a file for restore and import, and flags for export and import', () => {
    expect(parseCli(['restore', 'b.db'])).toMatchObject({ command: 'restore', file: 'b.db' })
    expect(parseCli(['import', 'a.json', '--replace'])).toMatchObject({
      command: 'import',
      file: 'a.json',
      replace: true,
    })
    expect(parseCli(['export', '--out', 'x.json', '--plaintext'])).toMatchObject({
      command: 'export',
      out: 'x.json',
      plaintext: true,
    })
    expect(parseCli(['restore', 'b.db', '-y']).yes).toBe(true)
    expect(parseCli(['restore', 'b.db']).yes).toBe(false)
    expect(() => parseCli(['restore'])).toThrow(UsageError)
    expect(() => parseCli(['import', 'a', 'b'])).toThrow(UsageError)
  })

  it.each(['-1', '65536', 'abc', '3.5', ''])('rejects --port %j', (port) => {
    expect(() => parseCli(['--port', port])).toThrow(UsageError)
  })

  it('rejects unknown commands, unknown flags and stray arguments', () => {
    expect(() => parseCli(['launch'])).toThrow(/Unknown command/)
    expect(() => parseCli(['--bogus'])).toThrow(UsageError)
    expect(() => parseCli(['info', 'extra'])).toThrow(/Unexpected argument/)
  })

  it('maps help and version', () => {
    expect(parseCli(['--help']).command).toBe('help')
    expect(parseCli(['-v']).command).toBe('version')
  })
})

describe('applyCliEnv', () => {
  it('turns on self-configured mode unless AUTO_CONFIG is already set', () => {
    const fresh: NodeJS.ProcessEnv = {}
    applyCliEnv(fresh, parseCli([]))
    expect(fresh.AUTO_CONFIG).toBe('true')

    const explicit: NodeJS.ProcessEnv = { AUTO_CONFIG: 'false' }
    applyCliEnv(explicit, parseCli([]))
    expect(explicit.AUTO_CONFIG).toBe('false')
  })

  it('lets flags override the environment', () => {
    const env: NodeJS.ProcessEnv = { PORT: '3000', HOST: '127.0.0.1', DATA_DIR: 'old' }
    applyCliEnv(env, parseCli(['--port', '0', '--host', '::1', '--data-dir', 'new']))
    expect(env).toMatchObject({ PORT: '0', HOST: '::1', DATA_DIR: 'new' })
  })

  it('refuses --data-dir when DB_PATH already fixes the database', () => {
    expect(() => applyCliEnv({ DB_PATH: 'a.db' }, parseCli(['--data-dir', 'x']))).toThrow(
      UsageError,
    )
  })
})
