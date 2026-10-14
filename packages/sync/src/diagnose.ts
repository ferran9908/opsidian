/** One step of finding out why a device and its host are not talking. */
export interface Check {
  id: 'online' | 'reach' | 'accepted';
  /** `skipped` means an earlier step failed, so this one was not tried. */
  state: 'ok' | 'failed' | 'skipped';
  title: string;
  /** What to do about a failure, in plain words. */
  detail?: string;
  /** The failure is most likely Tailscale being off; offer to open it. */
  tailscale?: true;
}

/** Whether an address is one Tailscale hands out, so reaching it needs Tailscale switched on. */
export function onTailscale(host: string): boolean {
  let name: string;
  try {
    name = new URL(/^[a-z]+:\/\//i.test(host) ? host : `http://${host}`).hostname;
  } catch {
    return false;
  }
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name) || /\.ts\.net$/i.test(name);
}

const address = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/**
 * Tries each thing a connection depends on, in order, and stops at the first that fails:
 * the fix is always the first failed line.
 */
export async function diagnose(
  host: string,
  token: string | undefined,
  options: {
    /** `this Mac`, `this iPhone`. */
    device: string;
    online(): Promise<boolean>;
    request?: typeof fetch;
    timeout?: number;
  },
): Promise<Check[]> {
  const request = options.request ?? fetch;
  const call = async (path: string, headers: Record<string, string> = {}) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), options.timeout ?? 6000);
    try {
      const response = await request(`${host.replace(/\/+$/, '')}${path}`, {
        headers,
        signal: stop.signal,
      });
      // Read inside the time limit, so a host that stalls part-way cannot hang the check.
      const body = (await response.json().catch(() => undefined)) as
        { opsidian?: string } | undefined;
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
  const Device = options.device[0]!.toUpperCase() + options.device.slice(1);
  const checks: Check[] = [
    { id: 'online', state: 'skipped', title: `${Device} is online` },
    { id: 'reach', state: 'skipped', title: 'The host answers' },
    { id: 'accepted', state: 'skipped', title: `The host still accepts ${options.device}` },
  ];
  const [online, reach, accepted] = checks as [Check, Check, Check];
  const tailscale = onTailscale(host);

  // A host on the home network can be reached with no internet at all, so being offline
  // is only reported; the host is tried regardless.
  const connected = await options.online().catch(() => true);
  online.state = connected ? 'ok' : 'failed';
  if (!connected) {
    online.title = `${Device} is not connected to a network`;
    online.detail = 'Turn on Wi-Fi or mobile data.';
  }

  let answered = false;
  try {
    const response = await call('/v1');
    answered = response.ok && response.body?.opsidian === 'host';
    if (!answered) {
      reach.state = 'failed';
      reach.title = 'Something answered, but it is not an Opsidian host';
      reach.detail = `Check the address: ${address(host)}.`;
    }
  } catch {
    reach.state = 'failed';
    reach.title = 'The host did not answer';
    if (tailscale) {
      reach.tailscale = true;
      reach.detail = `It is at a Tailscale address (${address(host)}). Check that Tailscale is on here, and that the machine hosting the notebook is awake.`;
    } else
      reach.detail = `Check that the host is running at ${address(host)}, and that ${options.device} is on the same network.`;
  }
  if (!answered) return checks;
  reach.state = 'ok';
  // Reaching the host proves the network works, whatever the system said.
  if (online.state === 'failed')
    Object.assign(online, { state: 'ok', title: `${Device} is online` });
  delete online.detail;

  if (!token) {
    accepted.state = 'failed';
    accepted.title = `${Device} has lost its connection details`;
    accepted.detail = 'Connect again with a new invitation.';
    return checks;
  }
  try {
    const response = await call('/v1/whoami', { authorization: `Bearer ${token}` });
    if (response.ok) accepted.state = 'ok';
    else {
      accepted.state = 'failed';
      accepted.title = `The host no longer accepts ${options.device}`;
      accepted.detail =
        response.status === 401
          ? 'It was removed from the notebook’s devices, or the host was set up again. Connect again with a new invitation.'
          : `The host answered ${response.status}. It may be an older version.`;
    }
  } catch {
    accepted.state = 'failed';
    accepted.title = 'The host stopped answering';
    accepted.detail = 'Try again in a moment.';
  }
  return checks;
}
