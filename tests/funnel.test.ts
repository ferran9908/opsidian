import { describe, expect, it } from 'vitest';
import { funnelTarget, readyFor } from '../apps/host/src/funnel';

const ready = {
  BackendState: 'Running',
  Self: { ID: 'n1', DNSName: 'vps.tail1234.ts.net.', CapMap: { https: null, funnel: null } },
};

describe('turning Funnel on', () => {
  it('says what is missing instead of waiting for it, and names the machine when nothing is', () => {
    expect(readyFor(ready)).toBe('vps.tail1234.ts.net');
    expect(() => readyFor({ ...ready, BackendState: 'NeedsLogin' })).toThrow(/not signed in/);
    expect(() => readyFor({ ...ready, Self: { ...ready.Self, DNSName: 'vps.' } })).toThrow(
      /MagicDNS/,
    );
    expect(() => readyFor({ ...ready, Self: { ...ready.Self, CapMap: { funnel: null } } })).toThrow(
      /HTTPS certificates/,
    );
    expect(() => readyFor({ ...ready, Self: { ...ready.Self, CapMap: { https: null } } })).toThrow(
      /login\.tailscale\.com\/f\/funnel\?node=n1/,
    );
  });
  it('points Funnel at the host’s own listening address', () => {
    expect(funnelTarget('0.0.0.0', 4810)).toBe('http://127.0.0.1:4810/s');
    expect(funnelTarget('100.64.0.9', 4810)).toBe('http://100.64.0.9:4810/s');
  });
});
