// The two addresses Studio is opened at, and the rule that keeps every other page off this server's
// API. Studio and Mastra's /api routes ask for no credential. CORS keeps the answer from a page of
// another origin, but the browser still sends that page's requests that need no preflight (a form,
// or a text/plain body), and Mastra reads a multipart form, or any content type that includes
// "application/json", as the request's body. So a request that can change something (any method
// but GET, HEAD and OPTIONS) is refused when it names an Origin that is not Studio's. A browser
// names the origin on every such request; one without an Origin is not from a page (the node's
// webhook, curl), and goes through.
//
// Mastra runs no middleware on routes declared public: /hdtp/webhook, whose signature is checked,
// and its own sign-in routes, which do nothing without an auth provider (this agent has none).

import type { MiddlewareHandler } from '@mastra/core/server'

export const STUDIO_ORIGINS = ['http://localhost:4111', 'http://127.0.0.1:4111']

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Refuses a write that a page of any origin but Studio's sent. */
export const studioWritesOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  if (READS.has(c.req.method) || origin === undefined || STUDIO_ORIGINS.includes(origin)) return next()
  return c.json({ code: 'origin_refused' }, 403)
}
