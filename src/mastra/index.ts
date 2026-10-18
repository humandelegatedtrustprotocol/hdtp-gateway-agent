// The Mastra project: the delegate agent, and the node's webhook on Mastra's own server.
// `mastra dev` serves it on the loopback interface only, whatever MASTRA_HOST says: Studio and
// Mastra's /api routes ask for no credential, so they are not offered to the network. Studio
// opens at http://localhost:4111 or http://127.0.0.1:4111; MASTRA_AUTO_DETECT_URL=true, set by
// the npm scripts and the Makefile, has it call its API at the address it was opened at.

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
    host: '127.0.0.1',
    apiRoutes: [
      registerApiRoute('/hdtp/webhook', {
        method: 'POST',
        requiresAuth: false,
        handler: (c) => receive(c.req.raw),
      }),
    ],
  },
})
