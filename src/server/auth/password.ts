/**
 * Password hashing using argon2id via @node-rs/argon2 (prebuilt binaries — no compilation).
 * Parameters follow OWASP recommendations for argon2id (2024).
 */
import { hash, verify, Algorithm } from '@node-rs/argon2'

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,   // 64 MiB
  timeCost: 3,         // iterations
  parallelism: 4,
} as const

// Pre-computed hash of a throwaway string. Used in the login path when the
// username doesn't exist so verifyPassword always runs (preventing timing
// attacks that would reveal whether a username is registered).
export const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$zvFQmBvqPFbsnlB0BVFV8DTDO7fPlv6CKjdL+qLVq3c'

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS)
}

export async function verifyPassword(hashStr: string, plaintext: string): Promise<boolean> {
  return verify(hashStr, plaintext, ARGON2_OPTIONS)
}
