/**
 * Single point that decides which hosts the controller may contact. Tests set
 * the allow-list to loopback so a misconfigured test can never reach a real
 * Cloudflare, Proxmox or NPM endpoint.
 */
export class EgressBlockedError extends Error {
  constructor(public readonly host: string) {
    super(`Outbound connection to "${host}" blocked by egress allow-list`);
    this.name = 'EgressBlockedError';
  }
}

export class EgressGuard {
  constructor(private readonly allowlist: string[] | '*') {}

  isAllowed(host: string): boolean {
    if (this.allowlist === '*') return true;
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    return this.allowlist.some((entry) => {
      if (entry.startsWith('*.')) return h.endsWith(entry.slice(1));
      return h === entry;
    });
  }

  assert(host: string): void {
    if (!this.isAllowed(host)) throw new EgressBlockedError(host);
  }
}
