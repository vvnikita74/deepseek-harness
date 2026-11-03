/**
 * CORS for the shared carrier routes (`/api`, `/connect`, RPC channels) when a
 * request's Origin is an exact `allowedOrigins` entry. Credentials travel as
 * bearer values in `Authorization`, never as cookies, so responses carry no
 * `Access-Control-Allow-Credentials` and never the `*` wildcard.
 */

/** Response surface the CORS helpers write to; node:http ServerResponse satisfies it. */
export interface CorsResponse {
  setHeader(name: string, value: string): unknown
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(): unknown
}

/**
 * Set the Origin echo on a response that an allowed Origin receives. Headers
 * set here merge into the status and headers the route writes later.
 * @param response - response owned by the route until it ends.
 * @param origin - the allowed Origin, verbatim.
 */
export function setCorsHeaders(response: CorsResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'Origin')
}

/**
 * Answer an allowed Origin's preflight without authentication; the caller has
 * already passed the Host fence.
 * @param response - response owned until it ends.
 */
export function answerPreflight(response: CorsResponse): void {
  response.writeHead(204, {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  })
  response.end()
}
