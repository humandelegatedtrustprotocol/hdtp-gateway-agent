// The time the agent first started, kept across restarts. Messages from before it are the owner's
// backlog and are left to the owner (responder.ts); only what arrives after it is answered.
//
// It is kept in FIRST_START_FILE in the data directory (HDTP_AGENT_DATA_DIR), as
// {"first_start": <unix seconds>}. The first start writes it; every later start reads it back.
// Deleting the file makes the next start count as the first. The file is written whole under
// another name and linked into place, which fails if the file is there already, so two processes
// started together keep one time between them.

import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const FIRST_START_FILE = 'first-start.json'

/** The file could not be read as a first-start time: the agent answers nothing until it is fixed. */
export class FirstStartUnreadable extends Error {
  constructor() {
    super('first_start_unreadable')
  }
}

/**
 * The data directory as a path. A relative one is taken from where the agent was started, as the
 * persona file is (src/mastra/agents/delegate.ts): npm and npx record that as INIT_CWD.
 */
export function dataDirPath(dir: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), dir)
}

/** The first-start time in the data directory, written as `now` (unix seconds) if there is none. */
export function firstStart(dir: string, now: number): number {
  const root = dataDirPath(dir)
  mkdirSync(root, { recursive: true })
  const path = join(root, FIRST_START_FILE)
  const fresh = `${path}.${process.pid}.tmp`
  writeFileSync(fresh, `${JSON.stringify({ first_start: now })}\n`)
  try {
    linkSync(fresh, path)
    return now
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  } finally {
    unlinkSync(fresh)
  }
  let kept: unknown
  try {
    kept = (JSON.parse(readFileSync(path, 'utf8')) as { first_start?: unknown } | null)?.first_start
  } catch {
    throw new FirstStartUnreadable()
  }
  if (typeof kept !== 'number' || !Number.isInteger(kept) || kept <= 0) throw new FirstStartUnreadable()
  return kept
}
