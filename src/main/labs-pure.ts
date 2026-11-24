// The "experimental features" switch (config.json `labs`): the decisions main takes on it,
// kept pure so they can be tested without electron. labs.ts reads the live config and
// passes the flag in.
//
// What the switch hides is the unfinished remote work of 3.9.0 (shared credentials, groups,
// gateways, VPNs, tunnels, the connect prompt, Send password and Elevate). Turning it off
// hides the UI and stops the behaviour that would surprise someone who never turned it on,
// but never touches saved data: a host set up while it was on keeps connecting the same way.

/** The stored value as main reads it: only a literal `true` turns the features on. */
export function labsFromConfig(value: unknown): boolean {
  return value === true
}

/**
 * Whether opening a session may put a prompt in front of the user (the password nobody
 * saved, a key's passphrase, a keyboard-interactive question). Off without labs: a host with
 * nothing saved fails to connect, as it did before 3.9.0.
 */
export function mayAskOnConnect(labs: boolean, interactive: boolean): boolean {
  return labs && interactive
}

/**
 * Whether ssh2 tries keyboard-interactive. With labs on, when someone can answer it or the
 * host has a login password for a lone password prompt. With labs off, never, which is how
 * every connection was dialled before 3.9.0.
 */
export function tryKeyboardFor(
  labs: boolean,
  opts: { canAsk: boolean; authType: string; hasPassword: boolean }
): boolean {
  if (!labs) return false
  return opts.canAsk || (opts.authType === 'password' && opts.hasPassword)
}

/**
 * Whether a remote chat's ssh terminal answers ssh's own login prompt with the saved secret
 * and holds the launch line until the login settles. Off without labs: ssh asks and the user
 * types, as before 3.9.0.
 */
export function chatLoginAnswered(labs: boolean, answerable: number): boolean {
  return labs && answerable > 0
}

/**
 * Whether a host's autoStart tunnels start when its session connects. The tunnels stay saved
 * on the host; only starting them waits for the switch.
 */
export function mayAutoStartForwards(labs: boolean): boolean {
  return labs
}

/**
 * Whether main carries out an action only the hidden UI asks for: Send password, Elevate, a
 * VPN up or down (including "bring the VPN up and retry"), a tunnel start. Unreachable from
 * the UI with labs off; main refuses them anyway, as defence in depth.
 */
export function labsActionAllowed(labs: boolean): boolean {
  return labs
}
