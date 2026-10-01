/**
 * The ops gate (docs/OPS_AGENT_PLAN.md §3): every `mcp__ops__*` call passes through
 * `classify` before anything touches ssh2. Pure — no electron, no fs, no I/O — so the
 * adversarial suite beside it is the acceptance test for the whole feature.
 *
 * Fail closed everywhere. Any doubt is a deny whose reason names the token, because a
 * deny the user can read is cheap and an allow nobody meant is not. The function never
 * throws: a malformed policy or input becomes a deny, not a crash that a caller might
 * catch and treat as "no objection".
 *
 * Allow rules are matched against `canonicalCommand(argv)`, never the raw string the
 * model sent. The argv is what runs, so the decision has to depend on the argv alone:
 * matched on the raw string, `tail -n 100 '/var/log/x.log'` and `tail -n 100 /var/log/x.log`
 * would pass or fail depending on how the model happened to quote the same command.
 */
import * as path from 'path'
import type { OpsApproval, OpsClass, OpsGateResult, OpsHostRef, OpsPolicy, OpsToolInput } from './ops-types'
import { isSafeRemotePath } from './sftp-pure'

/** Longest command line the parser will look at; a 10 KB "command" is not a command. */
export const OPS_MAX_COMMAND_LENGTH = 4096
/** Longest path read/list/write accept. */
export const OPS_MAX_PATH_LENGTH = 1024
/** Largest `write` content, in UTF-8 bytes. */
export const OPS_MAX_WRITE_BYTES = 1_000_000

export type ParseResult = { ok: true; argv: string[] } | { ok: false; reason: string }

// ─── Characters ──────────────────────────────────────────────────────────────────

/** `U+000A`-style label so a reason names an invisible character unambiguously. */
function codepoint(ch: string): string {
  return 'U+' + (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')
}

/**
 * Characters that are invisible, reorder text, or look like a space. They are rejected
 * because the approval modal must show exactly what runs: a bidi override or a
 * non-breaking space can make `rm -rf /` render as something harmless.
 */
const DECEPTIVE = /[\u0080-\u009f\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u2060-\u206f\u3000\ufeff]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Reason the string carries a control or deceptive character, or null. Tab is a control. */
function badCharReason(s: string, what: string): string | null {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || c === 0x7f) {
      const named = c === 0x0a ? ' (\\n)' : c === 0x0d ? ' (\\r)' : c === 0x09 ? ' (tab)' : c === 0 ? ' (NUL)' : ''
      return `${what} contains control character ${codepoint(ch)}${named}`
    }
    if (DECEPTIVE.test(ch)) return `${what} contains invisible or space-like character ${codepoint(ch)}`
  }
  if (LONE_SURROGATE.test(s)) return `${what} contains a lone surrogate (malformed unicode)`
  return null
}

// ─── First-word rules ────────────────────────────────────────────────────────────

/**
 * Commands that run another command (or a shell). Composition is a runbook script's job;
 * a wrapper would let a narrow-looking rule front for anything.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  'eval', 'exec', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish',
  'ash', 'mksh', 'rbash', 'busybox', 'pwsh', 'env', 'nohup', 'xargs', 'time', 'command',
  'builtin', 'nice', 'ionice', 'timeout', 'watch', 'script', 'ssh', 'scp', 'sftp', 'rsync',
  'su', 'doas', 'pkexec', 'runuser', 'sudoedit', 'setsid', 'stdbuf', 'chroot', 'systemd-run',
  'flock', 'unbuffer', 'at', 'batch', 'strace', 'ltrace', 'parallel', 'tmux', 'screen',
  // Shell reserved words: once quoted by shellJoin they stop being keywords, so a line
  // starting with one never means what it reads as.
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until',
  'do', 'done', 'function', 'coproc'
])

/** sudo flags that take no value. Anything else (`-i`, `-s`, `-E`, `-e`, `-D` …) is refused. */
const SUDO_BARE = new Set(['n', 'S', 'H'])
/** sudo flags that take one value. */
const SUDO_VALUED = new Set(['u', 'g', 'p'])
const SUDO_LONG_BARE = new Set(['--non-interactive', '--stdin', '--set-home'])
const SUDO_LONG_VALUED = new Set(['--user', '--group', '--prompt'])

/** Index of the command word after `sudo` and its flags, or a reason. argv[0] must be sudo. */
function sudoCommandIndex(argv: string[]): { ok: true; index: number } | { ok: false; reason: string } {
  let i = 1
  while (i < argv.length) {
    const w = argv[i]
    if (w === '--') {
      i++
      break
    }
    if (!w.startsWith('-') || w === '-') break
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = eq === -1 ? w : w.slice(0, eq)
      if (SUDO_LONG_BARE.has(name) && eq === -1) {
        i++
        continue
      }
      if (SUDO_LONG_VALUED.has(name)) {
        if (eq !== -1) i++
        else if (i + 1 < argv.length) i += 2
        else return { ok: false, reason: `sudo flag '${w}' is missing its value` }
        continue
      }
      return { ok: false, reason: `sudo flag '${w}' is not allowed` }
    }
    // A short cluster: bare letters, optionally ending in one valued letter (`-nu root`, `-upostgres`).
    let j = 1
    let consumedNext = false
    while (j < w.length) {
      const f = w[j]
      if (SUDO_BARE.has(f)) {
        j++
        continue
      }
      if (SUDO_VALUED.has(f)) {
        if (j + 1 < w.length) j = w.length
        else if (i + 1 < argv.length) {
          consumedNext = true
          j = w.length
        } else return { ok: false, reason: `sudo flag '-${f}' is missing its value` }
        break
      }
      return { ok: false, reason: `sudo flag '-${f}' is not allowed` }
    }
    i += consumedNext ? 2 : 1
  }
  if (i >= argv.length) return { ok: false, reason: `'sudo' without a command` }
  return { ok: true, index: i }
}

/** Reason this word cannot be the command, or null. Applied to argv[0] and to sudo's target. */
function commandWordReason(w: string): string | null {
  if (w === '') return 'the command word is empty'
  if (w.includes('=')) return `'${w}' looks like an environment assignment (VAR=…) prefix`
  if (w.includes('/') && !w.startsWith('/')) return `relative command path '${w}' is not allowed; use an absolute path`
  const base = path.posix.basename(w)
  if (WRAPPERS.has(w) || WRAPPERS.has(base)) {
    return `'${w}' runs another command; put the composition in a runbook script instead`
  }
  if (base === 'sudo' && w !== 'sudo') return `call sudo by name, not as '${w}'`
  return null
}

// ─── Parser ──────────────────────────────────────────────────────────────────────

/** Unquoted characters that mean the line is more than one simple command. */
const OPERATORS: Record<string, string> = {
  ';': 'chains commands',
  '&': 'chains or backgrounds commands',
  '|': 'pipes commands',
  '`': 'is command substitution',
  '<': 'redirects input',
  '>': 'redirects output',
  '(': 'opens a subshell',
  ')': 'closes a subshell',
  '{': 'is brace expansion or grouping',
  '}': 'is brace expansion or grouping',
  '!': 'is negation or history expansion',
  '*': 'is a glob (expands on the server; quote it)',
  '?': 'is a glob (expands on the server; quote it)',
  '[': 'is a glob (expands on the server; quote it)',
  '$': 'is expansion',
  '~': 'is tilde expansion'
}

/** The longest operator token starting at i, so `&&`, `>>`, `<(`, `$(` are named whole. */
function operatorToken(s: string, i: number): string {
  const two = s.slice(i, i + 2)
  if (['&&', '||', '>>', '<<', '<(', '>(', '$(', '${', ';;', '|&', '&>', '>&', '<&', '<>'].includes(two)) {
    return s.slice(i, i + 3) === '<<<' ? '<<<' : two
  }
  return s[i]
}

/**
 * Parse one simple shell command into words. Rejects anything that is not one simple
 * command: chaining, redirection, substitution, expansion of any kind, globs, wrappers
 * that run another command, env-assignment prefixes and relative command paths.
 *
 * Accepted quoting: single quotes (no escapes), double quotes with `\"` and `\\` only,
 * and outside quotes a backslash before space, `'`, `"` or `\` (the last three so that
 * `shellJoin` output round-trips).
 */
export function parseSimpleCommand(cmd: string): ParseResult {
  if (typeof cmd !== 'string') return { ok: false, reason: 'the command is not a string' }
  if (cmd.length > OPS_MAX_COMMAND_LENGTH) {
    return { ok: false, reason: `the command is ${cmd.length} characters; the limit is ${OPS_MAX_COMMAND_LENGTH}` }
  }
  const bad = badCharReason(cmd, 'the command')
  if (bad) return { ok: false, reason: bad }
  if (cmd.trim() === '') return { ok: false, reason: 'the command is empty' }

  const argv: string[] = []
  let word = ''
  let started = false
  const end = (): void => {
    if (started) argv.push(word)
    word = ''
    started = false
  }

  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (ch === ' ') {
      end()
      i++
      continue
    }
    if (ch === "'") {
      const close = cmd.indexOf("'", i + 1)
      if (close === -1) return { ok: false, reason: `unbalanced single quote "'" at position ${i}` }
      word += cmd.slice(i + 1, close)
      started = true
      i = close + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let closed = false
      while (j < cmd.length) {
        const c = cmd[j]
        if (c === '"') {
          closed = true
          break
        }
        if (c === '\\') {
          const n = cmd[j + 1]
          if (n === '"' || n === '\\') {
            word += n
            j += 2
            continue
          }
          if (n === undefined) break
          return { ok: false, reason: `escape '\\${n}' inside double quotes is not allowed; only \\" and \\\\ are` }
        }
        if (c === '$') {
          return { ok: false, reason: `'${operatorToken(cmd, j)}' inside double quotes is expansion; use single quotes for a literal $` }
        }
        if (c === '`') return { ok: false, reason: "'`' inside double quotes is command substitution" }
        word += c
        j++
      }
      if (!closed) return { ok: false, reason: `unbalanced double quote '"' at position ${i}` }
      started = true
      i = j + 1
      continue
    }
    if (ch === '\\') {
      const n = cmd[i + 1]
      if (n === ' ' || n === "'" || n === '"' || n === '\\') {
        word += n
        started = true
        i += 2
        continue
      }
      if (n === undefined) return { ok: false, reason: "trailing '\\' is not allowed" }
      return { ok: false, reason: `escape '\\${n}' outside quotes is not allowed; quote the word instead` }
    }
    if (ch === '#' && !started) {
      return { ok: false, reason: "unquoted '#' at the start of a word begins a comment; quote it" }
    }
    if (ch in OPERATORS) {
      const tok = operatorToken(cmd, i)
      const what = tok === '<<' || tok === '<<<' ? 'is a heredoc' : OPERATORS[ch]
      return { ok: false, reason: `unquoted '${tok}' ${what}; one simple command only` }
    }
    word += ch
    started = true
    i++
  }
  end()

  if (argv.length === 0) return { ok: false, reason: 'the command is empty' }

  const first = commandWordReason(argv[0])
  if (first) return { ok: false, reason: first }
  if (argv[0] === 'sudo') {
    const at = sudoCommandIndex(argv)
    if (!at.ok) return at
    const target = argv[at.index]
    if (target === 'sudo') return { ok: false, reason: "'sudo sudo' is not allowed" }
    const r = commandWordReason(target)
    if (r) return { ok: false, reason: `after sudo: ${r}` }
  }

  // A `..` path segment in any word: a rule regex written as `/var/log/nginx/.+` would
  // otherwise reach `/var/log/nginx/../../../etc/shadow`.
  for (const w of argv) {
    if (w.includes('/') && w.split(/[/=]/).includes('..')) {
      return { ok: false, reason: `'..' path segment in '${w}' is not allowed` }
    }
  }
  return { ok: true, argv }
}

/** Quote argv back into a line safe for ssh2 exec (single-quote each word, '\'' escaping). */
export function shellJoin(argv: string[]): string {
  return argv.map(quoteWord).join(' ')
}

function quoteWord(w: string): string {
  return "'" + w.replace(/'/g, "'\\''") + "'"
}

/** Characters a word may consist of and still be written bare in the canonical form. */
const BARE_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/

/**
 * The one spelling of an argv that allow rules are matched against: words joined by
 * single spaces, bare when they hold only `[A-Za-z0-9_./:=@%+,-]`, single-quoted
 * (`'\''` escaping) otherwise. It parses back to the same argv.
 */
export function canonicalCommand(argv: string[]): string {
  return argv.map((w) => (BARE_WORD.test(w) ? w : quoteWord(w))).join(' ')
}

// ─── Denylist ────────────────────────────────────────────────────────────────────

/** argv with any leading `sudo` and its flags removed (repeatedly). */
function stripSudo(argv: string[]): string[] {
  let out = argv
  for (let n = 0; n < 4 && out.length > 0 && path.posix.basename(out[0]) === 'sudo'; n++) {
    const at = sudoCommandIndex(out)
    if (at.ok) out = out.slice(at.index)
    else {
      // Malformed flags: drop dash-words so the target is still examined (fail closed).
      let i = 1
      while (i < out.length && out[i].startsWith('-')) i++
      out = out.slice(i)
    }
  }
  return out
}

/** Short-option clusters (`-rf`) and long options (`--recursive`) as a set of letters/names. */
function hasShort(args: string[], letter: string): boolean {
  for (const a of args) {
    if (a === '--') return false
    if (a.startsWith('-') && !a.startsWith('--') && a.slice(1).includes(letter)) return true
  }
  return false
}

function hasLong(args: string[], name: string): boolean {
  for (const a of args) {
    if (a === '--') return false
    if (a === name || a.startsWith(name + '=')) return true
  }
  return false
}

/** Non-option words (everything after `--` counts as an operand). */
function operands(args: string[]): string[] {
  const out: string[] = []
  let opts = true
  for (const a of args) {
    if (opts && a === '--') {
      opts = false
      continue
    }
    if (opts && a.startsWith('-') && a !== '-') continue
    out.push(a)
  }
  return out
}

/**
 * True when a recursive operation on this target would take out the system or a whole
 * user's home: `/`, `/*`, `~…`, `$HOME`, `.`/`..`, any top-level directory (`/etc`,
 * `/data` …), or the PostgreSQL data tree.
 */
function isCriticalTarget(t: string): boolean {
  if (t.startsWith('~') || /^\$\{?HOME\}?/.test(t)) return true
  if (t === '.' || t === '..' || t === './' || t === '../') return true
  if (!t.startsWith('/')) return false
  let n = path.posix.normalize(t)
  if (n.endsWith('/*')) n = n.slice(0, -2) || '/'
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  if (n === '/' || n === '') return true
  // Any top-level directory: the named ones in the plan and anything else at depth one.
  if (n.split('/').length === 2) return true
  return /^\/var\/lib\/(pgsql|postgresql)(\/|$)/.test(n)
}

/** Files and directories no ops command may write, whatever the runbook says. */
const SENSITIVE = [
  /\/etc\/sudoers/,
  /authorized_keys/,
  /\/etc\/g?shadow/,
  /\/etc\/passwd/,
  /\/etc\/group(\b|$)/,
  /\/etc\/pam\.d/,
  /\/etc\/ssh\/sshd_config/,
  /(^|\/)\.ssh(\/|$)/
]

/** Every string an argument could mean as a path: itself, normalised, and after `=`. */
function pathCandidates(a: string): string[] {
  const out = [a]
  const eq = a.indexOf('=')
  if (eq !== -1) out.push(a.slice(eq + 1))
  for (const c of [...out]) if (c.includes('/')) out.push(path.posix.normalize(c))
  return out
}

function mentionsSensitive(args: string[]): boolean {
  for (const a of args) {
    for (const c of pathCandidates(a)) {
      if (SENSITIVE.some((re) => re.test(c))) return true
      // Copying a file named `shadow` into `/etc/` writes /etc/shadow; /etc itself as a
      // destination is refused outright.
      if (c === '/etc' || c === '/etc/') return true
    }
  }
  return false
}

const WRITE_ISH = new Set([
  'tee', 'cp', 'mv', 'ln', 'install', 'chmod', 'chown', 'chgrp', 'truncate', 'rm', 'unlink',
  'shred', 'dd', 'chattr', 'setfacl', 'touch'
])

/** Directories a download must never land in. */
const SYSTEM_DIRS = /^\/(etc|usr|bin|sbin|boot|lib|lib32|lib64|libx32|root)(\/|$)|^\/var\/spool\/cron(\/|$)/

const SQL_DROP = /\bdrop\b[\s\S]*\b(database|table|schema|owned|role|user)\b/i
const SQL_TRUNCATE = /\btruncate\b/i
/** psql's `\!` runs a shell; `COPY … PROGRAM` and `\o |`, `\g |` pipe to one. */
const SQL_SHELL = /\\!|\bcopy\b[\s\S]*\bprogram\b|\\[og]\s*\|/i

/**
 * Which hard-denylist shape fires for this argv, or null. Matched on the argv after a
 * leading sudo, on the command's basename so `/sbin/reboot` is `reboot`. Not configurable:
 * no policy.json can allow these.
 */
export function matchDenylist(argv: string[]): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return null
  if (argv.join('').replace(/\s/g, '').includes(':(){')) return 'fork-bomb'
  const words = stripSudo(argv)
  if (words.length === 0) return null
  const cmd = path.posix.basename(words[0])
  const args = words.slice(1)
  const ops = operands(args)

  if (cmd === 'rm') {
    if (hasLong(args, '--no-preserve-root')) return 'rm-no-preserve-root'
    const recursive = hasShort(args, 'r') || hasShort(args, 'R') || hasLong(args, '--recursive')
    if (recursive && ops.some(isCriticalTarget)) return 'rm-recursive-root'
  }
  if (cmd.startsWith('mkfs') || cmd === 'mke2fs' || cmd === 'wipefs') return 'mkfs'
  if (cmd === 'dd' && args.some((a) => a.startsWith('of=') && (a.startsWith('of=/dev/') || path.posix.normalize(a.slice(3)).startsWith('/dev/')))) {
    return 'dd-device'
  }
  if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(cmd)) return 'power'
  if ((cmd === 'init' || cmd === 'telinit') && ops.some((a) => a === '0' || a === '6')) return 'init-halt'
  if (cmd === 'systemctl') {
    const power = ['poweroff', 'reboot', 'halt', 'kexec', 'soft-reboot', 'emergency', 'rescue']
    if (ops.some((v) => power.includes(v))) return 'systemctl-power'
    if (ops.includes('isolate') && ops.some((t) => /^(poweroff|reboot|halt|kexec|rescue|emergency)(\.target)?$/.test(t))) {
      return 'systemctl-power'
    }
  }
  if (cmd === 'iptables' || cmd === 'ip6tables') {
    if (args.some((a) => a === '--flush' || /^-[A-Za-z]*F$/.test(a))) return 'firewall-flush'
    const p = args.findIndex((a) => a === '-P' || a === '--policy')
    if (p !== -1 && args.slice(p + 1).some((a) => /^(DROP|REJECT)$/i.test(a))) return 'firewall-flush'
  }
  if (cmd === 'nft' && ops.includes('flush')) return 'nft-flush'
  if (cmd === 'ufw' && (ops.includes('disable') || ops.includes('reset'))) return 'ufw-disable'
  if (cmd === 'firewall-cmd' && hasLong(args, '--panic-on')) return 'firewall-panic'
  if (['userdel', 'deluser', 'passwd', 'chpasswd'].includes(cmd)) return 'account'
  if (cmd === 'usermod' && (hasShort(args, 'p') || hasLong(args, '--password'))) return 'usermod-password'
  if (cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp') {
    const recursive = hasShort(args, 'R') || hasLong(args, '--recursive')
    if (recursive && ops.some(isCriticalTarget)) return `${cmd}-recursive-root`
  }
  if (cmd === 'history' && hasShort(args, 'c')) return 'history-clear'
  if (cmd === 'crontab' && hasShort(args, 'r')) return 'crontab-remove'

  const sedInPlace = cmd === 'sed' && (hasShort(args, 'i') || hasLong(args, '--in-place'))
  const perlInPlace = cmd === 'perl' && hasShort(args, 'i')
  if ((WRITE_ISH.has(cmd) || sedInPlace || perlInPlace) && mentionsSensitive(args)) return 'sensitive-file-write'

  if (cmd === 'curl' || cmd === 'wget') {
    const outputFlag = args.some((a) =>
      /^--(output|output-document|output-dir|directory-prefix)(=|$)/.test(a) ||
      (a.startsWith('-') && !a.startsWith('--') && /[oOP]/.test(a))
    )
    if (outputFlag) {
      for (const a of args) {
        const cands = pathCandidates(a)
        // `-o/etc/x` attached to a short cluster.
        const m = /^-[A-Za-z]*[oOP](\/.*)$/.exec(a)
        if (m) cands.push(m[1], path.posix.normalize(m[1]))
        if (cands.some((c) => SYSTEM_DIRS.test(c))) return 'download-to-system'
      }
    }
  }
  if (['pg_dropcluster', 'dropdb', 'dropuser'].includes(cmd)) return 'pg-drop'
  if (cmd === 'psql') {
    if (args.some((a) => SQL_DROP.test(a) || SQL_TRUNCATE.test(a))) return 'pg-drop'
    if (args.some((a) => SQL_SHELL.test(a))) return 'psql-shell'
  }
  return null
}

// ─── Classifier ──────────────────────────────────────────────────────────────────

/** Compile a rule regex; a source that does not compile matches nothing. */
function compile(src: unknown): RegExp | null {
  if (typeof src !== 'string') return null
  try {
    return new RegExp(src)
  } catch {
    return null
  }
}

/**
 * The regex must cover the whole string. The policy module already requires `^…$`; this
 * is the belt to its braces — an unanchored rule that slipped through matches less, never
 * more.
 */
function fullMatch(src: unknown, s: string): boolean {
  const re = compile(src)
  if (!re) return false
  const m = re.exec(s)
  return m !== null && m.index === 0 && m[0].length === s.length
}

/** A path rule is a prefix regex; it must at least be anchored at the start. */
function pathMatch(src: unknown, s: string): boolean {
  if (typeof src !== 'string' || !src.startsWith('^')) return false
  const re = compile(src)
  return re !== null && re.test(s)
}

function normClass(c: unknown): OpsClass {
  return c === 'read' ? 'read' : 'mutate'
}

/**
 * The decision a matched rule earns. Default approval is 'ask' for mutate and 'auto' for
 * read. `mutate + auto` is honoured only under strict — the policy module rejects it
 * otherwise, and the gate does not trust that it did.
 */
function decide(cls: OpsClass, approval: unknown, strict: boolean): 'allow' | 'ask' {
  // An approval value the type does not know is treated as 'ask'.
  if (approval !== undefined && approval !== 'auto' && approval !== 'ask') return 'ask'
  const a: OpsApproval = approval ?? (cls === 'mutate' ? 'ask' : 'auto')
  if (a === 'ask') return 'ask'
  if (cls === 'mutate' && !strict) return 'ask'
  return 'allow'
}

function intersects(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.some((x) => typeof x === 'string' && b.includes(x))
}

function deny(reason: string, cls: OpsClass = 'mutate', extra: Partial<OpsGateResult> = {}): OpsGateResult {
  return { decision: 'deny', class: cls, reason, ...extra }
}

/** Shared path checks for read/list/write; returns the normalised path or a reason. */
function checkPath(p: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof p !== 'string') return { ok: false, reason: 'path is not a string' }
  if (p.length > OPS_MAX_PATH_LENGTH) return { ok: false, reason: `path is ${p.length} characters; the limit is ${OPS_MAX_PATH_LENGTH}` }
  const bad = badCharReason(p, 'path')
  if (bad) return { ok: false, reason: bad }
  if (!isSafeRemotePath(p)) return { ok: false, reason: `path '${p}' must be absolute POSIX with no '..' segment` }
  const n = path.posix.normalize(p)
  if (!n.startsWith('/') || n.split('/').includes('..')) return { ok: false, reason: `path '${p}' must be absolute POSIX with no '..' segment` }
  return { ok: true, path: n }
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * The gate. `groups` = host group names this host belongs to (the caller resolves them
 * via the policy module). `host` null = unknown host. Order of checks is §3.1: host,
 * parse + denylist, sudo, tool shape, allow rules, fallthrough.
 */
export function classify(input: OpsToolInput, policy: OpsPolicy, host: OpsHostRef | null, groups: string[]): OpsGateResult {
  try {
    return classifyUnsafe(input, policy, host, groups)
  } catch (err) {
    return deny(`gate error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function classifyUnsafe(input: OpsToolInput, policy: OpsPolicy, host: OpsHostRef | null, groups: string[]): OpsGateResult {
  // 1. Host.
  if (!host || !Array.isArray(groups) || groups.length === 0) return deny('host is not in this runbook')
  if (!input || typeof input !== 'object') return deny('tool input is not an object')
  if (input.hostId !== host.id) return deny(`hostId '${String(input.hostId)}' does not match the resolved host`)
  if (!policy || typeof policy !== 'object') return deny('no policy')
  const strict = policy.strict !== false
  const g = groups.filter((x) => typeof x === 'string')

  switch (input.tool) {
    case 'run':
      return classifyRun(input.cmd, policy, strict, g)
    case 'script':
      return classifyScript(input.name, input.args, policy, strict, g)
    case 'read':
    case 'list':
    case 'write':
      return classifyFile(input, policy, strict)
    default:
      return deny(`unknown tool '${String((input as { tool?: unknown }).tool)}'`)
  }
}

function classifyRun(cmd: unknown, policy: OpsPolicy, strict: boolean, groups: string[]): OpsGateResult {
  if (typeof cmd !== 'string') return deny('run needs a cmd string')
  // 2. Parse, then the hard denylist.
  const parsed = parseSimpleCommand(cmd)
  if (!parsed.ok) {
    // The fork bomb never parses (it is all operators); name it as what it is.
    if (cmd.replace(/\s/g, '').includes(':(){')) return deny('denylisted: fork-bomb', 'mutate', { denylist: 'fork-bomb' })
    return deny(parsed.reason)
  }
  const argv = parsed.argv
  const hit = matchDenylist(argv)
  if (hit) return deny(`denylisted: ${hit} — no runbook can allow this`, 'mutate', { denylist: hit, argv })

  const canonical = canonicalCommand(argv)
  const rules = Array.isArray(policy.allow) ? policy.allow : []
  const isSudo = argv[0] === 'sudo'

  // 3 + 5. First matching rule wins. A sudo command can only be matched by a literal
  // `^sudo ` rule, and an unmatched sudo command is a deny even when not strict.
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    if (!intersects(rule.hosts, groups)) continue
    if (isSudo && !(typeof rule.cmd === 'string' && rule.cmd.startsWith('^sudo '))) continue
    if (!fullMatch(rule.cmd, canonical)) continue
    const cls = normClass(rule.class)
    const decision = decide(cls, rule.approval, strict)
    return {
      decision,
      class: cls,
      reason: `matched allow rule ${rule.cmd} (${cls}, ${decision === 'allow' ? 'auto' : 'ask'})`,
      rule: rule.cmd,
      ...(typeof rule.title === 'string' ? { title: rule.title } : {}),
      argv
    }
  }
  if (isSudo) return deny('sudo command matches no literal sudo rule in this runbook', 'mutate', { argv })

  // 6. Fallthrough: unknown is treated as the worse case.
  return strict
    ? deny('no allow rule matched and the runbook is strict', 'mutate', { argv })
    : { decision: 'ask', class: 'mutate', reason: 'no allow rule matched; asking', argv }
}

function classifyScript(name: unknown, args: unknown, policy: OpsPolicy, strict: boolean, groups: string[]): OpsGateResult {
  if (typeof name !== 'string' || name === '') return deny('script needs a name')
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return deny(`script name '${name}' must be a bare file name`)
  const scripts = Array.isArray(policy.scripts) ? policy.scripts : []
  const entry = scripts.find((s) => s && typeof s === 'object' && s.name === name)
  if (!entry) return deny(`script '${name}' is not in this runbook`)
  const cls = normClass(entry.class)
  if (!intersects(entry.hosts, groups)) return deny(`script '${name}' is not allowed on this host`, cls)
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    return deny(`script '${name}' has no valid pinned sha256`, cls)
  }
  if (!Array.isArray(args)) return deny('script args must be an array of strings', cls)
  const max = typeof entry.args?.max === 'number' && Number.isInteger(entry.args.max) && entry.args.max > 0 ? entry.args.max : 0
  if (args.length > max) return deny(`script '${name}' takes at most ${max} argument(s); got ${args.length}`, cls)
  for (const a of args) {
    if (typeof a !== 'string') return deny('script args must be an array of strings', cls)
    if (a.length > OPS_MAX_COMMAND_LENGTH) return deny(`script argument is ${a.length} characters; the limit is ${OPS_MAX_COMMAND_LENGTH}`, cls)
    const bad = badCharReason(a, 'script argument')
    if (bad) return deny(bad, cls)
    if (!fullMatch(entry.args?.pattern, a)) return deny(`script argument '${a}' does not match the script's pattern`, cls)
  }
  const decision = decide(cls, entry.approval, strict)
  return {
    decision,
    class: cls,
    reason: `runbook script ${name} (${cls}, ${decision === 'allow' ? 'auto' : 'ask'})`,
    rule: `script:${name}`,
    ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
    argv: [name, ...(args as string[])],
    scriptSha256: entry.sha256
  }
}

function classifyFile(
  input: Extract<OpsToolInput, { tool: 'read' | 'list' | 'write' }>,
  policy: OpsPolicy,
  strict: boolean
): OpsGateResult {
  const isWrite = input.tool === 'write'
  const cls: OpsClass = isWrite ? 'mutate' : 'read'
  const checked = checkPath(input.path)
  if (!checked.ok) return deny(checked.reason, cls)
  const p = checked.path
  // The hard denylist covers the write tool too, before any rule: no write.paths can
  // reach sudoers, shadow or authorized_keys.
  if (isWrite && mentionsSensitive([p])) {
    return deny('denylisted: sensitive-file-write — no runbook can allow this', cls, { path: p, denylist: 'sensitive-file-write' })
  }
  const section = isWrite ? policy.write : policy.read
  const patterns = section && Array.isArray(section.paths) ? section.paths : []
  if (!patterns.some((src) => pathMatch(src, p))) {
    return deny(`path ${p} is not under any ${isWrite ? 'write' : 'read'} path of this runbook`, cls, { path: p })
  }
  if (!isWrite) {
    return { decision: 'allow', class: 'read', reason: `${input.tool} under a runbook read path`, rule: 'read', path: p }
  }
  const content = (input as { content?: unknown }).content
  if (typeof content !== 'string') return deny('write needs content as a string', cls, { path: p })
  const bytes = utf8Bytes(content)
  if (bytes > OPS_MAX_WRITE_BYTES) return deny(`write content is ${bytes} bytes; the limit is ${OPS_MAX_WRITE_BYTES}`, cls, { path: p })
  const decision = decide('mutate', policy.write?.approval ?? 'ask', strict)
  return {
    decision,
    class: 'mutate',
    reason: `write under a runbook write path (${decision === 'allow' ? 'auto' : 'ask'})`,
    rule: 'write',
    path: p
  }
}
