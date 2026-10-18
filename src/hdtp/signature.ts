// Verifying the node's webhook signature.
//
//   X-HDTP-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>]
//
// The node signs `<t>.<raw body>` with HMAC-SHA256 under the endpoint's signing secret, the
// grammar BatonDeck's webhooks use (gateway/src/webhooks/sign.ts). During a secret rotation the
// header carries two v1 values, the new secret's first; a delivery is accepted when either one
// verifies under the secret this receiver holds, so the owner can switch HDTP_WEBHOOK_SECRET at
// any point in the rotation window.

import { createHmac, timingSafeEqual } from 'node:crypto'

/** The header carrying the signature. */
export const SIGNATURE_HEADER = 'X-HDTP-Signature'

/** How far a delivery's timestamp may be from this host's clock, either way. */
export const TOLERANCE_SECONDS = 300

/** A signature header split into its timestamp and its v1 values. */
export interface ParsedSignature {
  timestamp: number
  signatures: string[]
}

/** Splits a header into its parts, or null when it is not one. */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (!header) return null
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') {
      // Whole seconds only: a timestamp that is not one is not a timestamp.
      if (!/^\d{1,12}$/.test(value)) return null
      timestamp = Number(value)
    } else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value)
    }
  }
  if (timestamp === null || signatures.length === 0) return null
  return { timestamp, signatures }
}

/** HMAC-SHA256 of `<t>.<body>` under the secret, as 32 bytes. */
export function signatureOf(secret: string, timestamp: number, body: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`${String(timestamp)}.`).update(body).digest()
}

/**
 * Whether a delivery is the node's: a well-formed header, a timestamp inside the tolerance, and a
 * v1 value equal to the HMAC of the raw bytes under `secret`, compared in constant time.
 */
export function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | null | undefined,
  nowSeconds: number,
): boolean {
  const parsed = parseSignatureHeader(header)
  if (!parsed) return false
  if (Math.abs(nowSeconds - parsed.timestamp) > TOLERANCE_SECONDS) return false
  const expected = signatureOf(secret, parsed.timestamp, body)
  let ok = false
  for (const given of parsed.signatures) {
    // Every value is compared, so the time taken does not say which one matched. Each is 64 hex
    // digits by the parse, so both buffers are 32 bytes and timingSafeEqual cannot throw.
    if (timingSafeEqual(expected, Buffer.from(given, 'hex'))) ok = true
  }
  return ok
}
