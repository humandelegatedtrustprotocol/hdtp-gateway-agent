// The process around the agent: the node client, the responder, the webhook receiver and the
// reconcile timer. Started once, by src/mastra/index.ts; nothing here runs on import.

import type { Agent } from '@mastra/core/agent'
import type { Config } from './config.ts'
import { consoleLog, type Log } from './log.ts'
import { connectNode, refusalCode } from './node.ts'
import { Responder } from './responder.ts'
import { createReceiver } from './webhook.ts'

export interface Runtime {
  receive: (req: Request) => Promise<Response>
}

export function startRuntime(config: Config, agent: Agent, log: Log = consoleLog): Runtime {
  let responder: Responder | null = null
  if (!config.ownerToken) {
    // Studio still runs, so the persona can be tried there before a node is connected.
    log.warn('owner_token_unset')
  } else {
    const { node } = connectNode(config.ownerMcpUrl, config.ownerToken)
    const draft = async (prompt: string) => (await agent.generate(prompt)).text
    const r = new Responder(node, draft, log)
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
  const receive = createReceiver({
    secret: () => config.webhookSecret,
    log,
    handlers: {
      message: (thread) => (responder ? responder.onMessage(thread) : idle()),
      reconcile: () => (responder ? responder.reconcile() : idle()),
      request: (request) => (responder ? responder.onRequest(request) : idle()),
    },
  })
  return { receive }
}
