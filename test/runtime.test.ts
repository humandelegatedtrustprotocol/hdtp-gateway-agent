import { describe, expect, it } from 'vitest'
import { receive } from '../src/hdtp/runtime.ts'

describe('the webhook route in a process that started no runtime', () => {
  it('refuses with 503 not_started', async () => {
    const res = await receive(new Request('http://agent/hdtp/webhook', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ code: 'not_started' })
  })
})
