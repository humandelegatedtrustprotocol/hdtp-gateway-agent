// What Studio's Observability pages read: the entry file's Mastra instance, its store, the spans the
// runtime opens and the lines it logs in them; then the sweep that keeps the last 24 hours.
//
// The delegate is given a mock model before the entry file loads, so no model is called; its run
// against a real model and a real node was observed (see the pull request).

import type { Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Mastra } from '@mastra/core'
import { InMemoryStore, type MastraCompositeStore } from '@mastra/core/storage'
import { createMockModel } from '@mastra/core/test-utils/llm-mock'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FIRST_START_FILE } from '../src/hdtp/first-start.ts'
import { receive } from '../src/hdtp/runtime.ts'
import { SIGNATURE_HEADER } from '../src/hdtp/signature.ts'
import { observe } from '../src/mastra/observe.ts'
import { KEEP_MS, sweep } from '../src/mastra/retention.ts'
import { FakeNode, envelope, reply, sign } from './fakes.ts'
import { TOKEN, serve } from './wire.ts'

const WEBHOOK_SECRET = 'whsec_observability-test'

async function observability(storage: MastraCompositeStore | undefined) {
  const store = await storage?.getStore('observability')
  if (!store) throw new Error('no observability store')
  return store
}

type Store = Awaited<ReturnType<typeof observability>>

/** Every log line the store holds, read a listing at a time. */
async function allLogs(store: Store) {
  const logs = []
  for (let page = 0; ; page++) {
    const listed = await store.listLogs({ pagination: { page, perPage: 100 } })
    logs.push(...listed.logs)
    if (!listed.pagination?.hasMore) return logs
  }
}

async function until(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200 && !(await done()); i++) await new Promise((r) => setTimeout(r, 20))
}

describe("the entry file's Mastra instance", () => {
  const node = new FakeNode()
  let server: Server
  let mastra: Mastra
  /** What the process printed, one entry per console call. */
  const printed: string[] = []
  const saved: Record<string, string | undefined> = {}
  const store = () => observability(mastra.getStorage())
  const post = (event: string, signed = true) =>
    receive(
      new Request('http://127.0.0.1/hdtp/webhook', {
        method: 'POST',
        headers: signed ? { [SIGNATURE_HEADER]: sign([WEBHOOK_SECRET], event, Math.floor(Date.now() / 1000)) } : {},
        body: event,
      }),
    )
  /** The root span's name of each trace the stored lines with this code name. */
  const rootsOf = async (code: string) => {
    await mastra.observability.flush()
    const s = await store()
    const ids = (await allLogs(s)).filter((l) => l.message === code).map((l) => l.traceId)
    return Promise.all(ids.map(async (id) => (id ? (await s.getTrace({ traceId: id }))?.spans.find((sp) => !sp.parentSpanId)?.name : null)))
  }

  beforeAll(async () => {
    node.trust.set('fpr-contact', 'may_instruct')
    // Short holds, so a failing wait is reached at once.
    node.holdMs = 200
    let url: string
    ;({ server, url } = await serve(node))
    const dataDir = mkdtempSync(join(tmpdir(), 'hdtp-agent-data-'))
    // The fake's messages are from 2025: the first start is set before them.
    writeFileSync(join(dataDir, FIRST_START_FILE), JSON.stringify({ first_start: 1_700_000_000 }))
    const vars = {
      HDTP_OWNER_MCP_URL: url,
      HDTP_OWNER_TOKEN: TOKEN,
      HDTP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      HDTP_RECONCILE_SECONDS: '3600',
      HDTP_PERSONA_FILE: resolve('persona.md'),
      HDTP_AGENT_DATA_DIR: dataDir,
    }
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')))
    }
    // After the variables: the entry file reads its settings as it loads. The delegate first, given
    // a mock model, so the runtime the entry file starts drafts with it.
    const { delegate } = await import('../src/mastra/agents/delegate.ts')
    delegate.__updateModel({ model: createMockModel({ mockText: reply('Wednesday at three works.'), version: 'v2' }) })
    ;({ mastra } = await import('../src/mastra/index.ts'))
    // The start: the sweep's pass, and the wait loop's first pass, ended. A pass still running when
    // the hit below arrives would take the hit's thread over, and its draft with it.
    await until(async () => (await rootsOf('first_start')).length > 0 && node.waits.length >= 2)
    const ended = async (name: string) =>
      (await (await store()).listTraces({})).spans.some((t) => t.name === name && t.endedAt)
    await until(async () => (await ended('reconcile')) && (await ended('watch_pass')))
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('holds what Studio shows in memory, in a store of its own naming', () => {
    expect(mastra.getStorage()).toBeInstanceOf(InMemoryStore)
    // Mastra's fallback store, used when none is named, says at every start that it is not durable.
    expect(printed.filter((p) => p.includes('No `storage` configured'))).toEqual([])
  })

  it('exports to that store and nowhere else', () => {
    const exporters = mastra.observability.getDefaultInstance()?.getExporters() ?? []
    expect(exporters.map((e) => e.constructor.name)).toEqual(['MastraStorageExporter'])
  })

  it("keeps Mastra's own lines out of the store: they would carry no trace", async () => {
    mastra.getLogger().warn('a line of mastra_own')
    await mastra.observability.flush()
    expect((await allLogs(await store())).filter((l) => l.message.includes('mastra_own'))).toEqual([])
  })

  it("prints the runtime's lines as before, and keeps the same code and fields", async () => {
    expect(printed).toContain(JSON.stringify({ level: 'info', code: 'first_start', first_start: 1_700_000_000 }))
    const logs = await allLogs(await store())
    expect(logs.find((l) => l.message === 'first_start')).toMatchObject({ level: 'info', data: { first_start: 1_700_000_000 } })
  })

  it('keeps a webhook hit as one trace: its lines, the agent run and its model call', async () => {
    // A message recorded without a change, so the wait loop is not woken by it: the hit's task answers it.
    node.thread('th-obs')
    node.threads.get('th-obs')!.messages.push({
      direction: 'in',
      sender: 'human',
      kind: 'text',
      body: 'Can we meet this week?',
      trust: 'messages_only',
      message_id: 'msg-obs',
      created_at: 1_760_000_100,
    })
    expect((await post(envelope('evt_hit', 'message.received', { thread_id: 'th-obs' }))).status).toBe(202)
    await until(() => node.sent.length === 1)
    expect(node.sent[0]?.text).toBe('Wednesday at three works.')
    const s = await store()
    let trace: Awaited<ReturnType<typeof s.getTrace>> = null
    await until(async () => {
      await mastra.observability.flush()
      const accepted = (await allLogs(s)).find((l) => l.message === 'webhook_accepted')
      trace = accepted?.traceId ? await s.getTrace({ traceId: accepted.traceId }) : null
      return !!trace?.spans.find((sp) => !sp.parentSpanId)?.endedAt
    })
    const root = trace!.spans.find((sp) => !sp.parentSpanId)
    expect(root?.name).toBe('webhook')
    const types = trace!.spans.map((sp) => sp.spanType)
    expect(types).toContain('agent_run')
    expect(types).toContain('model_generation')
    const lines = (await allLogs(s)).filter((l) => l.traceId === root!.traceId).map((l) => l.message)
    expect(lines.sort()).toEqual(['replied', 'webhook_accepted'])
  })

  it('keeps a signed hit that draws no model call as a trace of its own', async () => {
    const event = envelope('evt_observability', 'message.delivered', {})
    expect((await post(event)).status).toBe(200)
    await mastra.observability.flush()
    const ignored = (await allLogs(await store())).find((l) => l.message === 'webhook_ignored')
    expect(ignored).toMatchObject({ level: 'info', data: { event_id: 'evt_observability', type: 'message.delivered' } })
    expect(await rootsOf('webhook_ignored')).toEqual(['webhook'])
  })

  it('keeps nothing of a hit refused before its delivery is verified and new', async () => {
    const s = await store()
    // The webhook's traces and lines only: the wait loops' passes go on meanwhile.
    const kept = async () => {
      await mastra.observability.flush()
      const traces = (await s.listTraces({})).spans.filter((t) => t.name === 'webhook')
      const logs = (await allLogs(s)).filter((l) => l.message.startsWith('webhook'))
      return { traces: traces.length, logs: logs.length }
    }
    const before = await kept()
    const event = envelope('evt_unkept', 'message.delivered', {})
    // Unsigned, a body that cannot be read, and a signed delivery posted again.
    expect((await post(event, false)).status).toBe(401)
    const body = new ReadableStream({ pull: (c) => c.error(new Error('what a contact wrote')) })
    const unreadable = new Request('http://127.0.0.1/hdtp/webhook', { method: 'POST', body, duplex: 'half' } as RequestInit)
    expect((await receive(unreadable)).status).toBe(400)
    expect((await post(event)).status).toBe(200)
    expect((await post(event)).status).toBe(200)
    // The first signed post is a trace with its line; the three others, nothing.
    expect(await kept()).toEqual({ traces: before.traces + 1, logs: before.logs + 1 })
  })

  it('marks a span whose work failed as an error, by its code and never its text', async () => {
    const { trace } = observe(mastra)
    await expect(trace('failing_pass', () => Promise.reject(new Error('what a contact wrote')))).rejects.toThrow()
    await mastra.observability.flush()
    const s = await store()
    const failed = (await s.listTraces({})).spans.filter((t) => t.name === 'failing_pass')
    expect(failed.map((t) => [t.status, t.error])).toEqual([['error', { message: 'unexpected', name: 'Error' }]])
    const stored = JSON.stringify(await s.getTrace({ traceId: failed[0]!.traceId }))
    expect(stored).not.toContain('what a contact wrote')
  })

  it('runs each reconcile pass and each wait loop pass in a span of its own', async () => {
    const names = (await (await store()).listTraces({})).spans.map((t) => t.name)
    expect(names).toContain('reconcile')
    expect(names).toContain('watch_pass')
  })

  it('gives a line logged outside any open span a span of its own', async () => {
    // The start's one line, and a wait loop's: the loop runs in the context of the sweep that started
    // it, whose span has ended.
    expect(await rootsOf('first_start')).toEqual(['first_start'])
    node.failing.add('wait_for_updates')
    await until(async () => (await rootsOf('watch_failed')).length > 0)
    node.failing.delete('wait_for_updates')
    expect(new Set(await rootsOf('watch_failed'))).toEqual(new Set(['watch_failed']))
  })

  it('gives every line it keeps a trace, so the sweep deletes them all', async () => {
    await mastra.observability.flush()
    const logs = await allLogs(await store())
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.filter((l) => !l.traceId).map((l) => l.message)).toEqual([])
  })
})

describe('the sweep', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.UTC(2026, 9, 19, 12)
  const at = (ms: number) => new Date(ms)

  /** A store with one trace of one span started at `startedAt`, and a log line naming it. */
  async function storeWith(traces: Record<string, number>) {
    const storage = new InMemoryStore()
    await storage.init()
    const store = await observability(storage)
    for (const [traceId, startedAt] of Object.entries(traces)) {
      await store.batchCreateSpans({
        records: [
          {
            traceId,
            spanId: `span-${traceId}`,
            parentSpanId: null,
            name: "agent run: 'delegate'",
            spanType: 'agent_run',
            isEvent: false,
            startedAt: at(startedAt),
            endedAt: at(startedAt + 1000),
          } as never,
        ],
      })
      await store.batchCreateLogs({
        logs: [{ logId: `log-${traceId}`, timestamp: at(startedAt), level: 'info', message: 'replied', traceId, data: {} } as never],
      })
    }
    return { storage, store }
  }

  const traceIds = async (store: Store) =>
    (await store.listTraces({})).spans.map((s) => s.traceId).sort()
  const logIds = async (store: Store) =>
    (await store.listLogs({})).logs.map((l) => l.logId).sort()

  it('keeps 24 hours', () => {
    expect(KEEP_MS).toBe(DAY)
  })

  it('deletes a trace older than 24 hours, and the log lines that name it', async () => {
    const { storage, store } = await storeWith({ old: now - DAY - 1000, young: now - DAY + 60_000 })
    expect(await sweep(storage, now)).toBe(1)
    expect(await traceIds(store)).toEqual(['young'])
    expect(await logIds(store)).toEqual(['log-young'])
  })

  it('keeps a trace exactly 24 hours old, and one under', async () => {
    const { storage, store } = await storeWith({ edge: now - DAY, young: now - 1000 })
    expect(await sweep(storage, now)).toBe(0)
    expect(await traceIds(store)).toEqual(['edge', 'young'])
  })

  it('deletes more than one listing of old traces in one sweep', async () => {
    const old = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`old-${String(i).padStart(3, '0')}`, now - DAY - 1000 - i]))
    const { storage, store } = await storeWith({ ...old, young: now })
    expect(await sweep(storage, now)).toBe(250)
    expect(await traceIds(store)).toEqual(['young'])
  })
})
