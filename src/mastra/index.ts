// The Mastra project: the delegate agent, and the node's webhook on Mastra's own server.
// `mastra dev` serves it with Studio at http://127.0.0.1:4111, on the loopback interface unless
// MASTRA_HOST says otherwise: Studio and Mastra's /api routes ask for no credential, so they are
// not offered to the network by default.
// Studio calls its API at the address it was served for, so it is opened at that one: a page
// opened at http://localhost:4111 fails to reach http://127.0.0.1:4111/api.

import './telemetry.ts'
import { Mastra } from '@mastra/core'
import { registerApiRoute } from '@mastra/core/server'
import { readConfig } from '../hdtp/config.ts'
import { receive, startRuntime } from '../hdtp/runtime.ts'
import { delegate } from './agents/delegate.ts'

// A statement, not a binding the `server` option refers to: see src/hdtp/runtime.ts.
startRuntime(readConfig(), delegate)

export const mastra = new Mastra({
  agents: { delegate },
  server: {
    host: readConfig().host,
    apiRoutes: [
      registerApiRoute('/hdtp/webhook', {
        method: 'POST',
        requiresAuth: false,
        handler: (c) => receive(c.req.raw),
      }),
    ],
  },
})
