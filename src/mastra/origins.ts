// The two addresses Studio is opened at, and the two rules that keep every other page off this
// server. Studio and Mastra's /api routes ask for no credential.
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
// Mastra runs no middleware on routes declared public, so neither rule reaches them:
// - /hdtp/webhook, whose signature is checked, so the node may name any host (http://agent:4111
//   inside a compose project, say);
// - Mastra's sign-in routes, which do nothing without an auth provider (this agent has none);
// - under `mastra dev`, Studio's /refresh-events and /__hot-reload-status, which answer a
//   "connected" event and the hot-reload flag, nothing of the agent's.

import type { MiddlewareHandler } from '@mastra/core/server'

/**
 * The port the server listens on, read as Mastra's createNodeServer reads it: `server.port` (this
 * project sets none), else PORT, else 4111. `mastra dev` sets PORT, for the process it serves, to
 * the port it chose: 4111 when that is free.
 */
export const STUDIO_PORT = Number(process.env.PORT) || 4111

/** Studio's two addresses, as a Host header names them. */
export const STUDIO_HOSTS = [`localhost:${STUDIO_PORT}`, `127.0.0.1:${STUDIO_PORT}`]

/** Studio's two origins: the same two addresses. */
export const STUDIO_ORIGINS = STUDIO_HOSTS.map((host) => `http://${host}`)

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

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
