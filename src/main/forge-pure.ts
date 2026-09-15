/**
 * Which code-hosting forge a sprint imports from, and the words each one uses.
 *
 * The importer talks to a forge through that forge's MCP server, so almost nothing
 * here is about APIs — it is about vocabulary, and the two forges disagree in ways
 * that matter to the UI:
 *
 *   - GitLab calls them merge requests, GitHub pull requests.
 *   - GitLab numbers issues and MRs separately and writes them `#481` and `!49`;
 *     GitHub shares one sequence and writes both `#49`. So on GitHub the reference
 *     alone cannot tell you which kind of thing it points at — only the stored
 *     `kind` can, which is why the importer is required to return it.
 *
 * Keeping this in one place is what lets the rest of the code stay forge-agnostic:
 * everything else passes a `Forge` around and asks here for the noun.
 */

export type Forge = 'gitlab' | 'github'

/** Internal vocabulary. 'merge-request' is the stored value on both forges; the
 *  label shown to a GitHub user is "Pull request" — see `changeNoun`. */
export type OriginKind = 'issue' | 'merge-request'

export const FORGE_NAMES: Record<Forge, string> = {
  gitlab: 'GitLab',
  github: 'GitHub'
}

/** "merge request" / "pull request" — lowercase, for mid-sentence use. */
export function changeNoun(forge: Forge, plural = false): string {
  const base = forge === 'github' ? 'pull request' : 'merge request'
  return plural ? `${base}s` : base
}

/** "Merge request" / "Pull request" — for a label. */
export function changeLabel(forge: Forge): string {
  const n = changeNoun(forge)
  return n[0].toUpperCase() + n.slice(1)
}

/** What a row of that kind is called on that forge. */
export function kindLabel(forge: Forge, kind: OriginKind): string {
  return kind === 'merge-request' ? changeLabel(forge) : 'Issue'
}

/**
 * The sigil a reference carries. GitHub uses `#` for both — a `!42` there would be
 * wrong, and a `#42` there says nothing about the kind.
 */
export function refSigil(forge: Forge, kind: OriginKind): '#' | '!' {
  return forge === 'gitlab' && kind === 'merge-request' ? '!' : '#'
}

/**
 * Whether a reference's sigil identifies the kind on this forge. True only for
 * GitLab, where `!` and `#` are different namespaces; on GitHub the stored `kind`
 * is the only thing that knows.
 */
export function sigilIsMeaningful(forge: Forge): boolean {
  return forge === 'gitlab'
}

/**
 * The forge behind a git remote URL — https, ssh and scp-style forms alike.
 * Self-hosted installs are the normal case here (the host is neither gitlab.com nor
 * github.com), so the hostname is matched loosely: `gitlab.cityfy.pt` and
 * `github.acme.internal` both resolve. Anything unrecognised returns null rather
 * than guessing, and the caller falls back to whichever forge MCP is configured.
 */
export function forgeFromRemote(remote?: string | null): Forge | null {
  if (!remote) return null
  const r = remote.trim().toLowerCase()
  if (!r) return null
  // Take the host out of https://host/…, ssh://git@host/…, or git@host:group/repo.
  const host = /^[a-z+]+:\/\//.test(r)
    ? r.replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]*@/, '').split(/[/:]/)[0]
    : r.includes('@')
      ? r.split('@')[1]?.split(':')[0]
      : r.split(/[/:]/)[0]
  if (!host) return null
  if (/(^|\.)github(\.|$)/.test(host) || host === 'github.com') return 'github'
  if (/(^|\.)gitlab(\.|$)/.test(host) || host === 'gitlab.com') return 'gitlab'
  return null
}

/**
 * Whether an MCP server looks like the given forge's. Names, URLs and env values
 * are all fair game because these servers are user-configured and named freely —
 * `wm-git` is this codebase's own GitLab server.
 */
export function looksLikeForge(
  s: { name: string; url?: string; config?: Record<string, unknown> },
  forge: Forge
): boolean {
  const pattern = forge === 'github' ? /git.?hub/i : /git.?lab|wm-git/i
  if (pattern.test(s.name)) return true
  if (s.url && pattern.test(s.url)) return true
  const env = (s.config as { env?: Record<string, unknown> } | undefined)?.env
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (pattern.test(k) || pattern.test(String(v))) return true
    }
  }
  return false
}

/**
 * Pick the forge MCP to run against: the one matching the project's own remote when
 * that is known and configured, otherwise whichever single forge server exists. With
 * both configured and no remote to go on, GitLab wins — it is the one this app was
 * built against, and the choice is visible in the importer either way.
 */
export function pickForgeServer<T extends { name: string; url?: string; config?: Record<string, unknown> }>(
  servers: T[],
  preferred: Forge | null
): { server: T; forge: Forge } | null {
  const found = (['gitlab', 'github'] as Forge[])
    .map((forge) => {
      const server = servers.find((s) => looksLikeForge(s, forge))
      return server ? { server, forge } : null
    })
    .filter((x): x is { server: T; forge: Forge } => x !== null)
  if (found.length === 0) return null
  if (preferred) {
    const match = found.find((f) => f.forge === preferred)
    if (match) return match
  }
  return found[0]
}
