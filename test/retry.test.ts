// What a failed attempt leaves behind: the refusal, told to the next attempt by code and this
// agent's line for it; and, for a contact's message whose turn is given up, a notice for the owner
// and the span marked failed. Found on the U1 dry run (2026-10-20): three ask attempts sent one
// prompt, the node refused the same rule (invalid_surface:placed_twice) twice, and when the turn was
// given up the owner got no card and no notice while the trace showed OK.
//
// test/surface-rules.json is the node's list of surface rules, read from hdtp-gateway 144945d (main,
// with N1) and read again, unchanged, from 34a6adf (fix/ask-catalog-guidance, #247): every rule its
// catalog.go refuses by, `invalid("<rule>"` and `Rule: "<rule>"`, sorted.

import { readFileSync } from 'node:fs'
import { toStandardSchema } from '@mastra/core/schema'
import { describe, expect, it } from 'vitest'
import { NodeRefusal, nodeClientOver } from '../src/hdtp/node.ts'
import { DRAFT_REFUSALS, SURFACE_RULES, UNKNOWN_RULE, refusedOf } from '../src/hdtp/refusals.ts'
import { FIRST_TURNS, GAVE_UP_SURFACE, GAVE_UP_TLDR, MAX_ATTEMPTS, Responder, type Draft } from '../src/hdtp/responder.ts'
import { Turns } from '../src/hdtp/turn.ts'
import { FakeNode, TOOLS, ask, memoryLog, notify, reply, rules } from './fakes.ts'

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

// Found in the U5 and U7 rehearsals (2026-10-20, #57): on a notify that also answered the contact
// the model put reply inside notice; the retry was told only that the turn did not match the
// schema, and in U7 it came back as a notice with no reply, so the contact was never told.
describe('a reply put inside the notice', () => {
  const tldr = 'Refund agreed: order 1042, 40 EUR'
  const terms = { Order: '1042', Refund: '40 EUR' }
  const text = 'Agreed: we refund the 40 EUR for order 1042 today.'
  const nested = (top?: string) => {
    const turn = JSON.parse(notify(tldr, terms, top)) as { notice: Record<string, unknown> }
    turn.notice.reply = text
    return JSON.stringify(turn)
  }
  const turns = () => {
    const node = new FakeNode()
    return new Turns(nodeClientOver(node.call, node.catalog))
  }

  it('is refused by its own code, alone or beside a reply where it belongs, and its why names the path', async () => {
    for (const answer of [nested(), nested(text)]) {
      await expect(turns().read(answer, FIRST_TURNS), answer).rejects.toMatchObject({ tool: 'draft', code: 'reply_in_notice' })
    }
    expect(refusedOf(new NodeRefusal('draft', 'reply_in_notice'))).toEqual({ refused: 'draft:reply_in_notice', why: DRAFT_REFUSALS.reply_in_notice })
    expect(DRAFT_REFUSALS.reply_in_notice).toMatch(/^\/notice\/reply: /)
  })

  it('is read as left out when it is null, as any null optional field is', async () => {
    const turn = JSON.parse(notify(tldr, terms, text)) as { notice: Record<string, unknown> }
    const expected = structuredClone(turn)
    turn.notice.reply = null
    expect(await turns().read(JSON.stringify(turn), FIRST_TURNS)).toEqual(expected)
    // A turn refused for something else is not told of a reply it does not have.
    turn.notice.surface = []
    await expect(turns().read(JSON.stringify(turn), FIRST_TURNS)).rejects.toMatchObject({ code: 'invalid_turn' })
  })

  it('takes a notice with its reply beside it, at the turn’s top level', async () => {
    expect(await turns().read(notify(tldr, terms, text), FIRST_TURNS)).toMatchObject({ type: 'notify', reply: text })
  })

  it('tells the retry the path, and the retried turn sends the reply, then puts the notice', async () => {
    const drafts = [nested(), notify(tldr, terms, text)]
    const { node, prompts, responder } = setup(async () => drafts.shift()!)
    node.inbound('th1', 'Yes, a refund of 40 EUR for order 1042 is fine, thank you.', 'agent')
    await responder.onMessage('th1')
    expect(node.sent).toEqual([])
    await responder.reconcile()
    expect(prompts).toHaveLength(2)
    expect(refusalIn(prompts[1]!)).toEqual({ refused: 'draft:reply_in_notice', why: DRAFT_REFUSALS.reply_in_notice })
    expect(node.sent.map((s) => s.text)).toEqual([text])
    expect(node.notices).toHaveLength(1)
  })

  it('refuses a retry that drops the reply, as U7’s did, and the one after it still answers the contact', async () => {
    const drafts = [nested(), notify(tldr, terms), notify(tldr, terms, text)]
    const { node, log, prompts, responder } = setup(async () => drafts.shift()!)
    node.inbound('th1', 'Yes, a refund of 40 EUR for order 1042 is fine, thank you.', 'agent')
    await responder.onMessage('th1')
    await responder.reconcile()
    expect(log.lines.filter((l) => l.code === 'attempt_failed').map((l) => l.fields?.reason)).toEqual(['draft:reply_in_notice', 'draft:reply_dropped'])
    expect(node.sent).toEqual([])
    expect(node.notices).toEqual([])
    await responder.reconcile()
    expect(refusalIn(prompts[2]!)).toEqual({ refused: 'draft:reply_dropped', why: DRAFT_REFUSALS.reply_dropped })
    expect(node.sent.map((s) => s.text)).toEqual([text])
    expect(node.notices).toHaveLength(1)
  })

  it('gives the turn up when every retry drops the reply, and tells the owner it waits on them', async () => {
    const drafts = [nested(), notify(tldr, terms), notify(tldr, terms)]
    const { node, log, failed, responder } = setup(async () => drafts.shift()!)
    node.inbound('th1', 'Yes, a refund of 40 EUR for order 1042 is fine, thank you.', 'agent')
    await responder.onMessage('th1')
    for (let i = 0; i < MAX_ATTEMPTS; i++) await responder.reconcile()
    expect(log.lines.filter((l) => l.code === 'attempt_failed' || l.code === 'gave_up').map((l) => l.fields?.reason)).toEqual([
      'draft:reply_in_notice',
      'draft:reply_dropped',
      'draft:reply_dropped',
    ])
    expect(node.sent).toEqual([])
    expect(node.notices.map((n) => n.surface)).toEqual([GAVE_UP_SURFACE])
    expect(failed).toEqual(['draft:reply_dropped'])
  })

  it('takes a reply turn as the retry, and holds no turn after any other refusal to a reply', async () => {
    const drafts = [nested(), reply(text)]
    const { node, responder } = setup(async () => drafts.shift()!)
    node.inbound('th1', 'Yes, a refund of 40 EUR for order 1042 is fine, thank you.', 'agent')
    await responder.onMessage('th1')
    await responder.reconcile()
    expect(node.sent.map((s) => s.text)).toEqual([text])
    const other = ['not a turn', notify(tldr, terms)]
    const second = setup(async () => other.shift()!)
    second.node.inbound('th1', 'Thanks, the refund arrived.', 'agent')
    await second.responder.onMessage('th1')
    await second.responder.reconcile()
    expect(second.node.sent).toEqual([])
    expect(second.node.notices).toHaveLength(1)
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
