// End-to-end encryption for the pairing relay. The QR carries a secret the
// relay never sees (it travels desktop screen → phone camera); both ends
// derive an AES-256-GCM key from it and the relay forwards ciphertext it
// cannot read. GCM authenticates too: a tampered message fails to decrypt
// instead of producing garbage.
//
// This file is mirrored byte-for-byte in the mobile app (voz-notas-app,
// mobile/src/crypto.ts) — keep them in sync until core/ is a shared package.

import { gcm } from '@noble/ciphers/aes.js'
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'

// The encrypted envelope that replaces plaintext protocol messages on the
// wire. `presence` (relay-originated) stays plaintext — the relay must be
// able to write it, and it carries no user data.
export interface EncEnvelope {
  type: 'enc'
  iv: string // base64, 12 bytes, fresh per message — NEVER reused per key
  data: string // base64 ciphertext + GCM tag
}

// Manual base64: btoa/atob are not guaranteed on React Native's Hermes.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let n = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

// A fresh pairing secret (256 bits) for the QR.
export function newSecret(): string {
  return toBase64(randomBytes(32))
}

// HKDF instead of the raw secret: cheap, and leaves room to rotate or derive
// per-direction keys later without changing the QR format.
export function deriveKey(secretB64: string): Uint8Array {
  return hkdf(sha256, fromBase64(secretB64), undefined, utf8ToBytes('voz-notas-remote-v1'), 32)
}

export function encryptEnvelope(key: Uint8Array, payload: object): EncEnvelope {
  const iv = randomBytes(12)
  const data = gcm(key, iv).encrypt(utf8ToBytes(JSON.stringify(payload)))
  return { type: 'enc', iv: toBase64(iv), data: toBase64(data) }
}

// Returns null on any failure (wrong key, tampering, malformed input).
export function decryptEnvelope<T>(key: Uint8Array, env: EncEnvelope): T | null {
  try {
    const plain = gcm(key, fromBase64(env.iv)).decrypt(fromBase64(env.data))
    return JSON.parse(bytesToUtf8(plain)) as T
  } catch {
    return null
  }
}
