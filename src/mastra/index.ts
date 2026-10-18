// The Mastra project: the delegate agent, and the node's webhook on Mastra's own server.
// `mastra dev` serves it with Studio at http://localhost:4111.

import './telemetry.ts'
import { Mastra } from '@mastra/core'
import { registerApiRoute } from '@mastra/core/server'
import { readConfig } from '../hdtp/config.ts'
import { startRuntime } from '../hdtp/runtime.ts'
import { delegate } from './agents/delegate.ts'

const runtime = startRuntime(readConfig(), delegate)

export const mastra = new Mastra({
  agents: { delegate },
  server: {
    apiRoutes: [
      registerApiRoute('/hdtp/webhook', {
        method: 'POST',
        requiresAuth: false,
        handler: (c) => runtime.receive(c.req.raw),
      }),
    ],
  },
})
