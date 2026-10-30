import { afterEach, describe, expect, it } from 'vitest'
import { build, Client, type Harness } from './test-harness.ts'

let current: Harness | undefined

afterEach(async () => {
  await current?.dispose()
  current = undefined
})

async function signedIn(options: Parameters<typeof build>[0]) {
  const { h } = await build(options)
  current = h
  const client = new Client(h.app)
  await client.login()
  return { h, client }
}

const sources = (res: { json(): unknown }) =>
  Object.fromEntries(
    (res.json() as { apiKeys: Array<{ name: string; source: string }> }).apiKeys.map((k) => [
      k.name,
      k.source,
    ]),
  )

describe('API keys entered through the UI', () => {
  it('stores a key encrypted, reports only where it comes from, and removes it', async () => {
    const { h, client } = await signedIn({ slots: true })
    expect(sources(await client.request('GET', '/api/settings'))).toEqual({
      TIINGO_API_KEY: 'unset',
      ALPHA_VANTAGE_API_KEY: 'unset',
    })

    const put = await client.request('PUT', '/api/settings/api-keys/TIINGO_API_KEY', {
      value: '  tiingo-secret-value  ',
    })
    expect(put.statusCode).toBe(204)

    const listing = await client.request('GET', '/api/settings')
    expect(sources(listing).TIINGO_API_KEY).toBe('stored')
    expect(listing.body).not.toContain('tiingo-secret-value')
    expect(h.app.apiKeys.get('TIINGO_API_KEY')).toBe('tiingo-secret-value')

    const raw = h.db.prepare('SELECT value FROM app_secret').get() as { value: string }
    expect(raw.value.startsWith('v1.')).toBe(true)
    expect(raw.value).not.toContain('tiingo-secret-value')

    const del = await client.request('DELETE', '/api/settings/api-keys/TIINGO_API_KEY')
    expect(del.statusCode).toBe(204)
    expect(h.app.apiKeys.get('TIINGO_API_KEY')).toBeUndefined()
  })

  it('replaces a stored key', async () => {
    const { h, client } = await signedIn({ slots: true })
    await client.request('PUT', '/api/settings/api-keys/ALPHA_VANTAGE_API_KEY', { value: 'first' })
    await client.request('PUT', '/api/settings/api-keys/ALPHA_VANTAGE_API_KEY', { value: 'second' })
    expect(h.app.apiKeys.get('ALPHA_VANTAGE_API_KEY')).toBe('second')
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM app_secret').get() as { n: number }).n).toBe(1)
  })

  it('keeps a key from the environment read-only and in charge', async () => {
    const { h, client } = await signedIn({
      slots: true,
      apiKeysFromEnv: { TIINGO_API_KEY: 'from-the-environment' },
    })
    expect(sources(await client.request('GET', '/api/settings')).TIINGO_API_KEY).toBe('env')

    const put = await client.request('PUT', '/api/settings/api-keys/TIINGO_API_KEY', {
      value: 'typed-in-ui',
    })
    expect(put.statusCode).toBe(409)
    const del = await client.request('DELETE', '/api/settings/api-keys/TIINGO_API_KEY')
    expect(del.statusCode).toBe(409)
    expect(h.app.apiKeys.get('TIINGO_API_KEY')).toBe('from-the-environment')
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM app_secret').get() as { n: number }).n).toBe(0)
  })

  it('lets the environment override a key stored earlier', async () => {
    const { h } = await signedIn({
      slots: true,
      apiKeysFromEnv: { TIINGO_API_KEY: 'env-wins' },
    })
    h.app.appSecrets.set(1, 'TIINGO_API_KEY', 'stored-earlier')
    expect(h.app.apiKeys.get('TIINGO_API_KEY')).toBe('env-wins')
    expect(h.app.apiKeys.source('TIINGO_API_KEY')).toBe('env')
  })

  it('leaves every key read-only in env-supplied mode', async () => {
    const { h, client } = await signedIn({
      slots: true,
      configMode: 'env-supplied',
      apiKeysFromEnv: { TIINGO_API_KEY: 'from-the-environment' },
    })
    const listing = (await client.request('GET', '/api/settings')).json() as {
      configMode: string
      apiKeys: Array<{ name: string; editable: boolean }>
    }
    expect(listing.configMode).toBe('env-supplied')
    expect(listing.apiKeys.every((k) => !k.editable)).toBe(true)

    const put = await client.request('PUT', '/api/settings/api-keys/ALPHA_VANTAGE_API_KEY', {
      value: 'typed-in-ui',
    })
    expect(put.statusCode).toBe(409)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM app_secret').get() as { n: number }).n).toBe(0)
  })

  it('marks only the keys that can be changed as editable in self-configured mode', async () => {
    const { client } = await signedIn({
      slots: true,
      apiKeysFromEnv: { TIINGO_API_KEY: 'from-the-environment' },
    })
    const listing = (await client.request('GET', '/api/settings')).json() as {
      apiKeys: Array<{ name: string; editable: boolean }>
    }
    expect(Object.fromEntries(listing.apiKeys.map((k) => [k.name, k.editable]))).toEqual({
      TIINGO_API_KEY: false,
      ALPHA_VANTAGE_API_KEY: true,
    })
  })

  it('rejects a change that carries no CSRF token', async () => {
    const { h, client } = await signedIn({ slots: true })
    const res = await client.requestWithoutCsrf('PUT', '/api/settings/api-keys/TIINGO_API_KEY', {
      value: 'no-token',
    })
    expect(res.statusCode).toBe(403)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM app_secret').get() as { n: number }).n).toBe(0)
  })

  it('refuses to store a key in a database that is not encrypted yet', async () => {
    const { h, client } = await signedIn({ slots: false })
    const res = await client.request('PUT', '/api/settings/api-keys/TIINGO_API_KEY', {
      value: 'would-be-plaintext',
    })
    expect(res.statusCode).toBe(409)
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM app_secret').get() as { n: number }).n).toBe(0)
  })

  it('rejects an unknown name and an empty value', async () => {
    const { client } = await signedIn({ slots: true })
    expect(
      (await client.request('PUT', '/api/settings/api-keys/SESSION_SECRET', { value: 'x' }))
        .statusCode,
    ).toBe(400)
    expect(
      (await client.request('PUT', '/api/settings/api-keys/TIINGO_API_KEY', { value: '   ' }))
        .statusCode,
    ).toBe(400)
  })

  it('needs a signed-in session and an unlocked database', async () => {
    const { h } = await signedIn({ slots: true })
    const anonymous = new Client(h.app)
    expect((await anonymous.request('GET', '/api/settings')).statusCode).toBe(401)

    h.keyring.lock()
    expect((await anonymous.request('GET', '/api/settings')).statusCode).toBe(423)
  })

  it('treats a stored key as absent while locked', async () => {
    const { h, client } = await signedIn({ slots: true })
    await client.request('PUT', '/api/settings/api-keys/TIINGO_API_KEY', { value: 'stored' })
    h.keyring.lock()
    expect(h.app.apiKeys.get('TIINGO_API_KEY')).toBeUndefined()
  })
})
