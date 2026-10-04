import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import type { CheckType, HealthCheck } from '../../domain/types.js';
import { HttpError } from '../../http/client.js';
import { compareProxyHost, describeMismatch } from '../../providers/npm/NpmProvider.js';
import { parseCheckConfig } from './configs.js';
import type { CheckDeps, CheckExecutor, CheckResult, DnsLookup, Pinger } from './types.js';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reads a dotted path ("status.installed") from parsed JSON. */
export function jsonPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const icmp: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('icmp', check.config);
  deps.egress.assert(cfg.host);
  const r = await deps.ping(cfg.host, check.timeoutMs);
  return r.alive
    ? { ok: true, message: `ICMP reply from ${cfg.host}${r.timeMs !== undefined ? ` in ${r.timeMs} ms` : ''}`, latencyMs: r.timeMs }
    : { ok: false, message: `No ICMP reply from ${cfg.host}${r.error ? `: ${r.error}` : ''}` };
};

const tcp: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('tcp', check.config);
  deps.egress.assert(cfg.host);
  const started = performance.now();
  return new Promise<CheckResult>((resolve) => {
    const sock = net.connect({ host: cfg.host, port: cfg.port });
    const done = (r: CheckResult) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(check.timeoutMs, () => done({ ok: false, message: `TCP ${cfg.host}:${cfg.port} timed out after ${check.timeoutMs} ms` }));
    sock.once('connect', () => {
      const ms = Math.round(performance.now() - started);
      done({ ok: true, message: `TCP ${cfg.host}:${cfg.port} open in ${ms} ms`, latencyMs: ms });
    });
    sock.once('error', (e) => done({ ok: false, message: `TCP ${cfg.host}:${cfg.port} ${(e as NodeJS.ErrnoException).code ?? e.message}` }));
  });
};

const http: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('http', check.config);
  let res;
  try {
    res = await deps.http.request({
      method: cfg.method,
      url: cfg.url,
      timeoutMs: check.timeoutMs,
      headers: { accept: '*/*', 'user-agent': 'FailoverSyncManager/healthcheck', ...(cfg.hostHeader ? { host: cfg.hostHeader } : {}) },
      tls: { insecure: cfg.tlsInsecure, caPem: cfg.caPem },
    });
  } catch (e) {
    return { ok: false, message: e instanceof HttpError ? e.message : `HTTP request failed: ${errMsg(e)}` };
  }
  const observed: Record<string, unknown> = { status: res.status };
  const problems: string[] = [];
  if (!cfg.expectStatus.includes(res.status)) problems.push(`HTTP ${res.status} (expected ${cfg.expectStatus.join('/')})`);
  for (const s of cfg.bodyContains) if (!res.text.includes(s)) problems.push(`response missing "${s}"`);
  for (const s of cfg.bodyNotContains) if (res.text.includes(s)) problems.push(`response contains "${s}"`);
  if (cfg.bodyRegex && !new RegExp(cfg.bodyRegex).test(res.text)) problems.push(`response does not match /${cfg.bodyRegex}/`);
  if (cfg.json.length) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      problems.push('response is not JSON');
    }
    if (parsed !== undefined) {
      for (const a of cfg.json) {
        const v = jsonPath(parsed, a.path);
        if (v !== a.equals) problems.push(`${a.path} = ${JSON.stringify(v)} (expected ${JSON.stringify(a.equals)})`);
      }
    }
  }
  if (cfg.header) {
    const v = res.headers[cfg.header.name.toLowerCase()];
    observed.header = v ?? null;
    if (v === undefined) problems.push(`header ${cfg.header.name} missing`);
    else if (cfg.header.equals !== undefined && v !== cfg.header.equals) problems.push(`header ${cfg.header.name} = "${v}" (expected "${cfg.header.equals}")`);
    else if (cfg.header.contains !== undefined && !v.includes(cfg.header.contains)) problems.push(`header ${cfg.header.name} = "${v}" (expected to contain "${cfg.header.contains}")`);
  }
  if (problems.length) return { ok: false, message: problems.join('; '), latencyMs: res.latencyMs, observed };
  return { ok: true, message: `HTTP ${res.status} in ${res.latencyMs} ms, content verified`, latencyMs: res.latencyMs, observed };
};

const dns: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('dns', check.config);
  if (cfg.server) deps.egress.assert(cfg.server);
  const started = performance.now();
  try {
    const answers = await Promise.race([
      deps.dns(cfg.name, cfg.recordType, cfg.server),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${check.timeoutMs} ms`)), check.timeoutMs)),
    ]);
    const ms = Math.round(performance.now() - started);
    if (!answers.length) return { ok: false, message: `DNS ${cfg.recordType} ${cfg.name}: no answers`, latencyMs: ms };
    const norm = (s: string) => s.toLowerCase().replace(/\.$/, '');
    if (cfg.expect.length && !cfg.expect.some((e) => answers.map(norm).includes(norm(e)))) {
      return { ok: false, message: `DNS ${cfg.recordType} ${cfg.name} = ${answers.join(', ')} (expected ${cfg.expect.join(' or ')})`, latencyMs: ms, observed: { answers } };
    }
    return { ok: true, message: `DNS ${cfg.recordType} ${cfg.name} = ${answers.join(', ')}`, latencyMs: ms, observed: { answers } };
  } catch (e) {
    return { ok: false, message: `DNS ${cfg.recordType} ${cfg.name} failed: ${(e as NodeJS.ErrnoException).code ?? errMsg(e)}` };
  }
};

const proxmoxApi: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('proxmox_api', check.config);
  const started = performance.now();
  const pve = await deps.providers.proxmox(cfg.proxmoxInstanceId);
  const v = await pve.version();
  const ms = Math.round(performance.now() - started);
  return { ok: true, message: `Proxmox API reachable (version ${v.version})`, latencyMs: ms };
};

const proxmoxNode: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('proxmox_node', check.config);
  const pve = await deps.providers.proxmox(cfg.proxmoxInstanceId);
  const node = (await pve.listNodes()).find((n) => n.node === cfg.node);
  if (!node) return { ok: false, message: `Proxmox node ${cfg.node} not found in cluster` };
  if (node.status !== 'online') return { ok: false, message: `Proxmox node ${cfg.node} is ${node.status}` };
  const s = await pve.nodeStatus(cfg.node);
  const mem = s.memory.total ? s.memory.used / s.memory.total : 0;
  const root = s.rootfs?.total ? s.rootfs.used / s.rootfs.total : 0;
  const observed = { cpu: s.cpu, memory: mem, rootfs: root };
  const problems: string[] = [];
  if (s.cpu > cfg.maxCpu) problems.push(`CPU ${pct(s.cpu)} > ${pct(cfg.maxCpu)}`);
  if (mem > cfg.maxMemory) problems.push(`RAM ${pct(mem)} > ${pct(cfg.maxMemory)}`);
  if (root > cfg.maxRootfs) problems.push(`root disk ${pct(root)} > ${pct(cfg.maxRootfs)}`);
  const summary = `CPU ${pct(s.cpu)}, RAM ${pct(mem)}, disk ${pct(root)}`;
  return problems.length
    ? { ok: false, message: `Proxmox node ${cfg.node} online but ${problems.join(', ')}`, observed }
    : { ok: true, message: `Proxmox node ${cfg.node} online (${summary})`, observed };
};

const proxmoxVm: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('proxmox_vm', check.config);
  const pve = await deps.providers.proxmox(cfg.proxmoxInstanceId);
  const g = await pve.guestStatus(cfg.node, cfg.vmid, cfg.kind);
  const label = `${cfg.kind === 'lxc' ? 'CT' : 'VM'} ${cfg.vmid}${g.name ? ` (${g.name})` : ''}`;
  if (g.lock) return { ok: false, message: `${label} is locked (${g.lock})`, observed: { status: g.status, lock: g.lock } };
  if (cfg.expectStatus !== 'any' && g.status !== cfg.expectStatus) return { ok: false, message: `${label} is ${g.status} (expected ${cfg.expectStatus})`, observed: { status: g.status } };
  return { ok: true, message: `${label} is ${g.status}`, observed: { status: g.status } };
};

const tunnel: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('tunnel', check.config);
  const t = await deps.repos.tunnels.get(cfg.tunnelRef);
  if (!t) return { ok: false, message: 'Tunnel mapping not found' };
  const { provider, accountId } = await deps.providers.cloudflare(t.cloudflareAccountId);
  const started = performance.now();
  const info = await provider.getTunnel(accountId, t.tunnelId);
  const ms = Math.round(performance.now() - started);
  const conns = info.connections.filter((c) => !c.is_pending_reconnect).length;
  const observed = { status: info.status, connections: conns };
  if (info.status === 'healthy' && conns > 0) return { ok: true, message: `Tunnel ${t.name} healthy (${conns} connection${conns > 1 ? 's' : ''})`, latencyMs: ms, observed };
  if (info.status === 'degraded' && conns > 0) return { ok: true, message: `Tunnel ${t.name} degraded (${conns} connection${conns > 1 ? 's' : ''})`, latencyMs: ms, observed };
  return { ok: false, message: `Tunnel ${t.name} ${info.status} (${conns} connections) per Cloudflare`, latencyMs: ms, observed };
};

const npmApi: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('npm_api', check.config);
  const npm = await deps.providers.npm(cfg.npmInstanceId);
  const started = performance.now();
  const s = await npm.status();
  await npm.listCertificates();
  const ms = Math.round(performance.now() - started);
  const v = s.version ? ` ${s.version.major}.${s.version.minor}.${s.version.revision}` : '';
  return { ok: s.status === 'OK', message: `NPM${v} ${s.status === 'OK' ? 'reachable and authenticated' : `status ${s.status}`}`, latencyMs: ms };
};

const npmProxyHost: CheckExecutor = async (check, deps) => {
  const cfg = parseCheckConfig('npm_proxy_host', check.config);
  const exp = await deps.repos.npmExpectations.get(cfg.expectationId);
  if (!exp) return { ok: false, message: 'NPM expectation not found' };
  if (!exp.proxyHostId) return { ok: false, message: `NPM proxy host for ${exp.domainNames.join(', ')} not linked (run discovery)` };
  const npm = await deps.providers.npm(exp.npmInstanceId);
  const host = await npm.getProxyHost(exp.proxyHostId);
  const mismatches = compareProxyHost(host, exp);
  if (mismatches.length) return { ok: false, message: `NPM configuration mismatch: ${mismatches.map(describeMismatch).join('; ')}`, observed: { mismatches } };
  return { ok: true, message: `NPM proxy host ${exp.domainNames[0]} → ${exp.forwardScheme}://${exp.forwardHost}:${exp.forwardPort} matches` };
};

const replication: CheckExecutor = async (check, deps) => {
  if (!check.applicationId) return { ok: false, message: 'Replication check must belong to an application' };
  const app = await deps.repos.applications.get(check.applicationId);
  if (!app) return { ok: false, message: 'Application not found' };
  const r = await deps.replication.assess(app, check.siteId);
  return {
    ok: r.safety === 'SAFE' || r.safety === 'WARNING',
    message: r.message,
    observed: { safety: r.safety, ageSeconds: r.ageSeconds, lastSync: r.lastSync?.toISOString() ?? null },
  };
};

export const EXECUTORS: Record<CheckType, CheckExecutor> = {
  icmp,
  tcp,
  http,
  dns,
  proxmox_api: proxmoxApi,
  proxmox_node: proxmoxNode,
  proxmox_vm: proxmoxVm,
  tunnel,
  npm_api: npmApi,
  npm_proxy_host: npmProxyHost,
  replication,
};

/** Runs one check; never throws. Provider/config errors become failed results. */
export async function runCheck(check: HealthCheck, deps: CheckDeps): Promise<CheckResult> {
  const started = performance.now();
  try {
    const r = await EXECUTORS[check.type](check, deps);
    return { ...r, latencyMs: r.latencyMs ?? Math.round(performance.now() - started) };
  } catch (e) {
    return { ok: false, message: errMsg(e), latencyMs: Math.round(performance.now() - started) };
  }
}

/** System ping (iputils). Requires the ping binary in the container. */
export const systemPing: Pinger = (host, timeoutMs) =>
  new Promise((resolve) => {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    execFile('ping', ['-n', '-c', '1', '-W', String(secs), host], { timeout: timeoutMs + 1000 }, (err, stdout) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        return resolve({ alive: false, error: missing ? 'ping binary not available' : 'timeout or unreachable' });
      }
      const m = /time[=<]([\d.]+)\s*ms/.exec(stdout);
      resolve({ alive: true, timeMs: m ? Math.round(Number(m[1])) : undefined });
    });
  });

export const systemDns: DnsLookup = async (name, type, server) => {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  if (server) r.setServers([server]);
  if (type === 'CNAME') return r.resolveCname(name);
  return type === 'AAAA' ? r.resolve6(name) : r.resolve4(name);
};
