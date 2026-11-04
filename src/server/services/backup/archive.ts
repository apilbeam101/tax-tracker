import { randomBytes } from 'node:crypto'
import type {
  CreateInstrumentBody,
  CreateTransactionBody,
  FxRate,
  Instrument,
  Price,
  Transaction,
  UpdateTransactionBody,
} from '../../../shared/types.ts'
import { DecryptionError, fromBase64Url, open, seal, toBase64Url } from '../../crypto/aead.ts'
import {
  type Argon2idParams,
  DEFAULT_PASSPHRASE_KDF,
  deriveKekFromPassphrase,
  parseKdfParams,
} from '../../crypto/kdf.ts'
import type { Db } from '../../db/database.ts'
import { BadRequestError, ConflictError } from '../../errors.ts'
import type {
  FxRateStore,
  InstrumentStore,
  PriceStore,
  TransactionStore,
  VestSchedule,
  VestScheduleStore,
} from '../../repositories/index.ts'

import { validateArchiveData } from './archive-validate.ts'

export const ARCHIVE_FORMAT = 'tax-tracker-archive'
export const ARCHIVE_VERSION = 1
export const ARCHIVE_PASSPHRASE_REQUIRED = 'ARCHIVE_PASSPHRASE_REQUIRED'
export const MIN_ARCHIVE_PASSPHRASE = 12

const TENANT_ID = 1
const SALT_BYTES = 16

// Bound to the version recorded in the file, so an archive written by an older app still opens
// after ARCHIVE_VERSION moves on.
const aadFor = (version: number) => Buffer.from(`${ARCHIVE_FORMAT}.v${version}`)

// An archive can come from anywhere, so its key-derivation cost is capped well below what
// parseKdfParams accepts for key slots: a hostile file must not be able to exhaust memory or time.
const MAX_ARCHIVE_KDF = { memoryKiB: 262_144, timeCost: 10, parallelism: 8 }

function archiveKdf(raw: unknown): Argon2idParams {
  let kdf: ReturnType<typeof parseKdfParams>
  try {
    kdf = parseKdfParams(JSON.stringify(raw))
  } catch {
    throw new BadRequestError('The archive is damaged')
  }
  if (
    kdf.kdf !== 'argon2id' ||
    kdf.memoryKiB > MAX_ARCHIVE_KDF.memoryKiB ||
    kdf.timeCost > MAX_ARCHIVE_KDF.timeCost ||
    kdf.parallelism > MAX_ARCHIVE_KDF.parallelism
  ) {
    throw new BadRequestError('The archive is damaged')
  }
  return kdf
}

type Row = Record<string, string | null>

export interface ArchiveData {
  instruments: Instrument[]
  transactions: Transaction[]
  vestSchedule: VestSchedule[]
  taxYearConfig: Row[]
  fxRates: FxRate[]
  prices: Price[]
}

export interface Archive {
  format: typeof ARCHIVE_FORMAT
  formatVersion: number
  appVersion: string
  exportedAt: string
  encrypted: false
  data: ArchiveData
}

export interface EncryptedArchive {
  format: typeof ARCHIVE_FORMAT
  formatVersion: number
  appVersion: string
  exportedAt: string
  encrypted: true
  kdf: Argon2idParams
  salt: string
  payload: string
}

export interface ArchiveStores {
  db: Db
  instruments: InstrumentStore
  transactions: TransactionStore
  vestSchedules: VestScheduleStore
  prices: PriceStore
  fxRates: FxRateStore
}

export function buildArchive(stores: ArchiveStores, appVersion: string): Archive {
  const { db } = stores
  const instruments = stores.instruments.list(TENANT_ID)
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    encrypted: false,
    data: {
      instruments,
      transactions: stores.transactions.list(TENANT_ID),
      vestSchedule: stores.vestSchedules.list(TENANT_ID),
      taxYearConfig: db.prepare('SELECT * FROM tax_year_config ORDER BY tax_year').all() as Row[],
      fxRates: (
        db.prepare('SELECT * FROM fx_rate ORDER BY id').all() as unknown as Array<
          Record<string, string | number>
        >
      ).map((r) => ({
        id: Number(r.id),
        fromCurrency: String(r.from_currency),
        toCurrency: String(r.to_currency),
        rateDate: String(r.rate_date),
        rate: String(r.rate),
        rateType: String(r.rate_type) as FxRate['rateType'],
        source: String(r.source),
        fetchedAt: String(r.fetched_at),
      })),
      prices: instruments.flatMap((i) => stores.prices.listRange(i.id, '0000-01-01', '9999-12-31')),
    },
  }
}

export async function encryptArchive(
  archive: Archive,
  passphrase: string,
  kdf: Argon2idParams = DEFAULT_PASSPHRASE_KDF,
): Promise<EncryptedArchive> {
  if (passphrase.length < MIN_ARCHIVE_PASSPHRASE) {
    throw new BadRequestError(
      `The export passphrase must be at least ${MIN_ARCHIVE_PASSPHRASE} characters`,
    )
  }
  const salt = randomBytes(SALT_BYTES)
  const key = await deriveKekFromPassphrase(passphrase, salt, kdf)
  try {
    const { data, ...header } = archive
    return {
      ...header,
      encrypted: true,
      kdf,
      salt: toBase64Url(salt),
      payload: toBase64Url(
        seal(key, Buffer.from(JSON.stringify(data)), aadFor(archive.formatVersion)),
      ),
    }
  } finally {
    key.fill(0)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function parseArchive(text: string, passphrase?: string): Promise<Archive> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BadRequestError('That file is not a Tax Tracker archive (it is not valid JSON)')
  }
  if (!isObject(raw) || raw.format !== ARCHIVE_FORMAT) {
    throw new BadRequestError('That file is not a Tax Tracker archive')
  }
  const version = raw.formatVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new BadRequestError('The archive has no valid format version')
  }
  if (version > ARCHIVE_VERSION) {
    throw new BadRequestError(
      `The archive uses format version ${version}, which is newer than this version of Tax Tracker understands`,
    )
  }
  // Raising ARCHIVE_VERSION needs a migration for older archives before this check can be relaxed.
  if (version < ARCHIVE_VERSION) {
    throw new BadRequestError(`Archive format version ${version} is not supported`)
  }

  let data: unknown = raw.data
  if (raw.encrypted === true) {
    if (!passphrase) {
      throw new BadRequestError(
        'This archive is encrypted: enter its export passphrase',
        ARCHIVE_PASSPHRASE_REQUIRED,
      )
    }
    if (typeof raw.salt !== 'string' || typeof raw.payload !== 'string') {
      throw new BadRequestError('The archive is damaged')
    }
    const kdf = archiveKdf(raw.kdf)
    const salt = fromBase64Url(raw.salt)
    if (salt.length !== SALT_BYTES) throw new BadRequestError('The archive is damaged')
    const key = await deriveKekFromPassphrase(passphrase, salt, kdf)
    try {
      data = JSON.parse(open(key, fromBase64Url(raw.payload), aadFor(version)).toString('utf8'))
    } catch (err) {
      if (err instanceof DecryptionError) {
        throw new BadRequestError('Wrong export passphrase, or the archive is damaged')
      }
      throw new BadRequestError('The archive is damaged')
    } finally {
      key.fill(0)
    }
  }

  const archive: Archive = {
    format: ARCHIVE_FORMAT,
    formatVersion: version,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : 'unknown',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    encrypted: false,
    data: data as ArchiveData,
  }
  return { ...archive, data: validateArchiveData(archive.data) }
}

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined

function instrumentBody(i: Instrument): CreateInstrumentBody {
  return {
    ticker: i.ticker,
    name: i.name,
    currency: i.currency,
    instrumentType: i.instrumentType,
    isEmployerStock: i.isEmployerStock,
    rsuWithholdingMethod: i.rsuWithholdingMethod,
    ...(i.isin ? { isin: i.isin } : {}),
    ...(i.exchange ? { exchange: i.exchange } : {}),
    ...(i.notes ? { notes: i.notes } : {}),
  }
}

function transactionBody(t: Transaction, instrumentId: number): CreateTransactionBody {
  const optional = {
    unitPriceNative: t.unitPriceNative,
    nativeCurrency: t.nativeCurrency,
    fxRate: t.fxRate,
    fxRateType: t.fxRateType,
    costsGbp: t.costsGbp,
    incomeAmountGbp: t.incomeAmountGbp,
    esppDiscountPriceNative: t.esppDiscountPriceNative,
    rsuGrossSharesVested: t.rsuGrossSharesVested,
    rsuSharesWithheld: t.rsuSharesWithheld,
    rsuWithholdingRate: t.rsuWithholdingRate,
    rsuWithholdingMethod: t.rsuWithholdingMethod,
    dividendGrossGbp: t.dividendGrossGbp,
    dividendWithholdingGbp: t.dividendWithholdingGbp,
    dividendNetGbp: t.dividendNetGbp,
    splitRatio: t.splitRatio,
    capreturnsPerShareGbp: t.capreturnsPerShareGbp,
    notes: t.notes,
  }
  const body: Record<string, unknown> = {
    instrumentId,
    txnType: t.txnType,
    txnDate: t.txnDate,
    quantity: t.quantity,
  }
  for (const [name, value] of Object.entries(optional)) {
    if (orUndefined(value) !== undefined) body[name] = value
  }
  return body as unknown as CreateTransactionBody
}

// Fields the server derives from the others; written back after create so the stored values are
// exactly what the archive holds rather than recomputed from today's exchange rates.
function derivedFields(t: Transaction): UpdateTransactionBody {
  return {
    unitPriceGbp: t.unitPriceGbp,
    totalGbp: t.totalGbp,
    netGbp: t.netGbp,
    fxRateSource: t.fxRateSource,
    esppDiscountPriceGbp: t.esppDiscountPriceGbp,
  }
}

export type ImportMode = 'into-empty' | 'replace'

export interface ImportSummary {
  instruments: number
  transactions: number
  vestSchedule: number
  prices: number
  fxRates: number
  taxYearConfig: number
}

function isEmpty(stores: ArchiveStores): boolean {
  return (
    stores.instruments.list(TENANT_ID).length === 0 &&
    stores.transactions.list(TENANT_ID).length === 0
  )
}

function mapped(map: Map<number, number>, oldId: number, what: string): number {
  const id = map.get(oldId)
  if (id === undefined)
    throw new BadRequestError(`The archive refers to a missing ${what} (${oldId})`)
  return id
}

// Loads an archive in one SQLite transaction: any failure leaves the database as it was. Derived
// tables (S104 pools, disposals) are not archived; the caller recomputes them afterwards. 'replace'
// clears the existing portfolio first, so the caller must have taken a backup.
export function importArchive(
  stores: ArchiveStores,
  archive: Archive,
  mode: ImportMode,
  userId: number,
): ImportSummary {
  const { db, data } = { db: stores.db, data: archive.data }
  if (mode === 'into-empty' && !isEmpty(stores)) {
    throw new ConflictError(
      'This database already holds instruments or transactions. Import into an empty database, or choose replace.',
      'NOT_EMPTY',
    )
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    if (mode === 'replace') {
      db.exec('DELETE FROM cgt_disposal WHERE tenant_id = 1')
      db.exec('DELETE FROM s104_pool WHERE tenant_id = 1')
      db.exec('DELETE FROM vest_schedule WHERE tenant_id = 1')
      db.exec('DELETE FROM txn WHERE tenant_id = 1')
      db.exec(
        'DELETE FROM price WHERE instrument_id IN (SELECT id FROM instrument WHERE tenant_id = 1)',
      )
      db.exec('DELETE FROM instrument WHERE tenant_id = 1')
    }

    const instrumentIds = new Map<number, number>()
    for (const i of data.instruments) {
      instrumentIds.set(i.id, stores.instruments.create(TENANT_ID, instrumentBody(i), userId).id)
    }

    const txnIds = new Map<number, number>()
    for (const t of data.transactions) {
      const created = stores.transactions.create(
        TENANT_ID,
        transactionBody(t, mapped(instrumentIds, t.instrumentId, 'instrument')),
        userId,
      )
      stores.transactions.update(TENANT_ID, created.id, derivedFields(t), userId)
      txnIds.set(t.id, created.id)
    }

    for (const v of data.vestSchedule) {
      const created = stores.vestSchedules.create(TENANT_ID, {
        instrumentId: mapped(instrumentIds, v.instrumentId, 'instrument'),
        scheduleType: v.scheduleType,
        scheduledDate: v.scheduledDate,
        quantity: v.quantity,
        expectedPriceUsd: v.expectedPriceUsd,
        expectedDiscountPriceNative: v.expectedDiscountPriceNative,
        notes: v.notes,
      })
      if (v.realisedTxnId !== null) {
        stores.vestSchedules.setRealisedTxn(
          TENANT_ID,
          created.id,
          mapped(txnIds, v.realisedTxnId, 'transaction'),
        )
      }
    }

    for (const p of data.prices) {
      stores.prices.upsert({
        instrumentId: mapped(instrumentIds, p.instrumentId, 'instrument'),
        priceDate: p.priceDate,
        closePrice: p.closePrice,
        source: p.source,
      })
    }

    for (const r of data.fxRates) {
      stores.fxRates.upsert({
        fromCurrency: r.fromCurrency,
        toCurrency: r.toCurrency,
        rateDate: r.rateDate,
        rate: r.rate,
        rateType: r.rateType,
        source: r.source,
      })
    }

    addMissingTaxYears(db, data.taxYearConfig)

    db.prepare(
      "INSERT INTO audit_log (tenant_id, user_id, action, entity_type, new_data) VALUES (1, ?, 'archive.import', 'database', ?)",
    ).run(userId, JSON.stringify({ mode, appVersion: archive.appVersion }))
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore secondary rollback failure */
    }
    throw err
  }

  return {
    instruments: data.instruments.length,
    transactions: data.transactions.length,
    vestSchedule: data.vestSchedule.length,
    prices: data.prices.length,
    fxRates: data.fxRates.length,
    taxYearConfig: data.taxYearConfig.length,
  }
}

// Tax year settings are reference data the migrations seed and keep correct. An archive may add a
// year this database lacks, but never changes one it has: otherwise an older export would revert
// corrected rates, and an edited one could set them arbitrarily.
function addMissingTaxYears(db: Db, rows: Row[]): void {
  const known = new Set(
    (db.prepare('PRAGMA table_info(tax_year_config)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  )
  for (const row of rows) {
    const columns = Object.keys(row)
    if (typeof row.tax_year !== 'string' || columns.some((c) => !known.has(c))) {
      throw new BadRequestError('The archive holds an invalid tax year configuration')
    }
    try {
      db.prepare(
        `INSERT OR IGNORE INTO tax_year_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...columns.map((c) => row[c] ?? null))
    } catch {
      throw new BadRequestError('The archive holds an invalid tax year configuration')
    }
  }
}
