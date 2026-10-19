// The process around the agent: the node client, the responder, the webhook receiver, the
// wait_for_updates loops and the reconcile timer. Started once, by src/mastra/index.ts; nothing
// here runs on import.
//
// The route reaches the receiver through receive() rather than holding it: the Mastra CLI
// (`mastra dev`, `mastra build`) bundles the entry file's `server` option, and whatever it
// references, into a module of its own and imports it in the CLI's process. A route holding the
// runtime would start a second one there, with its own sweep, its own loops and its own drafts.
//
// Each sweep hands the accounts it listed to the watcher, which keeps one loop per account. Until a
// sweep has listed them, a failed sweep is tried again after the watcher's backoff rather than at
// the next interval, so the loops, and the agent's presence on the node, start as soon as the node
// answers.
//
// Before the first sweep reads anything, the node's tool list is held to every tool the agent calls
// (TOOLS_CALLED). A node that does not offer one, or offers one the MCP client skipped, is refused at
// start: tools_missing names them, with the reason for each one skipped, and the agent stays idle.

import type { Agent } from '@mastra/core/agent'
import type { Config } from './config.ts'
import { consoleLog, type Fields, type Log } from './log.ts'
import { FirstStartUnreadable, firstStart } from './first-start.ts'
import { TOOLS_CALLED, connectNode, refusalCode, type NodeClient } from './node.ts'
import { Responder } from './responder.ts'
import { Watcher, backoff } from './watch.ts'
import { createReceiver } from './webhook.ts'

let receiver: ((req: Request) => Promise<Response>) | null = null

/** The tools this agent calls that the node does not offer, and why each skipped one was skipped. */
export async function missingTools(node: NodeClient): Promise<{ tools: string[]; skipped: string[] }> {
  const { offered, skipped } = await node.listTools()
  const tools = TOOLS_CALLED.filter((t) => !offered.includes(t))
  return { tools, skipped: tools.filter((t) => skipped[t]).map((t) => `${t}:${skipped[t]}`) }
}

/** POST /hdtp/webhook: the started runtime's receiver, or 503 in a process that has not started one. */
export function receive(req: Request): Promise<Response> {
  return receiver ? receiver(req) : Promise.resolve(Response.json({ code: 'not_started' }, { status: 503 }))
}

/** Starts the runtime once; the function returned stops its loops and its timers. */
export function startRuntime(config: Config, agent: Agent, log: Log = consoleLog): () => void {
  if (receiver) return () => {}
  let responder: Responder | null = null
  let stop = () => {}
  const now = () => Math.floor(Date.now() / 1000)
  // Why nothing is answered, when nothing is. Studio still runs either way, so the persona can be
  // tried there.
  let idleWhy = 'owner_token_unset'
  const token = config.ownerToken
  let since: number | null = null
  if (token) {
    try {
      since = firstStart(config.dataDir, now())
      log.info('first_start', { first_start: since })
    } catch (e) {
      // A file that is there and is not a first-start time is not taken for none: answering the
      // backlog is what the file is for. The owner fixes or deletes it, and restarts.
      idleWhy = e instanceof FirstStartUnreadable ? 'first_start_unreadable' : 'first_start_unwritable'
    }
  }
  if (!token || since === null) {
    log.warn(idleWhy)
  } else {
    const { node } = connectNode(config.ownerMcpUrl, token)
    const draft = async (prompt: string) => (await agent.generate(prompt)).text
    const r = new Responder(node, draft, log, {
      answer: config.answer,
      turnCap: config.agentTurnCap,
      repliesPerHour: config.repliesPerHour,
      firstStart: since,
      now,
    })
    const watcher = new Watcher(node, (accountId) => r.reconcileAccount(accountId), log)
    let sweeping = false
    let failures = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    idleWhy = 'tools_unchecked'
    const sweep = async () => {
      if (sweeping) return
      sweeping = true
      try {
        if (!responder) {
          const missing = await missingTools(node)
          if (missing.tools.length > 0) {
            idleWhy = 'tools_missing'
            const fields: Fields = { tools: missing.tools.join(',') }
            if (missing.skipped.length > 0) fields.skipped = missing.skipped.join(',')
            log.warn('tools_missing', fields)
            stop()
            return
          }
          responder = r
        }
        await r.reconcile((accounts) => watcher.sync(accounts))
        failures = 0
      } catch (e) {
        log.warn('reconcile_failed', { reason: refusalCode(e) })
        if (!watcher.watching) retry = setTimeout(() => void sweep(), backoff(++failures)).unref()
      } finally {
        sweeping = false
      }
    }
    void sweep()
    const timer = setInterval(() => void sweep(), config.reconcileSeconds * 1000).unref()
    stop = () => {
      clearInterval(timer)
      clearTimeout(retry)
      watcher.stop()
    }
  }
  const idle = async () => log.warn(idleWhy)
  receiver = createReceiver({
    secret: () => config.webhookSecret,
    log,
    handlers: {
      message: (thread) => (responder ? responder.onMessage(thread) : idle()),
      reconcile: () => (responder ? responder.reconcile() : idle()),
      request: (request) => (responder ? responder.onRequest(request) : idle()),
    },
  })
  return stop
}
