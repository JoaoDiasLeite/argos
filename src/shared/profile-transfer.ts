/**
 * The contract between the main process and the renderer for moving Argos to another
 * machine: one `.argos` file carrying the profile (preferences, accounts without their
 * logins, sprints, planner, servers, ops ledger) and the chats of the projects the user
 * picks. Secrets travel only when the user sets a passphrase.
 */

export const PROFILE_FILE_EXTENSION = 'argos'

/** One project the export dialog offers, per source (a Claude or Codex account, or a WSL distro). */
export interface ExportCandidate {
  /** Stable id for the selection: `${sourceId}::${encodedDir}`. */
  key: string
  sourceId: string
  sourceLabel: string
  provider: 'claude' | 'codex'
  kind: 'local' | 'wsl'
  realPath: string
  name: string
  /** Transcripts, archived ones included. */
  sessionCount: number
  bytes: number
  lastActive: number
}

export interface ExportCandidates {
  projects: ExportCandidate[]
  /** Argos chats whose project folder is not on this machine's disk (SSH hosts). */
  remoteChatCount: number
}

export interface ExportRequest {
  /** ExportCandidate keys. */
  projects: string[]
  includeRemoteChats: boolean
  /** Empty or absent: secrets stay behind and servers travel without their passwords. */
  passphrase?: string
}

export interface ExportCounts {
  projects: number
  transcripts: number
  chats: number
  sprints: number
  servers: number
  secrets: boolean
}

export type ExportResult =
  | { ok: true; path: string; bytes: number; counts: ExportCounts }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string }

export interface ImportProjectPreview {
  name: string
  provider: 'claude' | 'codex'
  sourceLabel: string
  /** Path as exported. */
  fromPath: string
  /** Path after the home folder is remapped to this machine's. */
  toPath: string
  /** toPath exists on this machine. */
  exists: boolean
  /** The source (account or WSL distro) has no counterpart here; these chats are skipped. */
  unresolved: boolean
  /** The destination folder name is over 255 characters (NTFS limit); this project's transcripts will be skipped. */
  tooLong: boolean
  transcripts: number
}

export interface ImportPreview {
  /** The file the user picked; passed back to profileImport. */
  path: string
  createdAt: number
  appVersion: string
  platform: string
  /** platform differs from this machine's: paths are not remapped. */
  crossPlatform: boolean
  fromHome: string
  toHome: string
  projects: ImportProjectPreview[]
  chats: number
  sprints: number
  servers: number
  accounts: string[]
  hasSecrets: boolean
}

export type ImportPreviewResult =
  | { ok: true; preview: ImportPreview }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string }

export interface ImportRequest {
  path: string
  passphrase?: string
}

export interface ImportSkip {
  /** A project folder, chat or file name. */
  name: string
  reason: string
}

/**
 * With nothing skipped the app relaunches right after replying. With skips it stays up so
 * the renderer can show them, and relaunches through profileRelaunch.
 */
export type ImportResult =
  | { ok: true; backupDir: string; skipped: ImportSkip[] }
  | { ok: false; error: 'bad-passphrase' | string }
