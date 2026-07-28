import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * SSH key discovery & generation for the Remote view.
 *
 * SECURITY: This module NEVER reads or returns private-key contents. Only paths,
 * metadata, and PUBLIC keys (.pub) ever cross to the renderer. All filesystem
 * access is constrained to ~/.ssh, filenames are validated, and ssh-keygen is
 * spawned with an argv array (no shell interpolation).
 */

export interface SshKeyInfo {
  /** Base filename of the private key (e.g. "id_ed25519"). */
  name: string
  /** Absolute path to the private key. */
  privatePath: string
  /** Absolute path to the public key, when a .pub sibling exists. */
  publicPath?: string
  /** Key type parsed from the .pub first field (e.g. "ssh-ed25519"). */
  type?: string
  /** Comment parsed from the .pub trailing field (e.g. "you@host"). */
  comment?: string
  /** Full first line of the .pub file — safe to expose (public material). */
  publicKey?: string
}

export type GenerateKeyResult = { ok: true; key: SshKeyInfo } | { ok: false; error: string }

/** Files in ~/.ssh that are never private keys. */
const NON_KEY_NAMES = new Set([
  'known_hosts',
  'known_hosts.old',
  'authorized_keys',
  'authorized_keys2',
  'config',
  'environment',
  'rc'
])

/** Common default private-key basenames, matched even without a .pub sibling. */
const COMMON_PRIVATE_NAMES = new Set(['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa'])

function sshDir(): string {
  return path.join(os.homedir(), '.ssh')
}

/** Parse `<type> <base64> [comment...]` from a .pub first line. Public data only. */
function parsePublic(line: string): { type?: string; comment?: string; publicKey?: string } {
  const publicKey = line.trim()
  if (!publicKey) return {}
  const parts = publicKey.split(/\s+/)
  const type = parts[0]
  const comment = parts.length > 2 ? parts.slice(2).join(' ') : undefined
  return { type, comment, publicKey }
}

/**
 * List key pairs in ~/.ssh. A file is treated as a private key if it either has
 * a matching `.pub` sibling or is a well-known default key name. Never reads
 * private-key contents.
 */
export function listSshKeys(): SshKeyInfo[] {
  const dir = sshDir()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  const names = new Set(entries)
  const keys: SshKeyInfo[] = []

  for (const name of entries) {
    if (name.endsWith('.pub')) continue
    if (NON_KEY_NAMES.has(name)) continue

    const privatePath = path.join(dir, name)
    try {
      if (!fs.statSync(privatePath).isFile()) continue
    } catch {
      continue
    }

    const pubName = `${name}.pub`
    const hasPub = names.has(pubName)
    if (!hasPub && !COMMON_PRIVATE_NAMES.has(name)) continue

    const info: SshKeyInfo = { name, privatePath }
    if (hasPub) {
      const publicPath = path.join(dir, pubName)
      info.publicPath = publicPath
      try {
        const firstLine = fs.readFileSync(publicPath, 'utf-8').split('\n')[0]
        Object.assign(info, parsePublic(firstLine))
      } catch {
        // .pub unreadable — keep the pair with just the path.
      }
    }
    keys.push(info)
  }

  keys.sort((a, b) => a.name.localeCompare(b.name))
  return keys
}

/** Guard: resolve a path and confirm it lives directly inside ~/.ssh. */
function isInsideSshDir(target: string): boolean {
  const dir = path.resolve(sshDir())
  const resolved = path.resolve(target)
  return path.dirname(resolved) === dir
}

/**
 * Return the public-key text for a discovered key. `privatePath` must resolve
 * inside ~/.ssh. Returns the .pub first line (public material) or null.
 */
export function readPublicKey(privatePath: string): string | null {
  if (!isInsideSshDir(privatePath)) return null
  const pub = `${privatePath}.pub`
  try {
    return fs.readFileSync(pub, 'utf-8').split('\n')[0].trim() || null
  } catch {
    return null
  }
}

/**
 * Generate a new ed25519 key pair in ~/.ssh via ssh-keygen. The filename is
 * validated to [A-Za-z0-9_-]+, the target dir is always ~/.ssh, and an existing
 * file is never overwritten. ssh-keygen is spawned with an argv array.
 */
export function generateKey(name: string, comment?: string): Promise<GenerateKeyResult> {
  return new Promise((resolve) => {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      return resolve({ ok: false, error: 'Key name may only contain letters, numbers, "_" and "-".' })
    }

    const dir = sshDir()
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      // If it already exists this throws nothing; other failures surface below.
    }

    const target = path.join(dir, name)
    if (fs.existsSync(target) || fs.existsSync(`${target}.pub`)) {
      return resolve({ ok: false, error: `A key named "${name}" already exists in ~/.ssh.` })
    }

    const cleanComment = (comment && comment.trim()) || `argos@${os.hostname()}`
    const args = ['-t', 'ed25519', '-f', target, '-N', '', '-C', cleanComment]

    let child
    try {
      child = spawn('ssh-keygen', args, { windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }

    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        error:
          e.code === 'ENOENT'
            ? 'ssh-keygen not found. Install OpenSSH client and try again.'
            : e.message
      })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        return resolve({ ok: false, error: stderr.trim() || `ssh-keygen exited with code ${code}.` })
      }
      const info: SshKeyInfo = { name, privatePath: target }
      const pubPath = `${target}.pub`
      if (fs.existsSync(pubPath)) {
        info.publicPath = pubPath
        try {
          const firstLine = fs.readFileSync(pubPath, 'utf-8').split('\n')[0]
          Object.assign(info, parsePublic(firstLine))
        } catch {
          /* ignore */
        }
      }
      resolve({ ok: true, key: info })
    })
  })
}
