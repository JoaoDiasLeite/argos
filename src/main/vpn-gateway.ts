import type { Client } from 'ssh2'
import { t } from './i18n'
import { getRemoteClient, hasPooledSession, releaseUnusedSession } from './sftp'
import { getStoredHost } from './ssh'
import { noteVpn, runAndNote, type VpnRunResult } from './vpn-exec'
import { usableVpns, type VpnAction, type VpnProfile } from './vpn-pure'

/**
 * The VPNs of a gateway host, as the Remote view lists and switches them: status, up and down
 * over the gateway's pooled ssh2 connection (sftp.ts getRemoteClient). A connection opened
 * only for this is closed again once nothing else holds it, so a status refresh does not
 * leave a session open on the gateway. Commands and sudo are in vpn-exec.ts.
 */

export type { VpnRunResult, VpnStatusEvent } from './vpn-exec'

/** Per gateway: how many VPN commands are running on it, and whether one of them had to open
 *  its connection (then the last one to finish lets it go). */
const inUse = new Map<string, { count: number; opened: boolean }>()

async function withGateway<T>(
  gatewayId: string,
  interactive: boolean,
  work: (conn: Client, gateway: { id: string; name: string }, vpns: VpnProfile[]) => Promise<T>,
  failed: (error: string) => T
): Promise<T> {
  const host = getStoredHost(gatewayId)
  if (!host) return failed(t('main.ssh.hostNotFound'))
  const vpns = usableVpns(host.vpns)
  const entry = inUse.get(gatewayId) ?? { count: 0, opened: false }
  if (entry.count === 0) entry.opened = !hasPooledSession(gatewayId)
  entry.count++
  inUse.set(gatewayId, entry)
  try {
    const res = await getRemoteClient(gatewayId, { interactive })
    if (!res.ok) return failed(t('main.vpn.gatewayFailed', { gateway: host.name, error: res.error }))
    return await work(res.conn, { id: gatewayId, name: host.name }, vpns)
  } finally {
    entry.count--
    if (entry.count === 0) {
      inUse.delete(gatewayId)
      if (entry.opened) releaseUnusedSession(gatewayId)
    }
  }
}

const notFound = (): VpnRunResult => ({ ok: false, reason: 'not-found', error: t('main.vpn.notFound') })

/**
 * Up or down, on the user's click. May connect the gateway and so ask for its password:
 * the caller restricts it to the main window. The state is announced (busy, then the outcome)
 * on `vpn:changed`.
 */
export function vpnSwitch(gatewayId: unknown, vpnId: unknown, action: Exclude<VpnAction, 'status'>): Promise<VpnRunResult> {
  if (typeof gatewayId !== 'string' || typeof vpnId !== 'string') return Promise.resolve(notFound())
  return withGateway(
    gatewayId,
    true,
    async (conn, gateway, vpns) => {
      const vpn = vpns.find((v) => v.id === vpnId)
      return vpn ? runAndNote(conn, gateway, vpn, action) : notFound()
    },
    (error) => {
      noteVpn(gatewayId, vpnId, 'unknown', { error, reason: 'connect' })
      return { ok: false, reason: 'connect', error }
    }
  )
}

export interface VpnStatusEntry {
  vpnId: string
  result: VpnRunResult
}

/**
 * The status of one VPN of a gateway, or of all of them (one connection for the lot). Never
 * asks: a gateway that needs a password typed to connect reports that instead, until its
 * session is open.
 */
export type VpnStatusResult = { ok: true; statuses: VpnStatusEntry[] } | { ok: false; error: string }

export function vpnStatus(gatewayId: unknown, vpnId?: unknown): Promise<VpnStatusResult> {
  if (typeof gatewayId !== 'string') return Promise.resolve({ ok: false, error: t('main.vpn.notFound') })
  const only = typeof vpnId === 'string' ? vpnId : undefined
  return withGateway<VpnStatusResult>(
    gatewayId,
    false,
    async (conn, gateway, vpns) => {
      const statuses: VpnStatusEntry[] = []
      for (const vpn of vpns) {
        if (only && vpn.id !== only) continue
        statuses.push({ vpnId: vpn.id, result: await runAndNote(conn, gateway, vpn, 'status') })
      }
      return { ok: true, statuses }
    },
    (error) => {
      // Every VPN of that gateway is unknown now, and the list says why.
      const host = getStoredHost(gatewayId)
      for (const v of usableVpns(host?.vpns)) if (!only || v.id === only) noteVpn(gatewayId, v.id, 'unknown', { error, reason: 'connect' })
      return { ok: false, error }
    }
  )
}
