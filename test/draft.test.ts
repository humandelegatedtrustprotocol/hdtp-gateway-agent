// One draft: the model call under its output cap, and a call that stops at the cap refused by code.

import type { Agent } from '@mastra/core/agent'
import { describe, expect, it } from 'vitest'
import { nodeClientOver } from '../src/hdtp/node.ts'
import { MAX_ATTEMPTS, Responder } from '../src/hdtp/responder.ts'
import { MAX_OUTPUT_TOKENS, drafter } from '../src/hdtp/runtime.ts'
import { FakeNode, memoryLog, reply, rules } from './fakes.ts'

/** An agent whose generate answers `text` with `finishReason`, and records the options it was given. */
function agentAnswering(text: string, finishReason: string) {
  const options: unknown[] = []
  const agent = {
    generate: async (_prompt: string, opts?: unknown) => {
      options.push(opts)
      return { text, finishReason }
    },
  } as unknown as Pick<Agent, 'generate'>
  return { agent, options }
}

describe('a draft', () => {
  it('asks the model for at most MAX_OUTPUT_TOKENS, and reads a turn that ended on its own', async () => {
    const { agent, options } = agentAnswering(reply('Tuesday works.'), 'stop')
    expect(await drafter(agent)('prompt')).toBe(reply('Tuesday works.'))
    expect(MAX_OUTPUT_TOKENS).toBe(4096)
    // No span is open here; under one, the agent run is kept in its trace (test/observability.test.ts).
    expect(options).toEqual([{ modelSettings: { maxOutputTokens: 4096 }, tracingContext: { currentSpan: undefined } }])
  })

  it('refuses a call that stopped at the cap as draft:truncated, even when its text is a turn', async () => {
    const { agent } = agentAnswering(reply('Tuesday works.'), 'length')
    await expect(drafter(agent)('prompt')).rejects.toMatchObject({ tool: 'draft', code: 'truncated' })
  })

  it('counts a truncated call as a failed attempt: retried on later passes, then given up', async () => {
    const node = new FakeNode()
    const log = memoryLog()
    const { agent, options } = agentAnswering(reply('Tuesday works.'), 'length')
    const responder = new Responder(nodeClientOver(node.call, node.catalog), drafter(agent), log, rules())
    node.thread('th1')
    node.inbound('th1', 'are you free on Tuesday?')
    await responder.onMessage('th1')
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await responder.reconcile()
    expect(node.sent).toEqual([])
    expect(options).toHaveLength(MAX_ATTEMPTS)
    const failed = log.lines.filter((l) => l.code === 'attempt_failed' || l.code === 'gave_up')
    expect(failed.map((l) => [l.code, l.fields?.reason])).toEqual([
      ...Array.from({ length: MAX_ATTEMPTS - 1 }, () => ['attempt_failed', 'draft:truncated']),
      ['gave_up', 'draft:truncated'],
    ])
  })
})
