// The runtime logs the receiver's counts of the hits it gave no span, once a minute at most. A file of
// its own, because a process starts one runtime and this one runs on a faked interval.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@mastra/core/agent'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { readConfig } from '../src/hdtp/config.ts'
import { receive, startRuntime } from '../src/hdtp/runtime.ts'
import { UNTRACED_EVERY_MS } from '../src/hdtp/webhook.ts'
import { memoryLog } from './fakes.ts'

describe("a started runtime's count of untraced hits", () => {
  afterAll(() => vi.useRealTimers())

  it('logs the counts once per UNTRACED_EVERY_MS, only when there are any, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const log = memoryLog()
    // No owner token: the runtime stays idle, and its receiver still answers.
    const config = readConfig({
      HDTP_WEBHOOK_SECRET: 'whsec_x',
      HDTP_AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), 'hdtp-agent-data-')),
    })
    const stop = startRuntime(config, {} as Agent, log)
    const untraced = () => log.lines.filter((l) => l.code === 'webhook_untraced').map((l) => l.fields)
    for (let i = 0; i < 3; i++) {
      const res = await receive(new Request('http://agent/hdtp/webhook', { method: 'POST', body: '{}' }))
      expect(res.status).toBe(401)
    }
    vi.advanceTimersByTime(UNTRACED_EVERY_MS - 1)
    expect(untraced()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(untraced()).toEqual([{ bad_signature: 3 }])
    vi.advanceTimersByTime(UNTRACED_EVERY_MS)
    expect(untraced()).toHaveLength(1)

    await receive(new Request('http://agent/hdtp/webhook', { method: 'POST', body: '{}' }))
    stop()
    vi.advanceTimersByTime(UNTRACED_EVERY_MS)
    expect(untraced()).toHaveLength(1)
  })
})
