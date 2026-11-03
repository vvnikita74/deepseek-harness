/** Browser launch-token and persistent-cookie behavior. */

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { ACCESS_KEY_KEY, RecordCredentials, SIGNING_SECRET_KEY } from './browser-credentials.ts'

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.records.get(SIGNING_SECRET_KEY)
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(store: RecordCredentials, maxAgeDays = 30): Promise<BrowserAuth> {
  return BrowserAuth.create(credentials(store), maxAgeDays)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
  }
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
  secure = false,
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, authority), res.value, secure)).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('API credentials', () => {
  it('refuses a request without a URL before publishing an API operator', async () => {
    const auth = await createAuth(new RecordCredentials())
    const publish = vi.fn(() => 'api-operator' as PeerId)
    const res = response()

    auth.authorizeConnect({ method: 'GET', headers: { host: 'localhost' } }, res.value, false, publish)

    expect(res.state).toEqual({
      status: 401,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('signs the published id and rejects browser confusion, tampering, audience mismatch, and expiry', async () => {
    vi.useFakeTimers()
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const authority = '127.0.0.1:3080'
    const id = 'api-operator' as PeerId
    const issuedAt = Date.now()
    const publish = vi.fn(() => id)
    const res = response()
    auth.authorizeConnect(request(auth.authenticatedUrl(`http://${authority}/connect`)), {
      ...res.value,
      writeHead(status, headers) {
        expect(publish).toHaveBeenCalledExactlyOnceWith('none')
        return res.value.writeHead(status, headers)
      },
    }, false, publish)
    const cookie = res.state.headers?.['set-cookie']?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('API connect did not set a cookie')
    const [name, value] = cookie.split('=') as [string, string]
    const payload = { version: 2, authority, id, issuedAt, expiresAt: issuedAt + 30 * 86_400_000 }
    expect(JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString('utf8'))).toEqual(payload)
    expect(auth.authenticateApi(request('/', authority, { cookie }))).toBe(id)
    expect(auth.isAuthenticated(request('/', authority, { cookie }))).toBe(false)
    expect(auth.authenticateApi(request('/', authority, { cookie: exchange(auth).cookie }))).toBeUndefined()
    expect(auth.isAuthenticated(request('/', authority, { cookie: cookie.replace('=v2.', '=v1.') }))).toBe(false)
    expect(auth.authenticateApi(request('/', authority, { cookie: `${cookie.slice(0, -1)}!` }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', 'localhost:3080', { cookie }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', '127.0.0.1:3081', { cookie }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', authority, { cookie }), true)).toBeUndefined()
    for (const invalid of [
      { ...payload, version: 3 },
      { ...payload, authority: 'localhost:3080' },
      { ...payload, id: '' },
      { ...payload, id: 42 },
      { ...payload, id: undefined },
      { ...payload, issuedAt: issuedAt + 1 },
      { ...payload, issuedAt: 0.5 },
      { ...payload, expiresAt: 'later' },
      { ...payload, expiresAt: issuedAt - 1 },
    ]) {
      const invalidCookie = signedCookie(store, name, invalid).replace('=v1.', '=v2.')
      expect(auth.authenticateApi(request('/', authority, { cookie: invalidCookie }))).toBeUndefined()
      expect(auth.isAuthenticated(request('/', authority, { cookie: invalidCookie }))).toBe(false)
    }
    const shorter = await createAuth(store, 1)
    expect(shorter.authenticateApi(request('/', authority, { cookie }))).toBeUndefined()
    vi.setSystemTime(payload.expiresAt)
    expect(auth.authenticateApi(request('/', authority, { cookie }))).toBeUndefined()
  })
})

describe('BrowserAuth', () => {
  it('mints one persistent access key and an authority-bound cookie', async () => {
    const store = new RecordCredentials()
    const first = await createAuth(store, 30)
    const login = exchange(first)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    expect(first.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(first.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(first.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(first.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(first.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)

    const reloaded = await createAuth(store, 30)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(restarted.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    const staleUrl = new URL(login.launchUrl)
    const redirected = response()
    expect(restarted.authorizeIndex(request(
      `${staleUrl.pathname}${staleUrl.search}`,
      '127.0.0.1:3080',
      { cookie: login.cookie },
    ), redirected.value)).toBe(false)
    // The persisted access key still matches, so the same URL mints a fresh cookie.
    expect(redirected.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(redirected.state.headers?.['set-cookie']).toContain('dsh-auth-')
  })

  it('keeps HTTPS port 443 distinct from HTTP port 80 with one signing secret', async () => {
    const auth = await createAuth(new RecordCredentials())
    const plain = exchange(auth, 'harness.example')
    const tls = exchange(auth, 'harness.example', true)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: plain.cookie }), true)).toBe(false)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }), true)).toBe(true)
    expect(auth.isAuthenticated(request('/', 'harness.example:443', { cookie: tls.cookie }), true)).toBe(true)
    expect(auth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }))).toBe(false)
  })

  it('rejects HTTP cookie replay after enabling TLS on the same authority', async () => {
    const store = new RecordCredentials()
    const authority = 'harness.example:3080'
    const plain = exchange(await createAuth(store), authority)
    const restarted = await createAuth(store)
    const denied = response()
    expect(restarted.authorizeIndex(request('/', authority, { cookie: plain.cookie }), denied.value, true)).toBe(false)
    expect(denied.state.status).toBe(401)

    const tls = exchange(restarted, authority, true)
    expect(tls.state.headers?.['set-cookie']).toContain('; Secure')
    expect(restarted.isAuthenticated(request('/', authority, { cookie: tls.cookie }), true)).toBe(true)
    expect(restarted.isAuthenticated(request('/', authority, { cookie: tls.cookie }))).toBe(false)
    const tlsName = tls.cookie.slice(0, tls.cookie.indexOf('='))
    const plainValue = plain.cookie.slice(plain.cookie.indexOf('=') + 1)
    expect(restarted.isAuthenticated(request('/', authority, { cookie: `${tlsName}=${plainValue}` }), true)).toBe(false)
  })

  it('preserves the caller authority and mount while adding only this process token', async () => {
    const auth = await createAuth(new RecordCredentials())
    const mounted = new URL(auth.authenticatedUrl('https://gateway.example/tools/dsh/'))
    expect(mounted.origin).toBe('https://gateway.example')
    expect(mounted.pathname).toBe('/tools/dsh/')
    expect([...mounted.searchParams.keys()]).toEqual(['token'])

    const loopback = new URL(auth.authenticatedUrl('http://127.0.0.1:3080/'))
    expect(loopback.origin).toBe('http://127.0.0.1:3080')
    expect(loopback.pathname).toBe('/')
    expect(loopback.searchParams.get('token')).toBe(mounted.searchParams.get('token'))

    // The proxy preserves the browser-facing Host and strips the mount.
    const token = mounted.searchParams.get('token')
    const exchanged = response()
    expect(auth.authorizeIndex(request(`/?token=${String(token)}`, 'gateway.example'), exchanged.value)).toBe(false)
    const setCookie = exchanged.state.headers?.['set-cookie']
    if (setCookie === undefined) throw new Error('mount exchange did not set a cookie')
    expect(auth.isAuthenticated(request(
      '/', 'gateway.example', { cookie: setCookie.split(';', 1)[0]! },
    ))).toBe(true)
  })

  it('accepts the cookie for index serving and gives every unauthenticated request one response', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = exchange(auth)
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })

  it('rejects tampering, expiry, future issuance, and a longer lifetime than configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: 42, issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: 'now', expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one signing secret and access key per activation and replaces each after its deletion', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = exchange(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })

    await store.deleteRecord(SIGNING_SECRET_KEY)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    const sameActivation = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })

    const reactivated = await createAuth(store)
    const second = exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 4 })
  })

  it('rotates the access key only when its own record is deleted', async () => {
    const store = new RecordCredentials()
    const key = new URL((await createAuth(store)).authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token')
    await store.deleteRecord(SIGNING_SECRET_KEY)
    expect(new URL((await createAuth(store)).authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token')).toBe(key)
    await store.deleteRecord(ACCESS_KEY_KEY)
    expect(new URL((await createAuth(store)).authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token')).not.toBe(key)
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.records.set(SIGNING_SECRET_KEY, { kind: 'api-key', key: 'not-a-cookie-secret' })
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.records.set(SIGNING_SECRET_KEY, { kind: 'grant', payload: { version: 1, secret: 'short' } })
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.records.set(SIGNING_SECRET_KEY, { kind: 'grant', payload: { version: 1, secret: 42 } })
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    const badAccessKey = new RecordCredentials()
    badAccessKey.records.set(ACCESS_KEY_KEY, { kind: 'grant', payload: { version: 1, secret: 'short' } })
    await expect(createAuth(badAccessKey)).rejects.toThrow(/access-key credential record has an invalid secret/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })
})

function accessKeyOf(auth: BrowserAuth): string {
  const key = new URL(auth.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token')
  if (key === null) throw new Error('authenticated URL carries no access key')
  return key
}

function exchangeBody(auth: BrowserAuth, body: unknown, publish = vi.fn(() => 'api-operator' as PeerId), authority = '127.0.0.1:3080') {
  const res = response()
  auth.exchangeAccessKey(request('/connect', authority, { method: 'POST' }), res.value, false, body, publish)
  return { state: res.state, publish }
}

function bearerRequest(value: string, authority = '127.0.0.1:3080'): ConnectionIndexRequest {
  return { headers: { host: authority, authorization: `Bearer ${value}` } }
}

function websocketRequest(protocol: string, authority = '127.0.0.1:3080', authorization?: string): ConnectionIndexRequest {
  return {
    method: 'GET',
    url: '/api/remote.mux',
    headers: { host: authority, 'sec-websocket-protocol': protocol, ...authorization === undefined ? {} : { authorization } },
  }
}

describe('JSON access-key exchange', () => {
  it('answers a valid key with a signed API credential and no cookie', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials())
    const key = accessKeyOf(auth)
    const { state, publish } = exchangeBody(auth, { token: key, interactions: 'answer' })
    expect(publish).toHaveBeenCalledExactlyOnceWith('answer')
    expect(state.status).toBe(200)
    expect(state.headers).toEqual({ 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
    expect(state.headers?.['set-cookie']).toBeUndefined()
    const body = JSON.parse(state.body ?? '') as { token: string; expiresAt: number }
    expect(body.expiresAt).toBe(Date.now() + 30 * 86_400_000)
    expect(auth.authenticateApi(bearerRequest(body.token))).toBe('api-operator')
    expect(auth.isAuthenticated(bearerRequest(body.token))).toBe(false)
  })

  it('defaults interactions to none and refuses wrong, missing, or non-string keys before publishing', async () => {
    const auth = await createAuth(new RecordCredentials())
    const ok = exchangeBody(auth, { token: accessKeyOf(auth) })
    expect(ok.publish).toHaveBeenCalledExactlyOnceWith('none')
    for (const body of [
      { token: 'wrong' },
      { token: accessKeyOf(auth).slice(0, -1) },
      { token: 42 },
      {},
    ]) {
      const refused = exchangeBody(auth, body)
      expect(refused.state, JSON.stringify(body)).toMatchObject({
        status: 401,
        headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
        body: '{"error":"unauthorized"}',
      })
      expect(refused.publish).not.toHaveBeenCalled()
    }
  })

  it('refuses malformed bodies and unknown interactions with 400 before publishing', async () => {
    const auth = await createAuth(new RecordCredentials())
    for (const body of [
      { token: accessKeyOf(auth), interactions: 'observe' },
      { token: accessKeyOf(auth), interactions: 1 },
      [],
      null,
      'not an object',
    ]) {
      const refused = exchangeBody(auth, body)
      expect(refused.state.status, JSON.stringify(body)).toBe(400)
      expect(refused.publish).not.toHaveBeenCalled()
    }
  })

  it('refuses an access key presented as a bearer credential or subprotocol credential', async () => {
    const auth = await createAuth(new RecordCredentials())
    const key = accessKeyOf(auth)
    expect(auth.authenticateApi(bearerRequest(key))).toBeUndefined()
    expect(auth.authenticateApi(websocketRequest(`dsh.v1, dsh.auth.${key}`), false, true)).toBeUndefined()
  })
})

describe('bearer and subprotocol API credentials', () => {
  it('accepts a signed API value in Authorization and refuses tampered, foreign, expired, browser, and stale values', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { state } = exchangeBody(auth, { token: accessKeyOf(auth) })
    const token = (JSON.parse(state.body ?? '') as { token: string }).token
    const expiresAt = (JSON.parse(state.body ?? '') as { expiresAt: number }).expiresAt
    expect(auth.authenticateApi(bearerRequest(token))).toBe('api-operator')
    expect(auth.authenticateApi(bearerRequest(token.toUpperCase()))).toBeUndefined()
    expect(auth.authenticateApi(bearerRequest(`${token.slice(0, -1)}!`))).toBeUndefined()
    expect(auth.authenticateApi(bearerRequest(token, 'localhost:3080'))).toBeUndefined()
    expect(auth.authenticateApi({ headers: { authorization: `Bearer ${token}` } })).toBeUndefined()

    const browser = exchange(auth)
    expect(auth.authenticateApi(bearerRequest(browser.cookie.slice(browser.cookie.indexOf('=') + 1)))).toBeUndefined()
    expect(auth.authenticateApi({ headers: { host: '127.0.0.1:3080', authorization: 'Basic abc' } })).toBeUndefined()

    vi.setSystemTime(expiresAt)
    expect(auth.authenticateApi(bearerRequest(token))).toBeUndefined()

    const other = await createAuth(new RecordCredentials())
    expect(other.authenticateApi(bearerRequest(token))).toBeUndefined()
  })

  it('reads a single dsh.auth subprotocol offer only for WebSocket admission', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { state } = exchangeBody(auth, { token: accessKeyOf(auth) })
    const token = (JSON.parse(state.body ?? '') as { token: string }).token
    expect(auth.authenticateApi(websocketRequest(`dsh.v1, dsh.auth.${token}`), false, true)).toBe('api-operator')
    expect(auth.authenticateApi(websocketRequest(`dsh.auth.${token}`), false, true)).toBe('api-operator')
    expect(auth.authenticateApi(websocketRequest(`dsh.v1, dsh.auth.${token}`, '127.0.0.1:3080', `Bearer ${token}`), false, true)).toBe('api-operator')
    // Plain HTTP never reads the subprotocol; WebSocket admission never reads Authorization.
    expect(auth.authenticateApi(websocketRequest(`dsh.v1, dsh.auth.${token}`))).toBeUndefined()
    expect(auth.authenticateApi(websocketRequest('dsh.v1', '127.0.0.1:3080', `Bearer ${token}`), false, true)).toBeUndefined()
    expect(auth.authenticateApi(websocketRequest(`dsh.auth.${token}, dsh.auth.${token}`), false, true)).toBeUndefined()
    expect(auth.authenticateApi(websocketRequest('dsh.v1, dsh.auth.tampered', '127.0.0.1:3080'), false, true)).toBeUndefined()
    expect(auth.authenticateApi(websocketRequest('dsh.v1'), false, true)).toBeUndefined()
  })

  it('prefers a valid signed cookie over a bearer value and falls back to the bearer when the cookie is invalid', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { state } = exchangeBody(auth, { token: accessKeyOf(auth) })
    const token = (JSON.parse(state.body ?? '') as { token: string }).token
    const cookieId = 'cookie-operator' as PeerId
    const cookieRes = response()
    auth.authorizeConnect(request(auth.authenticatedUrl('http://127.0.0.1:3080/connect')), cookieRes.value, false, () => cookieId)
    const cookie = cookieRes.state.headers?.['set-cookie']?.split(';', 1)[0] ?? ''
    expect(auth.authenticateApi({ headers: { host: '127.0.0.1:3080', cookie, authorization: `Bearer ${token}` } })).toBe(cookieId)
    expect(auth.authenticateApi({ headers: { host: '127.0.0.1:3080', cookie: `${cookie.slice(0, cookie.indexOf('='))}=broken`, authorization: `Bearer ${token}` } })).toBe('api-operator')
  })
})
