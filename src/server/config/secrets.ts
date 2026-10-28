import { readFileSync } from 'node:fs'

const PLACEHOLDER = /^CHANGE_?ME/i
const HEX = /^[0-9a-f]+$/i
const MIN_SECRET_BYTES = 32

// Docker secrets, Kubernetes secret volumes and systemd LoadCredential= all
// deliver secrets as files, so every secret var accepts a NAME_FILE variant.
export function readSecret(name: string, env: NodeJS.ProcessEnv, errors: string[]): string {
  const direct = env[name]
  const filePath = env[`${name}_FILE`]

  if (direct && filePath) {
    errors.push(`${name} and ${name}_FILE are both set; set only one`)
    return ''
  }
  // Trimmed like file content, so moving a secret between env and file never changes its bytes.
  if (!filePath) return direct?.trim() ?? ''

  let content: string
  try {
    content = readFileSync(filePath, 'utf8').trim()
  } catch (err) {
    errors.push(`${name}_FILE could not be read (${filePath}): ${(err as Error).message}`)
    return ''
  }
  if (!content) errors.push(`${name}_FILE is empty (${filePath})`)
  return content
}

// Hex secrets must carry 32 bytes of entropy (64 chars); free-form strings
// need 32 chars. Anything shorter is too weak to be a session or data key.
export function validateStrongSecret(name: string, value: string, errors: string[]): void {
  if (PLACEHOLDER.test(value)) {
    errors.push(`${name} is still a placeholder value; generate a real secret`)
    return
  }
  const minChars = HEX.test(value) ? MIN_SECRET_BYTES * 2 : MIN_SECRET_BYTES
  if (value.length < minChars) {
    errors.push(
      `${name} is too short: need at least ${MIN_SECRET_BYTES} bytes (${minChars} characters)`,
    )
  }
}
