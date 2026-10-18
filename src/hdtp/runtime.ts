// The process around the agent: the node client, the responder, the webhook receiver and the
// reconcile timer. Started once, by src/mastra/index.ts; nothing here runs on import.
//
// The route reaches the receiver through receive() rather than holding it: the Mastra CLI
// (`mastra dev`, `mastra build`) bundles the entry file's `server` option, and whatever it
// references, into a module of its own and imports it in the CLI's process. A route holding the
// runtime would start a second one there, with its own sweep and its own drafts.

import type { Agent } from '@mastra/core/agent'
import type { Config } from './config.ts'
import { consoleLog, type Log } from './log.ts'
import { connectNode, refusalCode } from './node.ts'
import { Responder } from './responder.ts'
import { createReceiver } from './webhook.ts'

let receiver: ((req: Request) => Promise<Response>) | null = null

/** POST /hdtp/webhook: the started runtime's receiver, or 503 in a process that has not started one. */
export function receive(req: Request): Promise<Response> {
  return receiver ? receiver(req) : Promise.resolve(Response.json({ error: 'not_started' }, { status: 503 }))
}

export function startRuntime(config: Config, agent: Agent, log: Log = consoleLog): void {
  if (receiver) return
  let responder: Responder | null = null
  if (!config.ownerToken) {
    // Studio still runs, so the persona can be tried there before a node is connected.
    log.warn('owner_token_unset')
  } else {
    const { node } = connectNode(config.ownerMcpUrl, config.ownerToken)
    const draft = async (prompt: string) => (await agent.generate(prompt)).text
    const r = new Responder(node, draft, log, config.agentTurnCap)
    responder = r
    let sweeping = false
    const sweep = async () => {
      if (sweeping) return
      sweeping = true
      try {
        await r.reconcile()
      } catch (e) {
        log.warn('reconcile_failed', { reason: refusalCode(e) })
      } finally {
        sweeping = false
      }
    }
    void sweep()
    setInterval(() => void sweep(), config.reconcileSeconds * 1000).unref()
  }
  const idle = async () => log.warn('owner_token_unset')
  receiver = createReceiver({
    secret: () => config.webhookSecret,
    log,
    handlers: {
      message: (thread) => (responder ? responder.onMessage(thread) : idle()),
      reconcile: () => (responder ? responder.reconcile() : idle()),
      request: (request) => (responder ? responder.onRequest(request) : idle()),
    },
  })
}
