// startRuntime as src/mastra/index.ts calls it: the configuration reaches the responder. A file of
// its own, because a process starts one runtime and this one is left started.

import type { Agent } from '@mastra/core/agent'
import { afterAll, describe, expect, it } from 'vitest'
import { readConfig } from '../src/hdtp/config.ts'
import { startRuntime } from '../src/hdtp/runtime.ts'
import { FakeNode, memoryLog } from './fakes.ts'
import { TOKEN, serve } from './wire.ts'

describe('a started runtime', () => {
  const node = new FakeNode()
  let close = () => Promise.resolve()
  afterAll(() => close())

  it('stops at the HDTP_AGENT_TURN_CAP it was configured with', async () => {
    node.thread('th1')
    node.inbound('th1', 'their agent', 'agent')
    node.outbound('th1', 'our agent', 'agent')
    node.inbound('th1', 'their agent again', 'agent')
    const { server, url } = await serve(node)
    close = () => new Promise<void>((r) => server.close(() => r()))
    let drafts = 0
    const agent = { generate: async () => (drafts++, { text: 'reply' }) } as unknown as Agent
    const log = memoryLog()
    const config = readConfig({ HDTP_OWNER_MCP_URL: url, HDTP_OWNER_TOKEN: TOKEN, HDTP_AGENT_TURN_CAP: '1', HDTP_RECONCILE_SECONDS: '3600' })
    startRuntime(config, agent, log)
    // The sweep at start reads the thread, then stops at one turn.
    for (let i = 0; i < 100 && !log.lines.some((l) => l.code === 'agent_turn_cap'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(log.lines.find((l) => l.code === 'agent_turn_cap')?.fields).toEqual({ thread_id: 'th1', turns: 1 })
    expect(drafts).toBe(0)
    expect(node.sent).toEqual([])
  })
})
