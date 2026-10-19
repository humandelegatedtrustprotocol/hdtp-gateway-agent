// Drafts per contact per hour. A peer's messages carry the sender label the peer claims, so the
// agent-turn cap (responder.ts, agentTurns) stops two honest agents and not one that labels its own
// messages 'human'. This bound reads no label: every draft for a contact counts, whatever the thread
// or the request it answers, and whether or not it was sent.
//
// Held in memory: a restart starts every contact's count again.

import { Bounded } from './bounded.ts'

/** The window the budget counts over, in seconds. */
export const BUDGET_WINDOW_SECONDS = 3600
/** How many contacts' counts are kept before the oldest is forgotten. */
export const BUDGETED_CONTACTS = 10_000

export class Budget {
  /** The times (unix seconds) of each contact's drafts inside the window, oldest first. */
  private readonly drafts = new Bounded<number[]>(BUDGETED_CONTACTS)
  private readonly limit: number
  private readonly now: () => number

  constructor(limit: number, now: () => number) {
    this.limit = limit
    this.now = now
  }

  /** The drafts of a contact still inside the window. */
  private live(key: string): number[] {
    const since = this.now() - BUDGET_WINDOW_SECONDS
    return (this.drafts.get(key) ?? []).filter((t) => t > since)
  }

  /** Whether a contact has a draft left in the window. */
  room(key: string): boolean {
    return this.live(key).length < this.limit
  }

  /** Counts one draft for a contact; false, counting nothing, when none is left. */
  take(key: string): boolean {
    const live = this.live(key)
    if (live.length >= this.limit) return false
    live.push(this.now())
    this.drafts.set(key, live)
    return true
  }
}
