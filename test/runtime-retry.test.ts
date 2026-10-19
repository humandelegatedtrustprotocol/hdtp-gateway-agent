// startRuntime against a node whose first list_accounts fails: the sweep is tried again after the
// watcher's backoff, not at the next interval, so the loops start as soon as the node answers. A
// file of its own, because a process starts one runtime and this one is left started.

import type { Agent } from '@mastra/core/agent'
import { afterAll, describe, expect, it } from 'vitest'
import { readConfig } from '../src/hdtp/config.ts'
import { startRuntime } from '../src/hdtp/runtime.ts'
import { FakeNode, memoryLog } from './fakes.ts'
import { TOKEN, serve } from './wire.ts'

describe('a runtime started while the node refuses', () => {
  const node = new FakeNode()
  let close = () => Promise.resolve()
  let stop = () => {}
  afterAll(() => {
    stop()
    return close()
  })

  it('starts its loops once a retried sweep lists the accounts', async () => {
    const { server, url } = await serve(node)
    close = () => {
      server.closeAllConnections()
      return new Promise<void>((r) => server.close(() => r()))
    }
    node.failing.add('list_accounts')
    const agent = { generate: async () => ({ text: 'reply' }) } as unknown as Agent
    const log = memoryLog()
    stop = startRuntime(readConfig({ HDTP_OWNER_MCP_URL: url, HDTP_OWNER_TOKEN: TOKEN, HDTP_RECONCILE_SECONDS: '3600' }), agent, log)
    for (let i = 0; i < 100 && !log.lines.some((l) => l.code === 'reconcile_failed'); i++) await new Promise((r) => setTimeout(r, 20))
    node.failing.delete('list_accounts')
    // The first retry comes after one second.
    for (let i = 0; i < 150 && node.waits.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(node.calls.filter((c) => c === 'list_accounts')).toHaveLength(2)
    expect(node.waits[0]).toEqual({ account: 'acct-1', since: undefined })
  })
})
