import { describe, expect, it } from 'vitest';
import { confirmSiteFailure, dimension, siteHealth, type CheckView } from '../../src/health/aggregate.js';
import type { CheckPath, CheckStatus, HealthCheck } from '../../src/domain/types.js';

const SITE = 'site-a';
let n = 0;
function view(
  group: string,
  status: CheckStatus,
  opts: Partial<HealthCheck> & { path?: CheckPath } = {},
): CheckView {
  n++;
  return {
    check: {
      id: `c${n}`,
      name: opts.name ?? `${group} check ${n}`,
      siteId: SITE,
      applicationId: null,
      category: 'network',
      type: 'tcp',
      path: 'sdwan',
      independenceGroup: group,
      config: {},
      intervalSeconds: 15,
      timeoutMs: 1000,
      critical: true,
      enabled: true,
      ...opts,
    },
    state: { status, lastMessage: status === 'OK' ? '' : 'timeout', consecutiveFailures: 0, firstFailureAt: null, lastResultAt: null },
  };
}

const policy = { requiredFailedGroups: 3, requireNonSdwanFailure: true };

describe('dimension', () => {
  it('is UNKNOWN without checks', () => {
    expect(dimension([]).status).toBe('UNKNOWN');
  });
  it('takes the worst critical status', () => {
    expect(dimension([view('a', 'OK'), view('b', 'DEGRADED')]).status).toBe('DEGRADED');
  });
  it('caps non-critical checks at WARNING', () => {
    expect(dimension([view('a', 'OK'), view('b', 'FAILED', { critical: false })]).status).toBe('WARNING');
  });
  it('ignores disabled checks', () => {
    expect(dimension([view('a', 'OK'), view('b', 'FAILED', { enabled: false })]).status).toBe('HEALTHY');
  });
});

describe('siteHealth keeps tunnel, site and application health separate', () => {
  it('tunnel up while the application is broken', () => {
    const views = [
      view('icmp', 'OK'),
      view('tunnel', 'OK', { category: 'tunnel', path: 'cloudflare_api' }),
      view('wp', 'FAILED', { category: 'application', applicationId: 'wp' }),
    ];
    const h = siteHealth(SITE, views);
    expect(h.site.status).toBe('HEALTHY');
    expect(h.tunnel.status).toBe('HEALTHY');
    expect(h.applications.wp!.status).toBe('FAILED');
  });
});

describe('confirmSiteFailure', () => {
  it('does not confirm on a single failed check', () => {
    const c = confirmSiteFailure('Site A', SITE, [view('http', 'FAILED', { path: 'internet' }), view('tcp', 'OK'), view('pve', 'OK')], policy);
    expect(c.confirmed).toBe(false);
    expect(c.level).toBe('FAILURE_DETECTED');
  });

  it('counts groups, not checks: three failing HTTP checks are one signal', () => {
    const c = confirmSiteFailure(
      'Site A',
      SITE,
      [view('http', 'FAILED', { path: 'internet' }), view('http', 'FAILED', { path: 'internet' }), view('http', 'FAILED', { path: 'internet' }), view('tcp', 'OK')],
      policy,
    );
    expect(c.failedGroups).toEqual(['http']);
    expect(c.confirmed).toBe(false);
  });

  it('a group with any healthy check is not failed', () => {
    const c = confirmSiteFailure('Site A', SITE, [view('icmp', 'FAILED'), view('icmp', 'OK')], policy);
    expect(c.failedGroups).toEqual([]);
  });

  it('confirms with enough independent groups including an off-SD-WAN signal', () => {
    const c = confirmSiteFailure(
      'Site A',
      SITE,
      [view('icmp', 'FAILED'), view('proxmox', 'FAILED'), view('tunnel', 'FAILED', { category: 'tunnel', path: 'cloudflare_api' })],
      policy,
    );
    expect(c.confirmed).toBe(true);
    expect(c.level).toBe('CONFIRMED');
    expect(c.reasons.at(-1)).toBe('Site A failure confirmed');
  });

  it('refuses to confirm an SD-WAN-only outage while the public path is healthy', () => {
    const c = confirmSiteFailure(
      'Site A',
      SITE,
      [view('icmp', 'FAILED'), view('tcp', 'FAILED'), view('proxmox', 'FAILED'), view('public-https', 'OK', { category: 'traffic', path: 'internet' })],
      policy,
    );
    expect(c.confirmed).toBe(false);
    expect(c.level).toBe('FAILURE_DETECTED');
    expect(c.reasons.join(' ')).toMatch(/only fails over the SD-WAN path.*public-https still healthy.*NOT recommended/);
  });

  it('allows SD-WAN-only confirmation when the policy says so', () => {
    const c = confirmSiteFailure('Site A', SITE, [view('icmp', 'FAILED'), view('tcp', 'FAILED'), view('proxmox', 'FAILED')], {
      requiredFailedGroups: 3,
      requireNonSdwanFailure: false,
    });
    expect(c.confirmed).toBe(true);
  });

  it('is CONFIRMING while groups are failing but the minimum duration has not passed', () => {
    const c = confirmSiteFailure(
      'Site A',
      SITE,
      [view('icmp', 'DEGRADED'), view('tcp', 'DEGRADED'), view('tunnel', 'DEGRADED', { path: 'cloudflare_api' })],
      policy,
    );
    expect(c.level).toBe('CONFIRMING');
    expect(c.confirmed).toBe(false);
  });

  it('ignores replication and non-critical checks', () => {
    const c = confirmSiteFailure(
      'Site A',
      SITE,
      [
        view('icmp', 'FAILED'),
        view('repl', 'FAILED', { category: 'replication', path: 'local' }),
        view('cpu', 'FAILED', { critical: false, path: 'internet' }),
      ],
      { requiredFailedGroups: 2, requireNonSdwanFailure: false },
    );
    expect(c.failedGroups).toEqual(['icmp']);
    expect(c.confirmed).toBe(false);
  });

  it('is DEGRADED with warnings only, HEALTHY when all OK', () => {
    expect(confirmSiteFailure('Site A', SITE, [view('icmp', 'WARNING'), view('tcp', 'OK')], policy).level).toBe('DEGRADED');
    expect(confirmSiteFailure('Site A', SITE, [view('icmp', 'OK'), view('tcp', 'OK')], policy).level).toBe('HEALTHY');
  });
});
