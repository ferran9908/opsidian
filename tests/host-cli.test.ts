import { describe, expect, it } from 'vitest';
import {
  chooseAddress,
  drawQr,
  invitationLink,
  isTailscale,
  place,
  reachableAt,
} from '../apps/host/src/home';
import { LABEL, launchdPlist, systemdUnit } from '../apps/host/src/service';

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
    expect(plist).toContain(`<string>${LABEL}</string>`);
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
