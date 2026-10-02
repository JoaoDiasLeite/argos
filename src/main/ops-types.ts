/**
 * Shared shapes for the ops agent (docs/OPS_AGENT_PLAN.md). Pure types only — no
 * imports, no runtime code — so the policy, gate and audit modules and their tests
 * agree on one vocabulary without depending on each other.
 */

// ─── Policy (runbooks/<name>/policy.json) ───────────────────────────────────────

export type OpsClass = 'read' | 'mutate'
export type OpsApproval = 'auto' | 'ask'

export interface OpsAllowRule {
  /** Host group names this rule applies to (keys of OpsPolicy.hosts). */
  hosts: string[]
  /** Anchored regex source (`^…$`) matched against the whole command line. */
  cmd: string
  class: OpsClass
  /** Defaults to 'ask' for mutate and 'auto' for read when absent. */
  approval?: OpsApproval
  /** Human step title; the client-facing report uses it instead of the command. */
  title?: string
}

export interface OpsScriptRule {
  /** File name inside runbooks/<name>/scripts/, no path separators. */
  name: string
  /** Lower-case hex sha256 of the script's bytes. */
  sha256: string
  hosts: string[]
  class: OpsClass
  approval?: OpsApproval
  title?: string
  args?: {
    /** Maximum number of arguments; 0 or absent means none. */
    max?: number
    /** Anchored regex each argument must match. Required when max > 0. */
    pattern?: string
  }
}

export interface OpsPolicy {
  version: 1
  /** true: an unmatched call is denied. false: it asks. */
  strict: boolean
  /** Which product this runbook serves; drives the client report's product name. */
  platform?: 'cityfy' | 'wirerecruit' | 'wireforms' | 'wirechannel' | 'wirefix' | 'wirepaper'
  /** Group name → stored-host names or globs (`db-*`). */
  hosts: Record<string, string[]>
  allow: OpsAllowRule[]
  scripts: OpsScriptRule[]
  read?: { paths: string[]; maxBytes?: number }
  write?: { paths: string[]; approval?: OpsApproval; backup?: boolean }
  limits?: { timeoutMs?: number; maxOutputBytes?: number; concurrentPerHost?: number }
}

/** App-wide ceilings a policy's `limits` are clamped to. */
export const OPS_MAX_TIMEOUT_MS = 10 * 60 * 1000
export const OPS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const OPS_DEFAULT_TIMEOUT_MS = 60 * 1000
export const OPS_DEFAULT_OUTPUT_BYTES = 200 * 1024
export const OPS_DEFAULT_READ_BYTES = 1_000_000

// ─── Hosts as the gate sees them ─────────────────────────────────────────────────

/** The subset of a stored SSH host the gate needs. Never carries secrets. */
export interface OpsHostRef {
  id: string
  name: string
  host: string
}

// ─── Tool calls ──────────────────────────────────────────────────────────────────

export type OpsToolName = 'run' | 'script' | 'read' | 'list' | 'write'

export type OpsToolInput =
  | { tool: 'run'; hostId: string; cmd: string }
  | { tool: 'script'; hostId: string; name: string; args: string[] }
  | { tool: 'read'; hostId: string; path: string }
  | { tool: 'list'; hostId: string; path: string }
  | { tool: 'write'; hostId: string; path: string; content: string }

// ─── Gate ────────────────────────────────────────────────────────────────────────

export type OpsDecision = 'allow' | 'ask' | 'deny'

export interface OpsGateResult {
  decision: OpsDecision
  class: OpsClass
  /** One sentence, shown in the modal and written to the ledger. */
  reason: string
  /** The rule that matched: `allow[i]` cmd source, `script:<name>`, `read`, `write`. */
  rule?: string
  /** The step title from the matching rule, when it has one. */
  title?: string
  /** For run/script: the exact words that will be executed, in order. */
  argv?: string[]
  /** For script: the pinned hash the executor must verify again before running. */
  scriptSha256?: string
  /** For read/list/write: the normalised absolute POSIX path. */
  path?: string
  /** Which hard-denylist shape fired, when decision is deny for that reason. */
  denylist?: string
}

// ─── Intervention scope (docs/INTERVENTIONS_PLAN.md §2) ──────────────────────────

/**
 * Which hosts one intervention may touch. `host` locks the run to one stored host: a call
 * naming any other is refused whatever the policy says. `open` lets the model reach any
 * host the policy knows, asking the operator once per host per run.
 */
export type OpsScope = { kind: 'host'; hostId: string } | { kind: 'open' }

// ─── Audit ledger ────────────────────────────────────────────────────────────────

export interface OpsRunbookRef {
  name: string
  path: string
  policySha256: string
  runbookMdSha256: string
  platform?: OpsPolicy['platform']
}

/** One step of a plan, as logged with the user's decision on it. */
export interface OpsLoggedPlanStep {
  title: string
  commands: string[]
  verdict: string
  hostName?: string
  /** Set by summarizeRun from plan.approved's skippedSteps; never written in the event's steps. */
  skipped?: boolean
}

export type OpsAuditEvent =
  | {
      kind: 'run.start'
      runId: string
      appSessionId: string
      runbook: OpsRunbookRef
      hosts: OpsHostRef[]
      model: string
      account?: string
      planText?: string
      /** The operator's words for what this intervention is for (INTERVENTIONS_PLAN §2). */
      task?: string
      ticket?: string
      client?: string
      /** Absent on runs from before interventions, when every runbook host was in reach. */
      scope?: OpsScope
    }
  | {
      /** The operator's answer to the first touch of a host in an open intervention. */
      kind: 'host.approved' | 'host.denied'
      runId: string
      hostId: string
      host: string
      by: 'user'
    }
  | {
      kind: 'plan.approved' | 'plan.rejected'
      runId: string
      by: 'user'
      /** The plan as the model wrote it. A terminal run has no plan at run.start, so the
       *  report takes it from here. */
      planText?: string
      /** The plan's steps as classified when the user saw them. */
      steps?: OpsLoggedPlanStep[]
      /** plan.approved: 0-based indices into `steps` the operator skipped. */
      skippedSteps?: number[]
    }
  | {
      kind: 'call.decided'
      runId: string
      callId: string
      tool: OpsToolName
      hostId: string
      host: string
      rawInput: unknown
      argv?: string[]
      path?: string
      class: OpsClass
      decision: OpsDecision
      reason: string
      rule?: string
      title?: string
      scriptSha256?: string
      denylist?: string
    }
  | { kind: 'call.asked'; runId: string; callId: string }
  | {
      kind: 'call.answered'
      runId: string
      callId: string
      answer: 'allow' | 'deny' | 'stop'
      updatedInput?: unknown
    }
  | { kind: 'call.started'; runId: string; callId: string }
  | {
      kind: 'call.finished'
      runId: string
      callId: string
      exitCode: number | null
      signal?: string
      timedOut: boolean
      durationMs: number
      stdoutBytes: number
      stderrBytes: number
      stdoutSha256: string
      stderrSha256: string
      /** First 4 KB of each stream, verbatim. */
      stdoutHead: string
      stderrHead: string
    }
  | {
      kind: 'write.backup'
      runId: string
      callId: string
      path: string
      backupPath: string
      beforeSha256: string
      afterSha256: string
    }
  | { kind: 'sudo.password-supplied'; runId: string; hostId: string }
  | {
      kind: 'run.end'
      runId: string
      ok: boolean
      costUsd: number
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
      aborted?: boolean
      error?: string
    }

/** One ledger line: the event plus its position in the hash chain. */
export interface OpsAuditLine {
  /** ISO 8601, written by the main process. */
  at: string
  /** sha256 of the previous line's raw text, or 'genesis' for the first line of a file. */
  prev: string
  event: OpsAuditEvent
}
