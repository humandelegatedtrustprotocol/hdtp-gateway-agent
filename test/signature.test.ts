import { describe, expect, it } from 'vitest'
import { TOLERANCE_SECONDS, parseSignatureHeader, verifySignature } from '../src/hdtp/signature.ts'
import { envelope, sign } from './fakes.ts'

const secret = 'whsec_current'
const old = 'whsec_previous'
const now = 1_760_000_000
const body = envelope('evt_1', 'message.received', { thread_id: 'th1' })
const bytes = (s: string) => new TextEncoder().encode(s)

describe('the signature a delivery carries', () => {
  it('accepts a good one', () => {
    expect(verifySignature(secret, bytes(body), sign([secret], body, now), now)).toBe(true)
  })

  it('refuses one made with another secret', () => {
    expect(verifySignature(secret, bytes(body), sign(['whsec_other'], body, now), now)).toBe(false)
  })

  it('refuses a body changed after signing', () => {
    const header = sign([secret], body, now)
    const forged = body.replace('th1', 'th2')
    expect(verifySignature(secret, bytes(forged), header, now)).toBe(false)
  })

  it('refuses a timestamp outside the tolerance, either way, and accepts one at its edge', () => {
    const t = now - TOLERANCE_SECONDS
    expect(verifySignature(secret, bytes(body), sign([secret], body, t), now)).toBe(true)
    expect(verifySignature(secret, bytes(body), sign([secret], body, t - 1), now)).toBe(false)
    expect(verifySignature(secret, bytes(body), sign([secret], body, now + TOLERANCE_SECONDS + 1), now)).toBe(false)
  })

  it('refuses a captured delivery replayed later, and one whose timestamp was rewritten to pass', () => {
    const captured = sign([secret], body, now)
    expect(verifySignature(secret, bytes(body), captured, now + TOLERANCE_SECONDS + 1)).toBe(false)
    const later = now + 3600
    const rewritten = captured.replace(`t=${now}`, `t=${later}`)
    expect(verifySignature(secret, bytes(body), rewritten, later)).toBe(false)
  })

  it('accepts a rotation header under either of its two secrets, and neither under a third', () => {
    const header = sign([secret, old], body, now)
    expect(parseSignatureHeader(header)?.signatures).toHaveLength(2)
    expect(verifySignature(secret, bytes(body), header, now)).toBe(true)
    expect(verifySignature(old, bytes(body), header, now)).toBe(true)
    expect(verifySignature('whsec_third', bytes(body), header, now)).toBe(false)
  })

  it('refuses a header that is not one', () => {
    const good = sign([secret], body, now)
    const v1 = good.split('v1=')[1] ?? ''
    for (const header of [
      undefined,
      '',
      `v1=${v1}`, // no timestamp
      `t=${now}`, // no signature
      `t=${now},v1=${v1.slice(2)}`, // short
      `t=${now},v1=${v1.toUpperCase()}`, // not lower-case hex
      `t=${now}.5,v1=${v1}`, // not whole seconds
      `t=abc,v1=${v1}`,
    ]) {
      expect(verifySignature(secret, bytes(body), header, now), String(header)).toBe(false)
    }
  })
})
