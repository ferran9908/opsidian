import { describe, expect, it } from 'vitest';
import {
  chooseAddress,
  defaultPort,
  productionHome,
  drawQr,
  invitationLink,
  isTailscale,
  parseArgs,
  place,
  reachableAt,
} from '../apps/host/src/home';
import { LABEL, labelOf, launchdPlist, systemdUnit, unitOf } from '../apps/host/src/service';

describe('the address a host listens on', () => {
  const tailscale = { kind: 'tailscale' as const, ip: '100.119.32.51' };
  const network = { kind: 'network' as const, ip: '192.168.1.20' };

  it('recognises Tailscale addresses and nothing else', () => {
    expect(isTailscale('100.64.0.1')).toBe(true);
    expect(isTailscale('100.127.255.1')).toBe(true);
    expect(isTailscale('100.128.0.1')).toBe(false);
    expect(isTailscale('100.63.0.1')).toBe(false);
    expect(isTailscale('10.0.0.1')).toBe(false);
  });

  it('is Tailscale’s, whenever there is one', () => {
    expect(chooseAddress([network, tailscale], 'linux')).toEqual({ ip: tailscale.ip });
    expect(chooseAddress([network, tailscale], 'darwin')).toEqual({ ip: tailscale.ip });
  });

  it('falls back to the home network on a Mac, and says so', () => {
    const chosen = chooseAddress([network], 'darwin');
    expect(chosen).toMatchObject({ ip: network.ip });
    expect('note' in chosen && chosen.note).toMatch(/Tailscale/);
  });

  it('is refused on a server without Tailscale, whose address is usually public', () => {
    expect(chooseAddress([network], 'linux')).toHaveProperty('error');
    expect(chooseAddress([], 'darwin')).toHaveProperty('error');
  });

  it('is given to devices as the best real address when listening on all of them', () => {
    expect(reachableAt({ address: '0.0.0.0', port: 4810 }, [tailscale, network])).toBe(
      '100.119.32.51:4810',
    );
    expect(reachableAt({ address: network.ip, port: 4811 }, [tailscale])).toBe('192.168.1.20:4811');
  });
});

describe('the background service', () => {
  const where = place('/Users/someone/.opsidian');

  it('runs the installed copy with this Node, and starts again by itself (launchd)', () => {
    const plist = launchdPlist(where, '/opt/node/bin/node');
    expect(plist).toContain(`<string>${labelOf(where)}</string>`);
    expect(plist).toContain(
      '<string>/opt/node/bin/node</string>\n    <string>/Users/someone/.opsidian/bin/opsidian.mjs</string>\n    <string>host</string>\n    <string>run</string>',
    );
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain('<string>/Users/someone/.opsidian/host.log</string>');
  });

  it('runs the installed copy with this Node, and starts again by itself (systemd)', () => {
    const unit = systemdUnit(place('/home/me/.opsidian'), false, '/usr/bin/node');
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/me/.opsidian/bin/opsidian.mjs" "host" "run"',
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(systemdUnit(place('/root/.opsidian'), true)).toContain('WantedBy=multi-user.target');
  });

  it('keeps systemd from expanding what is in a path', () => {
    const unit = systemdUnit(place('/home/a$b%c/.opsidian'), false, '/usr/bin/node');
    expect(unit).toContain('"/home/a$$b%%c/.opsidian/bin/opsidian.mjs"');
  });

  it('escapes paths in the launchd definition', () => {
    expect(launchdPlist(place('/Users/a&b/.opsidian'))).toContain('/Users/a&amp;b/.opsidian');
  });
});

describe('an invitation in the terminal', () => {
  it('is the same link the app’s QR code carries', () => {
    expect(invitationLink('100.119.32.51:4810', 'K7QM-2XPD-9RTA')).toBe(
      'opsidian://connect?host=100.119.32.51%3A4810&code=K7QM-2XPD-9RTA',
    );
  });

  it('is drawn black on white, two rows of modules to a line', () => {
    const lines = drawQr(invitationLink('100.119.32.51:4810', 'K7QM-2XPD-9RTA')).split('\n');
    const width = lines[0]!.replace(/\x1b\[[\d;]*m/g, '').length;
    // A QR code is 21 modules across plus 4 per version, with two of quiet space each side.
    expect((width - 4 - 21) % 4).toBe(0);
    expect(lines).toHaveLength(Math.ceil(width / 2));
    for (const line of lines) {
      expect(line.startsWith('\x1b[30;47m')).toBe(true);
      expect(line.replace(/\x1b\[[\d;]*m/g, '')).toHaveLength(width);
    }
  });
});

describe('the command line', () => {
  it('reads --flag value and --flag=value alike, and leaves words in order', () => {
    const { flags, words } = parseArgs([
      'host',
      'invite',
      'My',
      'Notes',
      '--port=4811',
      '--minutes',
      '5',
    ]);
    expect(words).toEqual(['host', 'invite', 'My', 'Notes']);
    expect(flags.get('port')).toBe('4811');
    expect(flags.get('minutes')).toBe('5');
  });

  it('does not take the next word for a switch', () => {
    const { flags, words } = parseArgs(['host', 'logs', '-f', 'extra', '--delete-data']);
    expect(flags.has('f')).toBe(true);
    expect(flags.has('delete-data')).toBe(true);
    expect(words).toEqual(['host', 'logs', 'extra']);
  });
});

describe('a development or test host beside the real one', () => {
  it('runs tests with a home of their own, never the real host’s', () => {
    expect(process.env.OPSIDIAN_HOME).toBeTruthy();
    expect(place().home).not.toBe(productionHome());
  });

  it('gives each folder’s host its own service, and the real one the plain name', () => {
    const real = place(productionHome());
    expect(real.instance).toBe('');
    expect(labelOf(real)).toBe(LABEL);
    expect(unitOf(real)).toBe('opsidian-host.service');
    const other = place('/tmp/some-test-host');
    expect(other.instance).toMatch(/^[0-9a-f]{8}$/);
    expect(labelOf(other)).toBe(`${LABEL}.${other.instance}`);
    expect(unitOf(other)).toBe(`opsidian-host-${other.instance}.service`);
    // The same folder always gets the same name, so stop finds what start made.
    expect(place('/tmp/some-test-host/').instance).toBe(other.instance);
    expect(place('/tmp/another').instance).not.toBe(other.instance);
  });

  it('keeps `pnpm host` in its own folder and on its own port', () => {
    const saved = { ...process.env };
    try {
      delete process.env.OPSIDIAN_HOME;
      process.env.npm_lifecycle_event = 'start';
      process.env.npm_package_name = 'opsidian';
      expect(place().home).toBe(`${productionHome()}-dev`);
      expect(place().instance).not.toBe('');
      expect(defaultPort()).toBe(4811);
      // `npx opsidian`, as people run it, is the real thing.
      process.env.npm_lifecycle_event = 'npx';
      expect(place().home).toBe(productionHome());
      expect(defaultPort()).toBe(4810);
    } finally {
      process.env = saved;
    }
  });
});
