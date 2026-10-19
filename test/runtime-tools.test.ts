// startRuntime against a node whose ask_owner the MCP client skips (an input schema past its node
// limit): the runtime refuses at start, naming the tool and the reason, and reads nothing. A file of
// its own, because a process starts one runtime and this one is left started.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@mastra/core/agent'
import { afterAll, describe, expect, it } from 'vitest'
import { readConfig } from '../src/hdtp/config.ts'
import { startRuntime } from '../src/hdtp/runtime.ts'
import { FakeNode, memoryLog } from './fakes.ts'
import { TOKEN, listedWith, serve, wideSchema } from './wire.ts'

describe('a runtime started against a node offering an unusable ask_owner', () => {
  const node = new FakeNode()
  let close = () => Promise.resolve()
  let stop = () => {}
  afterAll(() => {
    stop()
    return close()
  })

  it('refuses at start with tools_missing, the tool and the reason, before any thread is read', async () => {
    node.trust.set('fpr-contact', 'may_instruct')
    node.thread('th1')
    node.inbound('th1', 'shall we book Wednesday?', 'agent')
    const { server, url } = await serve(node, 0, listedWith('ask_owner', wideSchema(10_001)))
    close = () => {
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    }
    let drafts = 0
    const agent = { generate: async () => (drafts++, { text: '{"type":"none"}' }) } as unknown as Agent
    const log = memoryLog()
    const config = readConfig({
      HDTP_OWNER_MCP_URL: url,
      HDTP_OWNER_TOKEN: TOKEN,
      HDTP_RECONCILE_SECONDS: '1',
      HDTP_AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), 'hdtp-agent-data-')),
    })
    stop = startRuntime(config, agent, log)
    for (let i = 0; i < 100 && !log.lines.some((l) => l.code === 'tools_missing'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(log.lines.find((l) => l.code === 'tools_missing')?.fields).toEqual({
      tools: 'ask_owner',
      skipped: 'ask_owner:schema_too_large',
    })
    // Idle: past the reconcile interval, nothing was listed, read or drafted, and no wait was held.
    await new Promise((r) => setTimeout(r, 1500))
    expect(node.calls).toEqual([])
    expect(node.waits).toEqual([])
    expect(drafts).toBe(0)
    expect(log.lines.filter((l) => l.code === 'tools_missing')).toHaveLength(1)
  })
})
