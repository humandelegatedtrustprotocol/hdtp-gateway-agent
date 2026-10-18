// A map that forgets its oldest entries past a size, so nothing a sender controls grows without end.

/** An insertion-ordered set that forgets its oldest entries past a size. */
export class Bounded<V> {
  private readonly map = new Map<string, V>()
  private readonly limit: number
  constructor(limit: number) {
    this.limit = limit
  }
  get(k: string): V | undefined {
    return this.map.get(k)
  }
  has(k: string): boolean {
    return this.map.has(k)
  }
  set(k: string, v: V): void {
    this.map.delete(k)
    this.map.set(k, v)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
  delete(k: string): void {
    this.map.delete(k)
  }
}
