/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { CONNECT_PATH, type ConnectionInteractions } from './connect-protocol.ts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const ACCESS_KEY_RECORD_KEY = credentialKey('client-connection', 'access-key')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const SUBPROTOCOL_CREDENTIAL_PREFIX = 'dsh.auth.'
const BEARER_PATTERN = /^bearer\s+(\S+)$/iu

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

interface ApiCookiePayload extends Omit<BrowserCookiePayload, 'version'> {
  readonly version: 2
  readonly id: PeerId
}

type CookiePayload = BrowserCookiePayload | ApiCookiePayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Protocol-scoped cookie audience; HTTP retains its existing authority-only spelling. */
function requestAudience(headers: ConnectionTrustRequest['headers'], secure: boolean): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined, label: string): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error(`client-connection: ${label} credential record has an unsupported format`)
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error(`client-connection: ${label} credential record has an invalid secret`)
  }
  return secret
}

/** Bearer credential of an `Authorization: Bearer <value>` header, if present. */
function bearerCredential(headers: ConnectionTrustRequest['headers']): string | undefined {
  return BEARER_PATTERN.exec(header(headers, 'authorization') ?? '')?.[1]
}

/** Credential named by a single `dsh.auth.<value>` WebSocket subprotocol offer; ambiguous offers name none. */
function subprotocolCredential(headers: ConnectionTrustRequest['headers']): string | undefined {
  const offers = (header(headers, 'sec-websocket-protocol') ?? '').split(',').map(offer => offer.trim())
    .filter(offer => offer.startsWith(SUBPROTOCOL_CREDENTIAL_PREFIX))
  const [offer] = offers
  return offers.length === 1 && offer !== undefined ? offer.slice(SUBPROTOCOL_CREDENTIAL_PREFIX.length) : undefined
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
  return secure ? `${attributes}; Secure` : attributes
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v${payload.version}.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): CookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || (version !== 'v1' && version !== 'v2') || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || (decoded.version !== COOKIE_PAYLOAD_VERSION && decoded.version !== 2)
    || version !== `v${decoded.version}`
    || typeof decoded.authority !== 'string'
    || typeof decoded.issuedAt !== 'number' || !Number.isSafeInteger(decoded.issuedAt)
    || typeof decoded.expiresAt !== 'number' || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  const payload = { authority: decoded.authority, issuedAt: decoded.issuedAt, expiresAt: decoded.expiresAt }
  if (decoded.version === COOKIE_PAYLOAD_VERSION) return { version: COOKIE_PAYLOAD_VERSION, ...payload }
  if (typeof decoded.id !== 'string' || decoded.id.length === 0) return undefined
  return { version: 2, ...payload, id: decoded.id as PeerId }
}

/** Create a random 32-byte grant under `key` on first use; later activations reuse it. */
async function initializeSecret(credentials: CredentialProvider, key: CredentialKey, label: string): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(key, (current) => {
    if (current !== undefined) {
      storedSecret(current, label)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record, label)
  if (secret === undefined) {
    throw new Error(`client-connection: ${label} credential record was not created`)
  }
  return secret
}

/**
 * Access-key exchange and persistent signed-credential verification. Connection
 * loads the credential provider's signing secret and access key during
 * activation and retains them for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly accessKey: string
  private readonly maxAgeMilliseconds: number

  private constructor(
    private readonly secret: Buffer,
    accessKey: Buffer,
    maxAgeDays: number,
  ) {
    this.accessKey = encodeBase64Url(accessKey)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication. Creates the signing secret and the
   * access key on first use; deleting either credential rotates it on the next
   * activation.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner with the persisted access key.
   */
  static async create(
    credentials: CredentialProvider,
    maxAgeDays: number,
  ): Promise<BrowserAuth> {
    const secret = await initializeSecret(credentials, AUTH_RECORD_KEY, 'browser-session')
    const accessKey = await initializeSecret(credentials, ACCESS_KEY_RECORD_KEY, 'access-key')
    return new BrowserAuth(secret, accessKey, maxAgeDays)
  }

  /**
   * Add the persistent access key to the caller's application URL.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the access key as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.searchParams.set(TOKEN_QUERY, this.accessKey)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root query token mints the cookie
   * and redirects to the directory-relative clean `./`; a valid cookie lets
   * the caller serve the index; every other request receives the same minimal
   * 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @param secure - whether the listener receiving this request serves TLS; the
   * minted cookie carries `Secure` when it does. Only that listener's own
   * protocol decides, never a `publicUrl` announcement or a forwarded header:
   * those describe a hop this process does not terminate.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse, secure = false): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAudience(req.headers, secure)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.accessKey)) {
        const issuedAt = Date.now()
        const expiresAt = issuedAt + this.maxAgeMilliseconds
        const value = encodeCookie({
          version: COOKIE_PAYLOAD_VERSION,
          authority,
          issuedAt,
          expiresAt,
        }, this.secret)
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': './',
          'referrer-policy': 'no-referrer',
          'set-cookie': sessionCookie(
            cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000), secure,
          ),
        })
        res.end()
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req, secure)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': './',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req, secure)) return true
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Exchange the launch token for an independent API operator; omitted interactions default to none.
   * @param req - trusted GET request on /connect with at most one interactions declaration.
   * @param res - response owned to completion, redirecting to the API mux on success.
   * @param secure - whether the receiving listener serves TLS.
   * @param publish - synchronously create the operator before exposing its signed credential.
   */
  authorizeConnect(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure: boolean,
    publish: (interactions: ConnectionInteractions) => PeerId,
  ): void {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const declarations = url.searchParams.getAll('interactions')
    const interactions = declarations[0] ?? 'none'
    if (declarations.length > 1 || (interactions !== 'answer' && interactions !== 'none')) {
      res.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end('interactions must be declared once as answer or none\n')
      return
    }
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    const authority = requestAudience(req.headers, secure)
    if (req.method !== 'GET' || url.pathname !== CONNECT_PATH || tokens.length !== 1
      || authority === undefined || !tokenMatches(tokens.join(''), this.accessKey)) {
      this.writeUnauthorized(req, res)
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const id = publish(interactions)
    const value = encodeCookie({ version: 2, authority, id, issuedAt, expiresAt }, this.secret)
    res.writeHead(302, {
      'cache-control': 'no-store',
      'location': './api/remote.mux',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000), secure,
      ),
    })
    res.end()
  }

  /**
   * Exchange the access key in a JSON `POST /connect` body for a signed API
   * credential returned in the response body. No cookie is set: the caller
   * sends the value back as a bearer token or subprotocol credential.
   * @param request - trusted POST /connect request; its Host audience binds the credential.
   * @param response - response owned to completion.
   * @param secure - whether the receiving listener serves TLS.
   * @param body - JSON-decoded body `{ token, interactions? }`, where interactions defaults to none.
   * @param publish - synchronously create the operator before exposing its signed credential.
   */
  exchangeAccessKey(
    request: ConnectionIndexRequest,
    response: ConnectionIndexResponse,
    secure: boolean,
    body: unknown,
    publish: (interactions: ConnectionInteractions) => PeerId,
  ): void {
    const json = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }
    if (!isRecord(body) || (body.interactions !== undefined && body.interactions !== 'answer' && body.interactions !== 'none')) {
      response.writeHead(400, json)
      response.end(JSON.stringify({ error: 'interactions must be answer or none' }))
      return
    }
    const authority = requestAudience(request.headers, secure)
    if (typeof body.token !== 'string' || authority === undefined || !tokenMatches(body.token, this.accessKey)) {
      response.writeHead(401, json)
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const id = publish(body.interactions === 'answer' ? 'answer' : 'none')
    const value = encodeCookie({ version: 2, authority, id, issuedAt, expiresAt }, this.secret)
    response.writeHead(200, json)
    response.end(JSON.stringify({ token: value, expiresAt }))
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest, secure = false): boolean {
    return this.authenticate(request, secure, undefined)?.version === COOKIE_PAYLOAD_VERSION
  }

  /**
   * Verify an API credential without creating or reviving its operator. The
   * signed cookie is checked first; otherwise a bearer value is checked: the
   * `Authorization: Bearer` header for HTTP, or the `dsh.auth.<value>`
   * subprotocol offer for a WebSocket upgrade.
   * @param request - request headers carrying Host and Cookie, Authorization, or Sec-WebSocket-Protocol.
   * @param secure - whether the receiving listener uses TLS.
   * @param websocket - true when admitting a WebSocket upgrade, which reads the subprotocol credential only.
   * @returns the signed operator id, or undefined for invalid, expired, or browser credentials.
   */
  authenticateApi(request: ConnectionTrustRequest, secure = false, websocket = false): PeerId | undefined {
    const payload = this.authenticate(request, secure, websocket
      ? subprotocolCredential(request.headers)
      : bearerCredential(request.headers))
    return payload?.version === 2 ? payload.id : undefined
  }

  /**
   * Verify a signed cookie first, then the supplied bearer candidate. Bearer
   * candidates pass the same decode, HMAC, audience, and lifetime checks; the
   * caller accepts only the version it expects.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS.
   * @param bearer - unverified candidate value, or undefined when the carrier offers none.
   * @returns the verified payload, or undefined.
   */
  private authenticate(request: ConnectionTrustRequest, secure: boolean, bearer: string | undefined): CookiePayload | undefined {
    const authority = requestAudience(request.headers, secure)
    if (authority === undefined) return undefined
    const rawCookie = header(request.headers, 'cookie')
    const value = rawCookie === undefined ? undefined : cookieValue(rawCookie, cookieName(authority))
    const fromCookie = value === undefined ? undefined : this.verify(value, authority)
    if (fromCookie !== undefined || bearer === undefined) return fromCookie
    return this.verify(bearer, authority)
  }

  private verify(value: string, authority: string): CookiePayload | undefined {
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    const now = Date.now()
    if (payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt
      || payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds) return undefined
    return payload
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}
