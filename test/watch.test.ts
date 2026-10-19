// The wait_for_updates loop against the FakeNode's change log, on a fake clock. The node counts
// the agent attached while its last request is under 60 s old and holds a wait for 25 s at most;
// these tests read the clock at every call the FakeNode answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NodeRefusal, nodeClientOver } from '../src/hdtp/node.ts'
import { Responder, type Draft } from '../src/hdtp/responder.ts'
import { BACKOFF_MAX_MS, Watcher } from '../src/hdtp/watch.ts'
import { FakeNode, memoryLog, ok, rules, type ToolAnswer } from './fakes.ts'

function setup(draft: Draft = async () => 'an answer') {
  const node = new FakeNode()
  const log = memoryLog()
  const client = nodeClientOver(node.call)
  const responder = new Responder(client, draft, log, rules())
  const watcher = new Watcher(client, (accountId) => responder.reconcileAccount(accountId), log)
  return { node, log, watcher }
}

/** The times of the calls to one tool. */
const timesOf = (node: FakeNode, tool: string) => node.at.filter((_, i) => node.calls[i] === tool)
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!)
/** The `since` of each wait of one account. */
const sinces = (node: FakeNode, account = 'acct-1') => node.waits.filter((w) => w.account === account).map((w) => w.since)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the wait_for_updates loop', () => {
  it('asks the node at least every 25 s while a draft takes 90 s', async () => {
    const { node, watcher } = setup(async () => {
      await new Promise((r) => setTimeout(r, 90_000))
      return 'an answer'
    })
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(10_000)
    node.request('req1')
    await vi.advanceTimersByTimeAsync(300_000)
    watcher.stop()
    expect(node.answered.map((a) => a.request_id)).toEqual(['req1'])
    const waits = timesOf(node, 'wait_for_updates')
    expect(waits.length).toBeGreaterThan(10)
    expect(Math.max(...gaps(waits))).toBeLessThanOrEqual(node.holdMs)
    expect(Math.max(...gaps(node.at))).toBeLessThanOrEqual(node.holdMs)
  })

  it('answers a request that arrives between sweeps, woken by the wait', async () => {
    const { node, watcher } = setup()
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(5_000)
    const before = node.calls.length
    node.request('req1')
    await vi.advanceTimersByTimeAsync(100)
    watcher.stop()
    expect(node.answered.map((a) => a.request_id)).toEqual(['req1'])
    // Through the loop: the wait answered, and a pass over the account ran beside the next wait. No sweep.
    expect(node.calls.slice(before).sort()).toEqual(['answer_request', 'get_inbox', 'list_pending', 'wait_for_updates'])
    expect(node.calls).not.toContain('list_accounts')
  })

  it("answers a contact's message that arrives between sweeps, woken by the wait", async () => {
    const { node, watcher } = setup()
    node.thread('th1')
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(5_000)
    node.inbound('th1', 'are you free on Tuesday?')
    await vi.advanceTimersByTimeAsync(100)
    watcher.stop()
    expect(node.sent.map((s) => s.thread_id)).toEqual(['th1'])
  })

  it('reads the account once when the cursor expired, then waits from the cursor answered', async () => {
    const { node, watcher } = setup()
    node.thread('th1')
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(5_000)
    // A message the change log no longer holds, then a wait whose cursor the log cannot answer from.
    node.threads.get('th1')!.messages.push({ direction: 'in', sender: 'human', kind: 'text', body: 'hello', trust: 'messages_only', message_id: 'msg-1', created_at: 1 })
    node.expireNext = true
    await vi.advanceTimersByTimeAsync(node.holdMs + 1_000)
    watcher.stop()
    expect(node.sent.map((s) => s.thread_id)).toEqual(['th1'])
    // undefined (start), 0 (held to the clock), 0 (expired), then on from the answered cursor.
    expect(sinces(node).slice(0, 3)).toEqual([undefined, 0, 0])
    expect(sinces(node).length).toBeLessThan(6)
  })

  it('backs off on a failing wait, doubling to the cap, and keeps its cursor', async () => {
    const { node, log, watcher } = setup()
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sinces(node)).toEqual([undefined, 0])
    node.failing.add('wait_for_updates')
    // The held wait ends on the clock, then every wait fails for two minutes.
    await vi.advanceTimersByTimeAsync(node.holdMs + 120_000)
    const failed = log.lines.filter((l) => l.code === 'watch_failed')
    // 1, 2, 4, 8, 16, 30, 30, 30 s: eight retries in 120 s, not thousands.
    expect(failed.length).toBeGreaterThanOrEqual(7)
    expect(failed.length).toBeLessThanOrEqual(9)
    expect(failed[0]!.fields).toEqual({ account_id: 'acct-1', reason: 'wait_for_updates:internal', attempt: 1 })
    expect(Math.max(...gaps(timesOf(node, 'wait_for_updates')))).toBeLessThanOrEqual(BACKOFF_MAX_MS)
    node.failing.delete('wait_for_updates')
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS)
    watcher.stop()
    // The first wait after the failures carries the cursor it had, not a fresh start.
    expect(sinces(node)).toEqual([undefined, 0, 0])
  })

  it.each<[string, ToolAnswer]>([
    ['no content', { content: [] }],
    ['JSON that is not an object', ok(42)],
    ['an answer with no cursor', ok({ threads: null, pending_requests: 0, timed_out: false })],
    ['a cursor that is a string', ok({ cursor: '3', threads: null, pending_requests: 0, timed_out: false })],
    ['a negative cursor', ok({ cursor: -1, threads: null, pending_requests: 0, timed_out: false })],
    ['a fractional cursor', ok({ cursor: 1.5, threads: null, pending_requests: 0, timed_out: false })],
    ['no pending_requests', ok({ cursor: 0, threads: null, timed_out: false })],
    ['threads that are not a list', ok({ cursor: 0, threads: 'th1', pending_requests: 0, timed_out: false })],
  ])('backs off on an answer it cannot read (%s), neither ending nor spinning', async (_, unreadable) => {
    const { node, log, watcher } = setup()
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(1_000)
    node.waitAnswer = unreadable
    // The held wait ends on the clock, then every answer is unreadable for two minutes.
    await vi.advanceTimersByTimeAsync(node.holdMs + 120_000)
    const failed = log.lines.filter((l) => l.code === 'watch_failed')
    expect(failed.length).toBeGreaterThanOrEqual(7)
    expect(failed.length).toBeLessThanOrEqual(9)
    expect(failed[0]!.fields).toEqual({ account_id: 'acct-1', reason: 'wait_for_updates:unreadable_answer', attempt: 1 })
    node.waitAnswer = undefined
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS)
    watcher.stop()
    // Every wait after the first carried the cursor the first answer gave, before and after.
    expect(sinces(node)[0]).toBeUndefined()
    expect(new Set(sinces(node).slice(1))).toEqual(new Set([0]))
    expect(sinces(node).length).toBeLessThanOrEqual(12)
  })

  it('logs a pass that rejects by its code, and starts the next one on news', async () => {
    const node = new FakeNode()
    const log = memoryLog()
    let passes = 0
    const watcher = new Watcher(
      nodeClientOver(node.call),
      async () => {
        if (++passes === 1) throw new NodeRefusal('get_inbox', 'internal')
      },
      log,
    )
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(1_000)
    node.request('req1')
    await vi.advanceTimersByTimeAsync(100)
    watcher.stop()
    expect(passes).toBe(2)
    expect(log.lines.filter((l) => l.code === 'watch_pass_failed')).toEqual([
      { code: 'watch_pass_failed', fields: { account_id: 'acct-1', reason: 'get_inbox:internal' } },
    ])
  })

  it('stops its loops, and starts none after stop', async () => {
    const { node, watcher } = setup()
    watcher.sync(['acct-1', 'acct-2'])
    await vi.advanceTimersByTimeAsync(1_000)
    watcher.stop()
    watcher.sync(['acct-1'])
    const calls = node.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    // The two held waits end on the clock; nothing is called after them.
    expect(node.calls.slice(calls)).toEqual([])
  })

  it('stops the loop of an account no longer listed', async () => {
    const { node, watcher } = setup()
    node.accounts = ['acct-1', 'acct-2']
    watcher.sync(['acct-1', 'acct-2'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sinces(node, 'acct-2')).toEqual([undefined, 0])
    watcher.sync(['acct-1'])
    await vi.advanceTimersByTimeAsync(node.holdMs * 3)
    watcher.stop()
    // acct-2's held wait ends on the clock and is not followed by another; acct-1's loop goes on.
    expect(sinces(node, 'acct-2')).toEqual([undefined, 0])
    expect(sinces(node, 'acct-1').length).toBeGreaterThan(3)
  })
})
