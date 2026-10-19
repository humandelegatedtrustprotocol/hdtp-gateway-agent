// The wait_for_updates loop: one per account, held for as long as the runtime runs.
//
// The node counts the owner's agent as attached while its last owner-MCP request is under a
// minute old (hdtp-gateway internal/services/presence, Window), and a contact's call to an
// agent-answered capability finds no agent outside that minute and falls back at once
// (`no_agent`). The node holds each wait_for_updates call for at most 25 s (ownermcp WaitMaxSec),
// so a loop of them keeps the agent attached however long the sweep's interval is.
//
// The first answer, an answer that is news (not timed_out) naming a thread or a waiting request,
// and one that says the cursor expired each start one pass over the account
// (Responder.reconcileAccount): the answer carries neither a thread's contact status nor a
// request's id, and the pass reads both. The pass runs beside the loop, never in it: a draft makes
// no request to the node while the model writes, and a loop that waited on it would let the agent
// drop out of presence for as long as the model took. A pass asked for while one runs makes it run
// once more.
//
// The runtime's stop function stops the loops; the tests use it. A process that ends (Mastra's
// server exits on SIGTERM) ends its held wait with it.
//
// A failed wait is retried after a delay that doubles from BACKOFF_MIN_MS to BACKOFF_MAX_MS, with
// the cursor kept. The sweep (HDTP_RECONCILE_SECONDS) stays the safety net under the loop and the
// webhook.

import type { Log } from './log.ts'
import { refusalCode, type NodeClient } from './node.ts'

export const BACKOFF_MIN_MS = 1_000
/** Under the node's one-minute presence window, so a node that comes back sees the agent soon. */
export const BACKOFF_MAX_MS = 30_000

/** What the loop wakes: a pass over one account. It logs its own failures and never rejects. */
export type Pass = (accountId: string) => Promise<void>

export function backoff(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1))
}

/** A delay that ends early, and quietly, when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export class Watcher {
  /** The running loop of each account, by the controller that stops it. */
  private readonly loops = new Map<string, AbortController>()
  /** Passes in flight by account, and whether another was asked for while one ran. */
  private readonly passes = new Map<string, { again: boolean }>()
  private stopped = false

  private readonly node: NodeClient
  private readonly pass: Pass
  private readonly log: Log

  constructor(node: NodeClient, pass: Pass, log: Log) {
    this.node = node
    this.pass = pass
    this.log = log
  }

  /** Whether any loop runs. */
  get watching(): boolean {
    return this.loops.size > 0
  }

  /** Runs one loop for each listed account: starts the missing ones, stops those no longer listed. */
  sync(accounts: readonly string[]): void {
    if (this.stopped) return
    for (const [accountId, loop] of this.loops) {
      if (!accounts.includes(accountId)) {
        loop.abort()
        this.loops.delete(accountId)
      }
    }
    for (const accountId of accounts) {
      if (this.loops.has(accountId)) continue
      const loop = new AbortController()
      this.loops.set(accountId, loop)
      void this.run(accountId, loop.signal)
    }
  }

  /** Stops every loop, ending a held wait, and starts no more. Passes in flight finish. */
  stop(): void {
    this.stopped = true
    for (const loop of this.loops.values()) loop.abort()
    this.loops.clear()
  }

  private async run(accountId: string, signal: AbortSignal): Promise<void> {
    let cursor: number | undefined
    let failures = 0
    while (!signal.aborted) {
      let answer
      try {
        answer = await this.node.waitForUpdates(accountId, cursor, signal)
      } catch (e) {
        if (signal.aborted) return
        failures++
        this.log.warn('watch_failed', { account_id: accountId, reason: refusalCode(e), attempt: failures })
        await sleep(backoff(failures), signal)
        continue
      }
      failures = 0
      const first = cursor === undefined
      cursor = answer.cursor
      if (answer.cursor_expired) {
        this.log.info('watch_cursor_expired', { account_id: accountId })
        this.wake(accountId)
      } else if (first) {
        // The node answered at once with a cursor and no backlog. One pass covers what arrived
        // before the cursor, so it is not left to the next sweep.
        this.wake(accountId)
      } else if (!answer.timed_out && ((answer.threads?.length ?? 0) > 0 || answer.pending_requests > 0)) {
        this.wake(accountId)
      }
    }
  }

  /** Starts a pass over the account beside the loop, or asks the running one to go once more. */
  private wake(accountId: string): void {
    const held = this.passes.get(accountId)
    if (held) {
      held.again = true
      return
    }
    const state = { again: false }
    this.passes.set(accountId, state)
    void (async () => {
      try {
        do {
          state.again = false
          await this.pass(accountId)
        } while (state.again && !this.stopped)
      } finally {
        this.passes.delete(accountId)
      }
    })()
  }
}
