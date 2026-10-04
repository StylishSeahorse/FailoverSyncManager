/**
 * Global test safety net: no test may open a TCP connection to anything but
 * loopback. This sits *below* the application's own egress allow-list, so even
 * a bug in that allow-list cannot make the suite reach a real Cloudflare,
 * Proxmox or NPM endpoint.
 */
import net from 'node:net';

process.env.NODE_ENV = 'test';
process.env.FSM_EGRESS_ALLOWLIST = '127.0.0.1,localhost,::1';
process.env.DATABASE_URL ??= 'postgres://failover:failover@localhost:5432/failover_test';
process.env.FSM_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.LOG_LEVEL ??= 'silent';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const originalConnect = net.Socket.prototype.connect;

type Lookup = (h: string, o: object, cb: (e: unknown, addr: unknown) => void) => void;

function hostOf(args: unknown[]): string | undefined {
  const first = args[0];
  if (Array.isArray(first)) return hostOf(first);
  if (first && typeof first === 'object') {
    const o = first as { host?: string; path?: string; lookup?: Lookup };
    if (o.path) return undefined; // unix socket
    // undici dials an IP with a Host/SNI name by supplying a lookup that returns the IP.
    if (o.lookup && o.host) {
      let resolved: string | undefined;
      o.lookup(o.host, {}, (_e, addr) => {
        resolved = typeof addr === 'string' ? addr : undefined;
      });
      return resolved ?? o.host;
    }
    return o.host ?? 'localhost';
  }
  if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : 'localhost';
  return undefined;
}

net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
  const host = hostOf(args);
  if (host !== undefined && !LOOPBACK.has(host)) {
    throw new Error(`TEST SAFETY: blocked outbound TCP connection to ${host}`);
  }
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
