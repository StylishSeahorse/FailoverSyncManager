import { JsonApiProvider, type ProviderOptions } from '../base.js';
import { ProviderError } from '../errors.js';

export type GuestKind = 'qemu' | 'lxc';

export interface PveNode {
  node: string;
  status: 'online' | 'offline' | 'unknown' | string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
}

export interface PveNodeStatus {
  cpu: number;
  memory: { used: number; total: number };
  rootfs?: { used: number; total: number };
  uptime: number;
}

export interface PveGuest {
  vmid: number;
  name: string;
  status: 'running' | 'stopped' | 'paused' | string;
  kind: GuestKind;
  lock?: string;
  template?: boolean;
}

export interface PveStorage {
  storage: string;
  active: boolean;
  enabled: boolean;
  total?: number;
  used?: number;
  avail?: number;
  content?: string;
}

export interface PveReplicationJob {
  id: string;
  guest: number;
  last_sync?: number;
  fail_count?: number;
  error?: string;
  target?: string;
}

export interface PveBackup {
  volid: string;
  ctime: number;
  vmid?: number;
  size?: number;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

export class ProxmoxProvider extends JsonApiProvider {
  protected readonly name = 'proxmox' as const;

  constructor(
    opts: ProviderOptions,
    private readonly tokenId: string,
    private readonly tokenSecret: string,
  ) {
    super({ ...opts, baseUrl: `${opts.baseUrl.replace(/\/+$/, '')}/api2/json` });
  }

  protected secretValues(): string[] {
    return [this.tokenSecret];
  }

  private async call<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    const res = await this.send({
      method,
      path,
      headers: {
        authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    if (res.status < 200 || res.status >= 300) {
      throw this.httpFailure(res, res.headers['x-proxmox-error'] ?? undefined);
    }
    const body = this.parseJson<{ data: T }>(res);
    if (!body || !('data' in body)) {
      throw new ProviderError('Proxmox API response missing "data"', 'proxmox', { status: res.status, kind: 'invalid_response' });
    }
    return body.data;
  }

  private static seg(s: string | number) {
    return encodeURIComponent(String(s));
  }

  async version(): Promise<{ version: string; release?: string }> {
    return this.call('GET', '/version');
  }

  async listNodes(): Promise<PveNode[]> {
    return this.call('GET', '/nodes');
  }

  async nodeStatus(node: string): Promise<PveNodeStatus> {
    const s = await this.call<Record<string, unknown>>('GET', `/nodes/${ProxmoxProvider.seg(node)}/status`);
    const mem = (s.memory ?? {}) as { used?: number; total?: number };
    const rootfs = s.rootfs as { used?: number; total?: number } | undefined;
    return {
      cpu: num(s.cpu),
      memory: { used: num(mem.used), total: num(mem.total) },
      rootfs: rootfs ? { used: num(rootfs.used), total: num(rootfs.total) } : undefined,
      uptime: num(s.uptime),
    };
  }

  async listGuests(node: string): Promise<PveGuest[]> {
    const [qemu, lxc] = await Promise.all([
      this.call<Array<Record<string, unknown>>>('GET', `/nodes/${ProxmoxProvider.seg(node)}/qemu`),
      this.call<Array<Record<string, unknown>>>('GET', `/nodes/${ProxmoxProvider.seg(node)}/lxc`),
    ]);
    const map = (kind: GuestKind) => (g: Record<string, unknown>): PveGuest => ({
      vmid: num(g.vmid),
      name: String(g.name ?? ''),
      status: String(g.status ?? 'unknown'),
      kind,
      lock: g.lock ? String(g.lock) : undefined,
      template: g.template === 1 || g.template === true,
    });
    return [...qemu.map(map('qemu')), ...lxc.map(map('lxc'))].sort((a, b) => a.vmid - b.vmid);
  }

  async guestStatus(node: string, vmid: number, kind: GuestKind): Promise<PveGuest> {
    const s = await this.call<Record<string, unknown>>(
      'GET',
      `/nodes/${ProxmoxProvider.seg(node)}/${kind}/${ProxmoxProvider.seg(vmid)}/status/current`,
    );
    return {
      vmid,
      name: String(s.name ?? ''),
      status: String(s.status ?? 'unknown'),
      kind,
      lock: s.lock ? String(s.lock) : undefined,
    };
  }

  /** Issues a power action and returns the task UPID. Callers must use waitForTask. */
  async powerAction(node: string, vmid: number, kind: GuestKind, action: 'start' | 'stop' | 'shutdown' | 'reboot'): Promise<string> {
    return this.call<string>(
      'POST',
      `/nodes/${ProxmoxProvider.seg(node)}/${kind}/${ProxmoxProvider.seg(vmid)}/status/${action}`,
      {},
    );
  }

  async taskStatus(node: string, upid: string): Promise<{ status: 'running' | 'stopped' | string; exitstatus?: string }> {
    return this.call('GET', `/nodes/${ProxmoxProvider.seg(node)}/tasks/${ProxmoxProvider.seg(upid)}/status`);
  }

  async waitForTask(node: string, upid: string, timeoutMs: number, pollMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = await this.taskStatus(node, upid);
      if (t.status === 'stopped') {
        if (t.exitstatus === 'OK') return;
        throw new ProviderError(`Proxmox task ${upid} failed: ${t.exitstatus ?? 'unknown error'}`, 'proxmox', { kind: 'server' });
      }
      if (Date.now() > deadline) {
        throw new ProviderError(`Proxmox task ${upid} did not finish within ${timeoutMs} ms`, 'proxmox', { kind: 'timeout' });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async listStorage(node: string): Promise<PveStorage[]> {
    const rows = await this.call<Array<Record<string, unknown>>>('GET', `/nodes/${ProxmoxProvider.seg(node)}/storage`);
    return rows.map((s) => ({
      storage: String(s.storage),
      active: s.active === 1 || s.active === true,
      enabled: s.enabled === undefined ? true : s.enabled === 1 || s.enabled === true,
      total: s.total === undefined ? undefined : num(s.total),
      used: s.used === undefined ? undefined : num(s.used),
      avail: s.avail === undefined ? undefined : num(s.avail),
      content: s.content ? String(s.content) : undefined,
    }));
  }

  async replicationJobs(node: string): Promise<PveReplicationJob[]> {
    return this.call('GET', `/nodes/${ProxmoxProvider.seg(node)}/replication`);
  }

  async listBackups(node: string, storage: string, vmid: number): Promise<PveBackup[]> {
    const rows = await this.call<Array<Record<string, unknown>>>(
      'GET',
      `/nodes/${ProxmoxProvider.seg(node)}/storage/${ProxmoxProvider.seg(storage)}/content?content=backup&vmid=${vmid}`,
    );
    return rows.map((r) => ({ volid: String(r.volid), ctime: num(r.ctime), vmid: r.vmid === undefined ? undefined : num(r.vmid), size: r.size === undefined ? undefined : num(r.size) }));
  }
}
