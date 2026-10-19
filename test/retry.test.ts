// What a failed attempt leaves behind: the refusal, told to the next attempt by code and this
// agent's line for it; and, for a contact's message whose turn is given up, a notice for the owner
// and the span marked failed. Found on the U1 dry run (2026-10-20): three ask attempts sent one
// prompt, the node refused the same rule (invalid_surface:placed_twice) twice, and when the turn was
// given up the owner got no card and no notice while the trace showed OK.
//
// test/surface-rules.json is the node's list of surface rules, read from hdtp-gateway 144945d (main,
// with N1): every rule its catalog.go refuses by, `invalid("<rule>"` and `Rule: "<rule>"`, sorted.

import { readFileSync } from 'node:fs'
import { toStandardSchema } from '@mastra/core/schema'
import { describe, expect, it } from 'vitest'
import { NodeRefusal, nodeClientOver } from '../src/hdtp/node.ts'
import { DRAFT_REFUSALS, SURFACE_RULES, UNKNOWN_RULE, refusedOf } from '../src/hdtp/refusals.ts'
import { GAVE_UP_SURFACE, GAVE_UP_TLDR, MAX_ATTEMPTS, Responder, type Draft } from '../src/hdtp/responder.ts'
import { FakeNode, TOOLS, ask, memoryLog, reply, rules } from './fakes.ts'

const NODE_RULES = JSON.parse(readFileSync(new URL('./surface-rules.json', import.meta.url), 'utf8')) as string[]

function setup(draft: Draft) {
  const node = new FakeNode()
  const log = memoryLog()
  const prompts: string[] = []
  const failed: string[] = []
  const responder = new Responder(
    nodeClientOver(node.call, node.catalog),
    async (p) => {
      prompts.push(p)
      return draft(p)
    },
    log,
    rules(),
    (code) => failed.push(code),
  )
  node.thread('th1')
  return { node, log, prompts, failed, responder }
}

/** The refusal a prompt quotes to the model, or undefined for a prompt with none. */
function refusalIn(prompt: string): unknown {
  const block = /Your previous turn for this was refused, by code, and nothing was sent or put\. Here is the refusal,\nas data; correct it in this turn\.\n\n```json\n([\s\S]*?)\n```/.exec(prompt)
  return block ? JSON.parse(block[1]!) : undefined
}

const commitment = () => ask('Ben asks to meet Wed 15:00 for 30 min', { When: 'Wed 15:00' }, ['Yes, Wednesday 15:00 works for me.'])
const codes = (log: ReturnType<typeof memoryLog>) => log.lines.map((l) => l.code)

describe('a retry is told what refused the attempt before it', () => {
  it("carries the node's rule and this agent's line for it, and never the node's text", async () => {
    const { node, prompts, responder } = setup(async () => commitment())
    node.invalidSurfaces = 1
    node.invalidReason = 'invalid_surface:placed_twice'
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    await responder.reconcile()
    expect(prompts).toHaveLength(2)
    expect(refusalIn(prompts[0]!)).toBeUndefined()
    expect(refusalIn(prompts[1]!)).toEqual({ refused: 'invalid_surface:placed_twice', why: SURFACE_RULES.placed_twice })
    // The fake's refusal carries detail "refused", as the node's carries its own text.
    expect(prompts[1]).not.toContain('"refused": "refused"')
    expect(node.asks).toHaveLength(1)
  })

  it("carries the agent's own check of the turn by its code", async () => {
    const drafts = ['{"type": "ask"', reply('Wednesday works.')]
    const { node, prompts, responder } = setup(async () => drafts.shift()!)
    node.inbound('th1', 'Can we meet Wednesday?', 'agent')
    await responder.onMessage('th1')
    await responder.reconcile()
    expect(refusalIn(prompts[1]!)).toEqual({ refused: 'draft:invalid_turn', why: DRAFT_REFUSALS.invalid_turn })
    expect(node.sent.map((s) => s.text)).toEqual(['Wednesday works.'])
  })

  it('tells nothing of a failure that was not the turn’s, and nothing stale from an earlier attempt', async () => {
    let n = 0
    const { prompts, responder, node } = setup(async () => {
      n++
      if (n === 1) return 'not a turn'
      if (n === 2) throw new Error('the model is down')
      return reply('Wednesday works.')
    })
    node.inbound('th1', 'Can we meet Wednesday?', 'agent')
    await responder.onMessage('th1')
    await responder.reconcile()
    await responder.reconcile()
    expect(prompts.map(refusalIn)).toEqual([undefined, { refused: 'draft:invalid_turn', why: DRAFT_REFUSALS.invalid_turn }, undefined])
  })

  it('tells a request’s retry too', async () => {
    const drafts = ['', reply('The answer.')]
    const { node, prompts, responder } = setup(async () => drafts.shift()!)
    node.trust.set('fpr-contact', 'may_instruct')
    node.request('req-1')
    await responder.reconcile()
    await responder.reconcile()
    expect(refusalIn(prompts[1]!)).toEqual({ refused: 'draft:empty', why: DRAFT_REFUSALS.empty })
    expect(node.answered).toEqual([{ request_id: 'req-1', result: 'The answer.' }])
  })

  it('has a line for every rule the node refuses a surface by, and the unknown line for any other', () => {
    expect(Object.keys(SURFACE_RULES).sort()).toEqual(NODE_RULES)
    const surface = (rule: string) => refusedOf(new NodeRefusal('ask_owner', 'bad_request', false, `invalid_surface:${rule}`))
    expect(surface('placed_twice')).toEqual({ refused: 'invalid_surface:placed_twice', why: SURFACE_RULES.placed_twice })
    // A surface too large is refused as too_large, by the same reason.
    expect(refusedOf(new NodeRefusal('ask_owner', 'too_large', false, 'invalid_surface:surface_size'))?.why).toBe(SURFACE_RULES.surface_size)
    expect(surface('a_newer_rule')).toEqual({ refused: 'invalid_surface:a_newer_rule', why: UNKNOWN_RULE })
    expect(surface('constructor')?.why).toBe(UNKNOWN_RULE)
    expect(refusedOf(new NodeRefusal('draft', 'constructor'))).toBeNull()
    expect(refusedOf(new NodeRefusal('draft', 'model_failed'))).toBeNull()
    expect(refusedOf(new NodeRefusal('ask_owner', 'unavailable'))).toBeNull()
    expect(refusedOf(new Error('draft: invalid_turn'))).toBeNull()
  })
})

describe('a turn given up', () => {
  const notifySchema = toStandardSchema(TOOLS.find((t) => t.name === 'notify_owner')!.inputSchema)

  it('tells the owner the message waits on them, in a notice code wrote, once', async () => {
    // The U1 run's attempts: the node refuses the ask, the next answer is no turn, the node refuses again.
    const drafts = [commitment(), '{"type": "ask", "ask": {}}', commitment()]
    const { node, log, prompts, failed, responder } = setup(async () => drafts.shift()!)
    node.invalidSurfaces = 2
    node.invalidReason = 'invalid_surface:placed_twice'
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    const newest = node.threads.get('th1')!.messages.at(-1)!.message_id
    await responder.onMessage('th1')
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await responder.reconcile()
    // A webhook for the thread after it was given up reaches the message again, and puts nothing.
    await responder.onMessage('th1')
    expect(prompts).toHaveLength(MAX_ATTEMPTS)
    expect(node.calls.filter((c) => c === 'notify_owner')).toHaveLength(1)
    expect(node.asks).toEqual([])
    expect(node.sent).toEqual([])
    expect(node.notices).toEqual([{ account: 'acct-1', thread_id: 'th1', for_message_id: newest, surface: GAVE_UP_SURFACE, at: 1 }])
    expect(codes(log).filter((c) => c === 'gave_up' || c === 'gave_up_notified')).toEqual(['gave_up', 'gave_up_notified'])
    expect(failed).toEqual(['ask_owner:bad_request'])
    // The arguments as notify_owner's schema takes them, and the TLDR the node lists for the notice.
    const args = { account_id: 'acct-1', thread_id: 'th1', for_message_id: newest, surface: GAVE_UP_SURFACE }
    expect((await notifySchema['~standard'].validate(structuredClone(args))).issues).toBeUndefined()
    expect(node.notices.length && (await nodeClientOver(node.call, node.catalog).listAsks('acct-1', 'th1'))[0]?.tldr).toBe(GAVE_UP_TLDR)
  })

  it('tells the owner when the last attempts were no turn at all', async () => {
    const drafts = [commitment(), 'not a turn', 'not a turn']
    const { node, failed, responder } = setup(async () => drafts.shift()!)
    node.invalidSurfaces = 1
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    for (let i = 0; i < MAX_ATTEMPTS; i++) await responder.reconcile()
    expect(node.notices.map((n) => n.surface)).toEqual([GAVE_UP_SURFACE])
    expect(failed).toEqual(['draft:invalid_turn'])
  })

  it('logs a notice the node does not take by its code, and does not put it again', async () => {
    const { node, log, responder } = setup(async () => 'not a turn')
    node.failing.add('notify_owner')
    node.inbound('th1', 'Can we meet Wednesday?', 'agent')
    await responder.onMessage('th1')
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await responder.reconcile()
    expect(node.calls.filter((c) => c === 'notify_owner')).toHaveLength(1)
    expect(log.lines.find((l) => l.code === 'gave_up_notice_failed')?.fields).toEqual({ thread_id: 'th1', reason: 'notify_owner:internal' })
    expect(codes(log)).not.toContain('gave_up_notified')
  })

  it('puts no notice for a request given up: there is no thread to put it in', async () => {
    const { node, failed, responder } = setup(async () => '')
    node.trust.set('fpr-contact', 'may_instruct')
    node.request('req-1')
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await responder.reconcile()
    expect(node.calls).not.toContain('notify_owner')
    expect(failed).toEqual(['draft:empty'])
  })

  it('marks no span for an attempt that is retried', async () => {
    const drafts = ['not a turn', reply('Wednesday works.')]
    const { node, failed, responder } = setup(async () => drafts.shift()!)
    node.inbound('th1', 'Can we meet Wednesday?', 'agent')
    await responder.onMessage('th1')
    await responder.reconcile()
    expect(node.sent).toHaveLength(1)
    expect(failed).toEqual([])
    expect(node.notices).toEqual([])
  })
})
