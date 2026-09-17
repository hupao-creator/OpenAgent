import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const utf8 = new TextEncoder()

/** Synchronous, process-neutral digest of a domain and length-delimited parts. */
export function opaqueIdentifierDigest(domain: string, parts: readonly string[]): string {
  const hash = sha256.create().update(utf8.encode(domain))
  for (const part of parts) {
    const bytes = utf8.encode(part)
    hash.update(utf8.encode(`${bytes.byteLength}:`)).update(bytes)
  }
  return bytesToHex(hash.digest())
}
