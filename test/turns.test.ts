// The four turns: reply, ask, notify and none, against an owner MCP that holds asks and notices as
// the node does (test/fakes.ts), with the turn schema read from its tools/list.

import { toStandardSchema } from '@mastra/core/schema'
import { describe, expect, it } from 'vitest'
import { nodeClientOver, type NodeClient } from '../src/hdtp/node.ts'
import { FIRST_TURNS, MAX_ATTEMPTS, Responder, type Draft, type Rules } from '../src/hdtp/responder.ts'
import { FILLED_BY_CODE, Turns, turnSchema } from '../src/hdtp/turn.ts'
import { FakeNode, TOOLS, ask, memoryLog, none, notify, reply, rules, surface } from './fakes.ts'

function setup(draft: Draft, over: Partial<Rules> = {}) {
  const node = new FakeNode()
  const log = memoryLog()
  const prompts: string[] = []
  const responder = new Responder(
    nodeClientOver(node.call, node.catalog),
    async (p) => {
      prompts.push(p)
      return draft(p)
    },
    log,
    rules(over),
  )
  node.thread('th1')
  return { node, log, prompts, responder }
}

/** The conversation block of a thread prompt, as the model reads it. */
function conversation(prompt: string): Array<{ from: string; text: string }> {
  return JSON.parse(prompt.split('```')[1]!.replace(/^json\n/, '')) as Array<{ from: string; text: string }>
}

const codes = (log: ReturnType<typeof memoryLog>) => log.lines.map((l) => l.code)

describe('none', () => {
  it('sends nothing for a sign-off, is not retried, and costs no draft on the next sweep or webhook', async () => {
    const { node, log, prompts, responder } = setup(async () => none())
    node.inbound('th1', 'Great, see you Wednesday!', 'agent')
    await responder.onMessage('th1')
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await responder.reconcile()
    await responder.onMessage('th1')
    expect(node.sent).toEqual([])
    expect(node.notices).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(codes(log).filter((c) => c === 'no_reply')).toHaveLength(1)
    expect(codes(log)).not.toContain('attempt_failed')
  })
})

describe('ask', () => {
  const commitment = () => ask('Ben asks to meet Wed 15:00 for 30 min', { When: 'Wed 15:00', Length: '30 min' }, ['Confirm Wed 15:00', 'Offer Thu 10:00'])

  it('puts the ask for the message it is about, and sends the contact nothing', async () => {
    const { node, log, responder } = setup(async () => commitment())
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    expect(node.sent).toEqual([])
    expect(node.asks).toHaveLength(1)
    const put = node.asks[0]!
    expect(put).toMatchObject({ account: 'acct-1', thread_id: 'th1', status: 'open', for_message_id: node.threads.get('th1')!.messages[0]!.message_id })
    expect(put.surface).toEqual(surface('Ben asks to meet Wed 15:00 for 30 min', { When: 'Wed 15:00', Length: '30 min' }, ['Confirm Wed 15:00', 'Offer Thu 10:00']))
    expect(codes(log)).toContain('asked')
  })

  it('drafts nothing on the thread while the ask is open, and leaves a newer message unread for the owner', async () => {
    const { node, log, prompts, responder } = setup(async () => commitment())
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    node.inbound('th1', 'Any news?', 'agent')
    await responder.onMessage('th1')
    await responder.reconcile()
    expect(prompts).toHaveLength(1)
    expect(node.sent).toEqual([])
    expect(node.calls.filter((c) => c === 'read_thread')).toHaveLength(1)
    expect((await nodeClientOver(node.call, node.catalog).getInbox('acct-1'))[0]!.unread).toBe(1)
    expect(codes(log).filter((c) => c === 'ask_open')).toHaveLength(2)
  })

  it('carries on after the owner taps a ready reply, which the node sent as their message', async () => {
    const { node, prompts, responder } = setup(async (p) => {
      const last = conversation(p).at(-1)!.text
      return last.includes('Wednesday 15:00?') ? commitment() : last.includes('Booked') ? none() : reply('unexpected')
    })
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    node.answerAsk(node.asks[0]!.id, 'Confirm Wed 15:00')
    // The owner's message is the newest: nothing for the agent to answer.
    await responder.reconcile()
    expect(prompts).toHaveLength(1)
    // The contact's agent confirms; the agent sees the owner's message in the thread, and closes.
    node.inbound('th1', 'Booked: Wednesday 15:00, 30 minutes.', 'agent')
    await responder.reconcile()
    expect(prompts).toHaveLength(2)
    expect(conversation(prompts[1]!).map((m) => [m.from, m.text])).toEqual([
      ['contact', 'Can we lock in Wednesday 15:00?'],
      ['you', 'Confirm Wed 15:00'],
      ['contact', 'Booked: Wednesday 15:00, 30 minutes.'],
    ])
    expect(node.sent).toEqual([])
  })

  it('drafts once more for an ask answered with no message, quoting the answer, and offers no second ask', async () => {
    const offered: string[] = []
    const { node, log, prompts, responder } = setup(async (p) => {
      offered.push(/Choose one of these turns: (.*)\./.exec(p)![1]!)
      return offered.length === 1 ? commitment() : offered.length === 2 ? commitment() : reply('Confirmed: Wednesday 15:00.')
    })
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    node.answerAsk(node.asks[0]!.id, 'Ana chose: "Confirm Wed 15:00"', false)
    // The watcher wakes a pass for the thread; it is visited though the node counts it read.
    await responder.reconcile()
    expect(offered[1]).toBe('reply, notify, none')
    expect(prompts[1]).toContain('Ana chose: \\"Confirm Wed 15:00\\"')
    // A second ask is refused by code and retried; the retry replies.
    expect(log.lines.find((l) => l.code === 'attempt_failed')?.fields).toMatchObject({ reason: 'draft:turn_not_allowed' })
    await responder.reconcile()
    expect(node.asks).toHaveLength(1)
    expect(node.sent.map((s) => s.text)).toEqual(['Confirmed: Wednesday 15:00.'])
  })

  it('reads list_asks only as the node answers it, an object holding the rows', async () => {
    const node = new FakeNode()
    const bare: NodeClient = nodeClientOver(
      async (name, args) => (name === 'list_asks' ? { content: [{ type: 'text', text: '[]' }] } : node.call(name, args)),
      node.catalog,
    )
    await expect(bare.listAsks('acct-1', { open: true })).rejects.toMatchObject({ tool: 'list_asks', code: 'unreadable_answer' })
  })

  it('holds only its own thread: another contact is answered while the ask is open', async () => {
    const { node, responder } = setup(async (p) => (conversation(p).at(-1)!.text.includes('Wednesday') ? commitment() : reply('Hello Cleo.')))
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    node.thread('th2', 'fpr-cleo')
    node.inbound('th2', 'Hi, is Alex around?', 'agent')
    await responder.onMessage('th2')
    expect(node.sent.map((s) => [s.thread_id, s.text])).toEqual([['th2', 'Hello Cleo.']])
  })

  it('takes a notice for the newest message for no ask: a later visit offers all four turns', async () => {
    const offered: string[] = []
    const draft: Draft = async (p) => (offered.push(/Choose one of these turns: (.*)\./.exec(p)![1]!), notify('Dentist booked Tue 10:00', { When: 'Tue 10:00' }))
    const { node, responder } = setup(draft)
    node.inbound('th1', 'You are booked: Tuesday 10:00.', 'agent')
    await responder.onMessage('th1')
    // A restarted agent, the same message delivered again.
    await new Responder(nodeClientOver(node.call, node.catalog), draft, memoryLog(), rules()).onMessage('th1')
    expect(offered).toEqual(['reply, ask, notify, none', 'reply, ask, notify, none'])
  })

  it('drafts once more for an ask that expired, and says it expired', async () => {
    const { node, prompts, responder } = setup(async () => (prompts.length === 1 ? commitment() : reply('Ana has not decided yet.')))
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    node.expireAsk(node.asks[0]!.id)
    await responder.reconcile()
    expect(prompts[1]).toContain('"status": "expired"')
    expect(prompts[1]).toContain('"answer": null')
    expect(node.sent.map((s) => s.text)).toEqual(['Ana has not decided yet.'])
  })

  it('is refused by code when the surface is outside the schema, and retried on the next pass', async () => {
    let bad = true
    const { node, log, prompts, responder } = setup(async () => {
      if (!bad) return commitment()
      bad = false
      const [create, update] = surface('Lock in Wed 15:00?', { When: 'Wed 15:00' }, ['Yes'])
      const components = [{ id: 'root', component: 'Column', children: ['v'] }, { id: 'v', component: 'Video', url: 'x' }]
      return JSON.stringify({ type: 'ask', ask: { surface: [create, { ...update, updateComponents: { surfaceId: 's1', components } }] } })
    })
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    expect(node.calls).not.toContain('ask_owner')
    expect(log.lines.find((l) => l.code === 'attempt_failed')?.fields).toMatchObject({ reason: 'draft:invalid_turn', attempt: 1 })
    await responder.reconcile()
    expect(prompts).toHaveLength(2)
    expect(node.asks).toHaveLength(1)
  })

  it('is retried on the next pass when the node refuses the surface', async () => {
    const { node, log, prompts, responder } = setup(async () => commitment())
    node.invalidSurfaces = 1
    node.inbound('th1', 'Can we lock in Wednesday 15:00?', 'agent')
    await responder.onMessage('th1')
    expect(node.asks).toEqual([])
    expect(log.lines.find((l) => l.code === 'attempt_failed')?.fields).toMatchObject({ reason: 'ask_owner:bad_request', attempt: 1 })
    await responder.reconcile()
    expect(prompts).toHaveLength(2)
    expect(node.asks).toHaveLength(1)
    expect(node.sent).toEqual([])
  })
})

describe('notify', () => {
  const booked = () => notify('Booked: cleaning Tue 10:00', { When: 'Tue 10:00', With: 'Dr. Rao' }, 'Booked you in: Tuesday 10:00 with Dr. Rao.')

  it('sends the reply, then puts the notice for the owner', async () => {
    const { node, log, responder } = setup(async () => booked())
    node.inbound('th1', 'Tuesday 10:00 works, please book it.', 'agent')
    await responder.onMessage('th1')
    expect(node.sent.map((s) => s.text)).toEqual(['Booked you in: Tuesday 10:00 with Dr. Rao.'])
    expect(node.notices).toEqual([
      {
        account: 'acct-1',
        thread_id: 'th1',
        for_message_id: node.threads.get('th1')!.messages[0]!.message_id,
        surface: surface('Booked: cleaning Tue 10:00', { When: 'Tue 10:00', With: 'Dr. Rao' }),
      },
    ])
    expect(codes(log).filter((c) => c === 'replied' || c === 'notified')).toEqual(['replied', 'notified'])
  })

  it('puts a notice with no reply, and sends the contact nothing', async () => {
    const { node, responder } = setup(async () => notify('Dentist booked Tue 10:00', { When: 'Tue 10:00' }))
    node.inbound('th1', 'You are booked: Tuesday 10:00.', 'agent')
    await responder.onMessage('th1')
    expect(node.sent).toEqual([])
    expect(node.notices).toHaveLength(1)
  })

  it('puts again, with no new draft, a notice the node did not take after the reply was sent', async () => {
    const { node, log, prompts, responder } = setup(async () => booked())
    node.failing.add('notify_owner')
    node.inbound('th1', 'Tuesday 10:00 works, please book it.', 'agent')
    await responder.onMessage('th1')
    expect(node.sent).toHaveLength(1)
    expect(node.notices).toEqual([])
    expect(log.lines.find((l) => l.code === 'attempt_failed')?.fields).toMatchObject({ reason: 'notify_owner:internal' })
    node.failing.delete('notify_owner')
    await responder.reconcile()
    expect(node.notices).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(node.sent).toHaveLength(1)
    // Delivered: no further pass puts it again.
    await responder.reconcile()
    expect(node.calls.filter((c) => c === 'notify_owner')).toHaveLength(2)
  })

  it('gives up on a notice after MAX_ATTEMPTS', async () => {
    const { node, log, responder } = setup(async () => booked())
    node.failing.add('notify_owner')
    node.inbound('th1', 'Tuesday 10:00 works, please book it.', 'agent')
    await responder.onMessage('th1')
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await responder.reconcile()
    expect(node.calls.filter((c) => c === 'notify_owner')).toHaveLength(MAX_ATTEMPTS)
    expect(codes(log).filter((c) => c === 'gave_up')).toHaveLength(1)
    // Given up: the thread, read and answered, is not visited again.
    const visits = node.calls.filter((c) => c === 'list_asks').length
    await responder.reconcile()
    expect(node.calls.filter((c) => c === 'list_asks')).toHaveLength(visits)
  })
})

describe('the turn as the model wrote it', () => {
  it('is refused as invalid_turn when it is not JSON, or not one of the four, and is read inside one fenced block', async () => {
    for (const answer of ['Sure, Wednesday works!', '{"type":"maybe"}', '{"type":"reply"}', '{"type":"none","text":"bye"}']) {
      const { node, log, responder } = setup(async () => answer)
      node.inbound('th1', 'hello')
      await responder.onMessage('th1')
      expect(node.sent, answer).toEqual([])
      expect(log.lines.find((l) => l.code === 'attempt_failed')?.fields, answer).toMatchObject({ reason: 'draft:invalid_turn' })
    }
    const { node, responder } = setup(async () => '```json\n{"type":"reply","text":"Hello!"}\n```')
    node.inbound('th1', 'hello')
    await responder.onMessage('th1')
    expect(node.sent.map((s) => s.text)).toEqual(['Hello!'])
  })

  it('cannot name the account, thread or message an ask is put on', async () => {
    const turn = JSON.parse(ask('x', { a: 'b' }, ['ok'])) as { ask: Record<string, unknown> }
    turn.ask.thread_id = 'th-other'
    const { node, log, responder } = setup(async () => JSON.stringify(turn))
    node.thread('th-other')
    node.inbound('th1', 'hello')
    await responder.onMessage('th1')
    expect(node.asks).toEqual([])
    expect(log.lines.find((l) => l.code === 'attempt_failed')?.fields).toMatchObject({ reason: 'draft:invalid_turn' })
  })

  it('logs no text of the validator or the model', async () => {
    const { node, log, responder } = setup(async () => '{"type":"reply","text":42,"secret":"the model said this"}')
    node.inbound('th1', 'hello')
    await responder.onMessage('th1')
    expect(JSON.stringify(log.lines)).not.toMatch(/the model said|must be|additional/)
  })
})

describe('agent-answered requests', () => {
  it('take a reply turn only: any other is refused by code and retried', async () => {
    let first = true
    const { node, log, responder } = setup(async () => {
      if (!first) return reply('the rate is 90/h')
      first = false
      return none()
    })
    node.pending.push({ ID: 'req1', ContactFpr: 'fpr-contact', Capability: 'ask_alex', Args: '{}', TrustFlag: 'messages_only', Status: 'open', ExpiresAt: 0 })
    await responder.onRequest('req1')
    expect(node.answered).toEqual([])
    expect(log.lines.find((l) => l.code === 'attempt_failed')?.fields).toMatchObject({ reason: 'draft:turn_not_allowed' })
    await responder.reconcile()
    expect(node.answered).toEqual([{ request_id: 'req1', result: 'the rate is 90/h' }])
  })
})

describe('a node without the asks tools', () => {
  it('has no thread read or drafted for, so its threads stay unread for the owner', async () => {
    const { node, log, prompts, responder } = setup(async () => reply('hi'))
    node.unlisted.add('ask_owner')
    node.inbound('th1', 'hello')
    await responder.reconcile()
    expect(prompts).toEqual([])
    expect(node.calls).not.toContain('read_thread')
    expect(log.lines).toContainEqual({ code: 'reconcile_failed', fields: { section: 'get_inbox', reason: 'ask_owner:tool_not_offered' } })
  })
})

describe('two agents closing a deal (agent#34)', () => {
  /** Ana's agent and Ben's, each on its own node, each node's outbound relayed to the other's inbound. */
  async function run(draftA: Draft, draftB: Draft, open: string) {
    const a = setup(draftA)
    const b = setup(draftB)
    b.node.outbound('th1', open, 'agent')
    a.node.inbound('th1', open, 'agent')
    let relayedA = 0
    let relayedB = 0
    for (let round = 0; round < 20; round++) {
      await a.responder.reconcile()
      for (const s of a.node.sent.slice(relayedA)) b.node.inbound('th1', s.text, 'agent')
      await b.responder.reconcile()
      for (const s of b.node.sent.slice(relayedB)) a.node.inbound('th1', s.text, 'agent')
      if (a.node.sent.length === relayedA && b.node.sent.length === relayedB) break
      relayedA = a.node.sent.length
      relayedB = b.node.sent.length
    }
    return { a, b }
  }

  it('ends on none, below the turn cap, with one draft per message', async () => {
    const last = (p: string) => conversation(p).at(-1)!.text
    const { a, b } = await run(
      async (p) => (last(p).startsWith('Confirmed') ? none() : reply('Wednesday 15:00 works for 30 minutes?')),
      async (p) => (last(p).startsWith('Wednesday') ? reply('Confirmed: Wednesday 15:00.') : reply('unexpected')),
      'Could we meet this week?',
    )
    expect(a.node.sent.map((s) => s.text)).toEqual(['Wednesday 15:00 works for 30 minutes?'])
    expect(b.node.sent.map((s) => s.text)).toEqual(['Confirmed: Wednesday 15:00.'])
    expect(a.prompts).toHaveLength(2)
    expect(b.prompts).toHaveLength(1)
    for (const side of [a, b]) expect(codes(side.log)).not.toContain('agent_turn_cap')
  })

  it('ends with a notice on both sides when both commit within limits', async () => {
    const last = (p: string) => conversation(p).at(-1)!.text
    const { a, b } = await run(
      async (p) => (last(p).startsWith('Booked') ? notify('Dentist: Tue 10:00', { When: 'Tue 10:00' }) : reply('Tuesday 10:00 suits me.')),
      async () => notify('New patient: Tue 10:00', { When: 'Tue 10:00' }, 'Booked: Tuesday 10:00.'),
      'We have Tuesday 10:00 or Thursday 16:00.',
    )
    expect(a.node.notices).toHaveLength(1)
    expect(b.node.notices).toHaveLength(1)
    expect(a.node.sent).toHaveLength(1)
    expect(b.node.sent).toHaveLength(1)
  })
})

describe('the turn schema', () => {
  const schemaOf = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema

  it('is built from the node’s schemas, and requires of them the ids code fills', async () => {
    for (const tool of ['ask_owner', 'notify_owner']) {
      const s = schemaOf(tool) as { properties: Record<string, unknown>; required: string[] }
      for (const k of FILLED_BY_CODE) {
        expect(s.properties, `${tool}.${k}`).toHaveProperty(k)
        expect(s.required, `${tool}.${k}`).toContain(k)
      }
    }
    const built = turnSchema(schemaOf('send_to_contact'), schemaOf('ask_owner'), schemaOf('notify_owner')) as {
      oneOf: Array<{ properties: Record<string, { properties?: Record<string, unknown> }> }>
    }
    const [r, a, n] = built.oneOf
    expect(r!.properties.text).toEqual((schemaOf('send_to_contact') as { properties: Record<string, unknown> }).properties.text)
    for (const k of FILLED_BY_CODE) {
      expect(a!.properties.ask!.properties).not.toHaveProperty(k)
      expect(n!.properties.notice!.properties).not.toHaveProperty(k)
    }
    expect(a!.properties.ask!.properties!.surface).toEqual((schemaOf('ask_owner') as { properties: Record<string, unknown> }).properties.surface)
    expect(n!.properties.notice!.properties!.surface).toEqual((schemaOf('notify_owner') as { properties: Record<string, unknown> }).properties.surface)
  })

  it('bounds a reply’s text, alone or with a notice, as send_to_contact bounds it', async () => {
    const send = structuredClone(schemaOf('send_to_contact')) as { properties: { text: Record<string, unknown> } }
    send.properties.text.maxLength = 10
    const check = toStandardSchema(turnSchema(send, schemaOf('ask_owner'), schemaOf('notify_owner')))['~standard']
    const notice = (JSON.parse(notify('t', { a: 'b' })) as { notice: unknown }).notice
    expect((await check.validate({ type: 'reply', text: 'ten chars.' })).issues).toBeUndefined()
    expect((await check.validate({ type: 'reply', text: 'eleven char' })).issues).toBeDefined()
    expect((await check.validate({ type: 'notify', notice, reply: 'eleven char' })).issues).toBeDefined()
  })

  it('checks a surface in the tools’ dialect, 2020-12, and refuses a tool schema in another', async () => {
    const check = toStandardSchema(turnSchema(schemaOf('send_to_contact'), schemaOf('ask_owner'), schemaOf('notify_owner')))['~standard']
    const [create, update] = surface('Lock in Wed 15:00?', { When: 'Wed 15:00' }, ['Yes'])
    expect((await check.validate({ type: 'ask', ask: { surface: [create, update] } })).issues).toBeUndefined()
    // prefixItems orders the two messages; a validator in an older dialect would pass these.
    expect((await check.validate({ type: 'ask', ask: { surface: [update, create] } })).issues).toBeDefined()
    const draft7 = { ...schemaOf('ask_owner'), $schema: 'http://json-schema.org/draft-07/schema#' }
    expect(() => turnSchema(schemaOf('send_to_contact'), draft7, schemaOf('notify_owner'))).toThrow(
      expect.objectContaining({ tool: 'ask_owner', code: 'schema_unexpected' }),
    )
  })

  it('is read once from the node, and again after a failure', async () => {
    const node = new FakeNode()
    let reads = 0
    let fail = true
    const client: NodeClient = {
      ...nodeClientOver(node.call, node.catalog),
      toolSchema: async (name) => {
        reads++
        if (fail) throw new Error('down')
        return node.toolSchema(name)
      },
    }
    const turns = new Turns(client)
    await expect(turns.schema()).rejects.toThrow()
    fail = false
    await turns.schema()
    await turns.schema()
    expect(reads).toBe(6)
  })

  it('offers the four turns on a first draft', () => {
    expect(FIRST_TURNS).toEqual(['reply', 'ask', 'notify', 'none'])
  })
})
