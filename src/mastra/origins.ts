// The two addresses Studio is opened at, on the port this server binds, and the three rules that
// keep every other caller off this server. Studio and Mastra's /api routes ask for no credential.
//
// The peer. Bound beyond the loopback interface (MASTRA_HOST=0.0.0.0, as in the image), the server
// takes connections from other hosts: in a compose project, from every container on its network.
// A request whose socket peer is not on the loopback interface is refused, whatever it names, so
// from elsewhere only the public routes below answer. Studio and the API stay open to a caller on
// the agent's own host or in its own container (`docker exec`).
//
// The host. A page whose own name its DNS later points at 127.0.0.1 (DNS rebinding) is of the same
// origin as this server, so neither CORS nor the origin rule below keeps the answers from it: the
// persona's instructions, for one. Its requests still name its own host in the Host header, so a
// request of any method, reads included, is refused when its Host is not one of Studio's two
// addresses. A WebSocket upgrade is refused too.
//
// The origin. CORS keeps the answer from a page of another origin, but the browser still sends
// that page's requests that need no preflight (a form, or a text/plain body), and Mastra reads a
// multipart form, or any content type that includes "application/json", as the request's body. So
// a request that can change something (any method but GET, HEAD and OPTIONS) is refused when it
// names an Origin that is not Studio's. A browser names the origin on every such request; one
// without an Origin is not from a page (the node's webhook, curl), and goes through.
//
// Mastra runs no middleware on routes declared public (it wraps every middleware so), so none of
// the three rules reaches them:
// - /hdtp/webhook, whose signature is checked, so the node may name any host (http://agent:4111
//   inside a compose project, say);
// - Mastra's eight public auth routes, which do nothing without an auth provider (this agent has
//   none). Measured on Mastra 1.78.0:
//   - POST /api/auth/credentials/sign-in and /sign-up: 400 to a malformed body, otherwise 404
//     "Credentials authentication not configured";
//   - POST /api/auth/logout: 404 "Logout not configured";
//   - POST /api/auth/refresh: 404 "Session refresh not configured";
//   - GET /api/auth/capabilities: 200 {"enabled":false,"login":null};
//   - GET /api/auth/me: 200 null;
//   - GET /api/auth/sso/login: 404 "SSO not configured";
//   - GET /api/auth/sso/callback: 400 without a code, otherwise 302 to the request's own host with
//     ?error=sso_not_configured;
// - under `mastra dev`, Studio's /refresh-events and /__hot-reload-status, which answer a
//   "connected" event and the hot-reload flag, nothing of the agent's.

import type { MiddlewareHandler } from '@mastra/core/server'

/**
 * Studio's two addresses, as a Host header names them, on the port the served process binds. That
 * is Mastra's own rule with no `server.port` set, as here: PORT, else 4111. `mastra dev`, given no
 * PORT, picks the first free port from 4111 to 4131 and hands it to the served process as PORT.
 */
export function studioHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const port = Number(env.PORT) || 4111
  return [`localhost:${port}`, `127.0.0.1:${port}`]
}

/** The address the server binds: MASTRA_HOST when it names one, else the loopback interface. */
export function bindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.MASTRA_HOST?.trim() || '127.0.0.1'
}

/** Studio's two origins: the same two addresses. */
export function studioOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return studioHosts(env).map((host) => `http://${host}`)
}

export const STUDIO_HOSTS = studioHosts()
export const STUDIO_ORIGINS = studioOrigins()

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Whether a socket's peer address is the loopback interface's, as IPv4, IPv6 or IPv4 in IPv6. */
export function loopbackPeer(address: string | undefined): boolean {
  return address !== undefined && (address === '::1' || /^(::ffff:)?127\./i.test(address))
}

/**
 * Refuses a request, of any method, whose socket peer is not on the loopback interface. The peer
 * is the address the connection came from, which a request cannot name, as it names its Host. A
 * request with no socket to read (not from Mastra's Node server) is refused too.
 */
export const loopbackPeersOnly: MiddlewareHandler = async (c, next) => {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  if (loopbackPeer(env?.incoming?.socket?.remoteAddress)) return next()
  return c.json({ code: 'peer_refused' }, 403)
}

/** Refuses a request, of any method, whose Host is not one of Studio's two addresses. */
export const studioHostsOnly: MiddlewareHandler = async (c, next) => {
  if (STUDIO_HOSTS.includes((c.req.header('host') ?? '').toLowerCase())) return next()
  return c.json({ code: 'host_refused' }, 403)
}

/** Refuses a write that a page of any origin but Studio's sent. */
export const studioWritesOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  if (READS.has(c.req.method) || origin === undefined || STUDIO_ORIGINS.includes(origin)) return next()
  return c.json({ code: 'origin_refused' }, 403)
}
