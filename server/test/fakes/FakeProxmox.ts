import { FakeServer, type FakeRequest, type FakeResponse } from './FakeServer.js';

export interface FakeGuest {
  vmid: number;
  name: string;
  status: 'running' | 'stopped';
  kind: 'qemu' | 'lxc';
  /** If set, a start task fails with this exit status. */
  failStart?: string;
}

/** Stateful fake of the subset of the Proxmox VE API FSM uses. */
export class FakeProxmox extends FakeServer {
  tokenId = 'fsm@pve!fsm';
  tokenSecret = '11111111-2222-3333-4444-555555555555';
  nodeName: string;
  nodeStatus: 'online' | 'offline' = 'online';
  cpu = 0.12;
  mem = { used: 4e9, total: 16e9 };
  guests: FakeGuest[] = [];
  storage = [{ storage: 'local-zfs', active: 1, enabled: 1, total: 1e12, used: 3e11, avail: 7e11, content: 'images,rootdir' }];
  replication: Array<{ id: string; guest: number; last_sync: number; fail_count: number; error?: string }> = [];
  backups: Array<{ storage: string; vmid: number; ctime: number; volid: string }> = [];
  private tasks = new Map<string, { status: string; exitstatus?: string }>();
  private taskSeq = 0;

  constructor(nodeName: string) {
    super((req) => this.route(req));
    this.nodeName = nodeName;
  }

  guest(vmid: number): FakeGuest | undefined {
    return this.guests.find((g) => g.vmid === vmid);
  }

  private route(req: FakeRequest): FakeResponse {
    if (req.headers.authorization !== `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`) {
      return { status: 401, body: { data: null }, headers: { 'x-proxmox-error': 'invalid token value' } };
    }
    const p = req.path.replace(/^\/api2\/json/, '');
    const data = (d: unknown): FakeResponse => ({ body: { data: d } });
    let m: RegExpMatchArray | null;
    if (p === '/version') return data({ version: '8.2.4', release: '8.2' });
    if (p === '/nodes') {
      return data([
        { node: this.nodeName, status: this.nodeStatus, cpu: this.cpu, maxcpu: 8, mem: this.mem.used, maxmem: this.mem.total, uptime: 1000 },
      ]);
    }
    m = p.match(/^\/nodes\/([^/]+)(\/.*)?$/);
    if (!m) return { status: 404, body: { data: null } };
    if (m[1] !== this.nodeName) return { status: 500, body: { data: null }, headers: { 'x-proxmox-error': `hostname lookup '${m[1]}' failed` } };
    if (this.nodeStatus === 'offline') return { status: 595, body: { data: null }, headers: { 'x-proxmox-error': 'no route to host' } };
    const rest = m[2] ?? '';
    if (rest === '/status') return data({ cpu: this.cpu, memory: this.mem, rootfs: { used: 1e10, total: 1e11 }, uptime: 1000 });
    if (rest === '/qemu' || rest === '/lxc') {
      const kind = rest.slice(1);
      return data(this.guests.filter((g) => g.kind === kind).map((g) => ({ vmid: g.vmid, name: g.name, status: g.status })));
    }
    if (rest === '/storage') return data(this.storage);
    if (rest === '/replication') return data(this.replication);
    if ((m = rest.match(/^\/storage\/([^/]+)\/content$/))) {
      const vmid = Number(req.query.get('vmid'));
      return data(this.backups.filter((b) => b.storage === m![1] && b.vmid === vmid).map((b) => ({ ...b, content: 'backup', format: 'pbs-vm' })));
    }
    if ((m = rest.match(/^\/(qemu|lxc)\/(\d+)\/status\/(current|start|stop|shutdown|reboot)$/))) {
      const g = this.guests.find((x) => x.vmid === Number(m![2]) && x.kind === m![1]);
      if (!g) return { status: 500, body: { data: null }, headers: { 'x-proxmox-error': `Configuration file does not exist` } };
      const action = m[3]!;
      if (action === 'current') return data({ vmid: g.vmid, name: g.name, status: g.status, qmpstatus: g.status });
      if (req.method !== 'POST') return { status: 501, body: { data: null } };
      const upid = `UPID:${this.nodeName}:${(++this.taskSeq).toString(16)}:qm${action}:${g.vmid}:fsm@pve!fsm:`;
      if (action === 'start' && g.failStart) {
        this.tasks.set(upid, { status: 'stopped', exitstatus: g.failStart });
      } else {
        g.status = action === 'start' || action === 'reboot' ? 'running' : 'stopped';
        this.tasks.set(upid, { status: 'stopped', exitstatus: 'OK' });
      }
      return data(upid);
    }
    if ((m = rest.match(/^\/tasks\/([^/]+)\/status$/))) {
      const t = this.tasks.get(decodeURIComponent(m[1]!));
      return t ? data(t) : { status: 500, body: { data: null }, headers: { 'x-proxmox-error': 'no such task' } };
    }
    return { status: 501, body: { data: null }, headers: { 'x-proxmox-error': `Method '${req.method} ${p}' not implemented` } };
  }
}
