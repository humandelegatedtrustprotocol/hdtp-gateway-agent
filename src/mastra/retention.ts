// How long Studio's Observability pages keep what they show. Traces and log lines are held in the
// process's memory only (InMemoryStore): nothing is written to disk, and a restart empties them.
// Between restarts a sweep keeps the last KEEP_MS of them and deletes the rest.

import type { MastraCompositeStore } from '@mastra/core/storage'
import type { Log } from '../hdtp/log.ts'

/** What the Observability pages keep: the last 24 hours. */
export const KEEP_MS = 24 * 60 * 60 * 1000
/** How often the sweep runs. */
export const SWEEP_MS = 60 * 1000
/** Traces deleted per listing; the sweep lists again until none is older than KEEP_MS. */
const PAGE = 100

/**
 * Deletes every trace that started more than KEEP_MS before `now`, and with it every log line,
 * metric and score that names the trace. Returns how many traces it deleted.
 */
export async function sweep(storage: MastraCompositeStore, now: number): Promise<number> {
  const observability = await storage.getStore('observability')
  if (!observability) return 0
  const before = new Date(now - KEEP_MS)
  const deleted = new Set<string>()
  for (;;) {
    const { spans } = await observability.listTraces({
      filters: { startedAt: { end: before, endExclusive: true } },
      pagination: { page: 0, perPage: PAGE },
    })
    const traceIds = spans.map((s) => s.traceId).filter((id) => !deleted.has(id))
    // A trace listed again after its deletion would list forever: stop at the first page with no new one.
    if (traceIds.length === 0) return deleted.size
    await observability.batchDeleteTraces({ traceIds })
    for (const id of traceIds) deleted.add(id)
  }
}

/** Sweeps every SWEEP_MS; the function returned stops it. */
export function startSweep(storage: MastraCompositeStore, log: Log, now: () => number = Date.now): () => void {
  const timer = setInterval(() => {
    sweep(storage, now()).catch(() => log.warn('observability_sweep_failed'))
  }, SWEEP_MS).unref()
  return () => clearInterval(timer)
}
