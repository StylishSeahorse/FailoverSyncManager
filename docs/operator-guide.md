# Operator guide

This guide covers deploying the controller, creating least-privilege
credentials, and configuring sites, applications and health checks. The
design documents in [`design/`](design/) explain why it behaves the way it does.

## What Phase 1 does and does not do

It does:

- Monitor both sites continuously across separate dimensions: site,
  application, replication and traffic/tunnel. Every check records which
  network path it uses and which independence group it belongs to.
- Answer one question on the dashboard: *if the active site disappeared right
  now, could production safely move to the other site?* The answer is YES or
  NO, with the reasons.
- Run **Test Failover**, a full dry run against live systems. It reads
  everything and changes nothing.
- Run **Failover Now**, a manual failover with a live preflight, a typed
  confirmation phrase, and administrator acknowledgement of any overridable
  blocker. Every overridden blocker needs a written reason.
- Cancel before routing changes, reconcile controller state from actual DNS,
  and pause or resume monitoring.
- Record every action, check transition and change in an append-only,
  searchable audit log.

It does not:

- Fail over automatically. Monitoring detects and reports only; a person starts
  every failover. The policy API refuses to enable automatic failover.
- Fail back. Failback, maintenance mode and key rotation come in later phases
  and return HTTP 501 for now.
- Roll back DNS automatically after a partial failure. The controller stops in
  `FAILOVER_FAILED`, shows exactly what changed, and you run **Reconcile** once
  you have decided what traffic should do.

## Where to run it

Run the controller at the **standby site (Site B)**, or at a third location. If
it runs at Site A, it is lost with Site A. It needs to reach:

| Target | Why | Typical path |
|---|---|---|
| Proxmox API at both sites (8006/tcp) | VM status, start, replication and backup age | SD-WAN for A, local for B |
| NPM admin API at both sites (81/tcp) | proxy host validation, optional enable | SD-WAN for A, local for B |
| `api.cloudflare.com` (443/tcp) | DNS records, tunnel health | internet |
| Public application URLs | traffic verification | internet |

Use `FSM_EGRESS_ALLOWLIST` to limit outbound connections to exactly these
hosts. The allowlist is enforced on the URL and again when the socket
connects, so a redirect or DNS rebinding cannot reach anything else.

## Deploying with Docker Compose

```sh
cd deploy
cp .env.example .env
# Fill in POSTGRES_PASSWORD, FSM_MASTER_KEY, FSM_INITIAL_ADMIN_PASSWORD
# and FSM_EGRESS_ALLOWLIST.
openssl rand -base64 32          # value for FSM_MASTER_KEY
./gen-self-signed-cert.sh failover.example.internal   # or copy tls.crt/tls.key into ./certs
docker compose up -d --build
```

Then open `https://<host>/` and sign in as the initial administrator. Remove
`FSM_INITIAL_ADMIN_PASSWORD` from `.env` afterwards; it is only used when no
users exist.

The stack has three containers:

- **web**: nginx terminating TLS, serving the dashboard and proxying `/api`.
- **server**: the controller. It runs as a non-root user with a read-only root
  filesystem.
- **postgres**: on an internal network with no published port.

On shutdown the server stops scheduling checks but lets a running failover
finish, so `stop_grace_period` is set to 5 minutes.

The HTTP to HTTPS redirect assumes the standard ports. If you change
`FSM_HTTPS_PORT`, adjust the redirect in `deploy/nginx.conf`.

### Back up the master key

`FSM_MASTER_KEY` encrypts every stored credential (AES-256-GCM). If it is lost,
the controller cannot decrypt its API tokens, and you have to re-enter them all.
Store it in your password manager, separately from database backups.

### Database backups

```sh
docker compose exec postgres pg_dump -U failover failover | gzip > failover-$(date +%F).sql.gz
```

## Least-privilege credentials

### Proxmox (one API token per site)

Create a dedicated user and role, then a privilege-separated token:

```sh
pveum user add failover@pve --comment "Failover controller"
pveum role add FailoverController -privs "Sys.Audit VM.Audit VM.PowerMgmt Datastore.Audit"
pveum aclmod / -user failover@pve -role FailoverController
pveum user token add failover@pve controller --privsep 1
pveum aclmod / -token 'failover@pve!controller' -role FailoverController
```

- `VM.PowerMgmt` is needed only where the controller may start standby VMs (a
  workload with *allow start* ticked). Leave it out at Site A, where Phase 1
  never powers anything on or off.
- To narrow further, grant the role on `/vms/<vmid>` for each standby VM, and
  `Sys.Audit` and `Datastore.Audit` on `/nodes/<node>` and `/storage/<id>`.
- Use the cluster's CA certificate (`/etc/pve/pve-root-ca.pem`) in the
  instance's *CA certificate* field rather than skipping TLS verification.

### Cloudflare

Create an API token with only:

- **Zone → DNS → Edit**, limited to the zones that hold the managed records.
- **Account → Cloudflare Tunnel → Read**, for the account that owns both tunnels.

Optionally restrict the token to the controller's public egress IP.

### Nginx Proxy Manager (one user per site)

Create a user that is not an administrator, with **Proxy Hosts: Manage** and
everything else hidden. With *View* only, validation works, but the controller
cannot enable a disabled proxy host during failover.

## Configuration walkthrough

1. **Sites**: add Site A (designated primary) and Site B (designated
   secondary). Tick *hosts controller* on the site where it runs.
2. **Integrations**:
   1. Add a Proxmox and an NPM instance per site, plus the Cloudflare account.
   2. Use **Validate** on each.
   3. On the Cloudflare account, use **Discover zones**, then add a tunnel per site.
3. **Applications**: add each application, for example WordPress, Invoice
   Ninja or Nextcloud. On its page, add:
   - **Workloads**: the VM at each site. The controller checks the VMID and
     name against Proxmox when you save. For a cold standby at Site B, set
     *normal state* to *stopped* and tick *allow start*. Set *replication
     source* to Proxmox replication or Proxmox backup, so the controller can
     measure data age.
   - **DNS records**: pick the live Cloudflare record, then give its content
     for each site (normally `<tunnel-id>.cfargotunnel.com`). The controller
     refuses a record whose live content matches neither value.
   - **NPM proxy hosts**: the proxy host at the standby site that must be ready,
     copied from the live host with *copy from live*.
4. **Health checks**: see below.
5. **Policy**: review the thresholds. A check is FAILED after 5 consecutive
   failures spanning at least 60 seconds. A site is confirmed failed only
   when checks fail in 3 independence groups, at least one of them seen
   outside the SD-WAN.
6. Run **Test Failover** and read every step.

## Health checks

Each check has:

- **Type and config**, as described below.
- **Category**: network, infrastructure, application, tunnel, traffic or
  replication.
- **Path**: `sdwan`, `internet`, `cloudflare_api` or `local`. This says how the
  controller reaches the target.
- **Independence group**: checks in the same group count as one signal when
  the controller decides whether a site has failed.

### Why independence groups matter

An SD-WAN outage makes every SD-WAN check against Site A fail at once, even
when Site A is serving customers perfectly well. To guard against this, the
controller treats a site as confirmed failed only when:

- checks fail in at least `requiredFailedGroups` different groups, and
- (by default) at least one of the failing checks does not use the SD-WAN, for
  example the public URL or the Cloudflare tunnel status.

A suggested set for Site A:

| Check | Type | Path | Group |
|---|---|---|---|
| Site A ICMP to the Proxmox host | `icmp` | sdwan | `icmp` |
| Proxmox A API | `proxmox_api` | sdwan | `proxmox` |
| Tunnel A status from Cloudflare | `tunnel` | cloudflare_api | `tunnel` |
| WordPress public via A | `http` | internet | `public-https` |

And for Site B (the standby):

| Check | Type | Path | Group |
|---|---|---|---|
| Proxmox B API | `proxmox_api` | local | `proxmox` |
| Proxmox B node | `proxmox_node` | local | `proxmox-node` |
| NPM B API | `npm_api` | local | `npm` |
| WordPress NPM B | `npm_proxy_host` | local | `npm-host` |
| Tunnel B | `tunnel` | cloudflare_api | `tunnel` |
| WordPress replication | `replication` | local | `replication` |
| WordPress public via B | `http` | internet | `public-https` |

Traffic checks against the standby site are skipped while it is not serving.
They run during failover verification instead.

### Config examples

ICMP (the container includes `ping`):

```json
{ "host": "10.0.0.10" }
```

TCP:

```json
{ "host": "10.0.0.10", "port": 8006 }
```

HTTP with content checks. Put the WordPress login form here, Nextcloud's
`/status.php`, or Invoice Ninja's health endpoint:

```json
{
  "url": "https://www.example.com/wp-login.php",
  "expectStatus": [200],
  "bodyContains": ["wp-submit"],
  "header": { "name": "x-served-by", "equals": "site-a" }
}
```

```json
{
  "url": "https://cloud.example.com/status.php",
  "json": [{ "path": "installed", "equals": true }, { "path": "maintenance", "equals": false }]
}
```

To test one site's NPM directly while the public name points elsewhere,
target its address and send the public host name:

```json
{ "url": "https://10.1.0.20/status.php", "hostHeader": "cloud.example.com", "caPem": "-----BEGIN CERTIFICATE-----..." }
```

A response header that names the serving site (for example
`add_header X-Served-By site-b;` in the NPM advanced config) lets the
controller *prove* where traffic landed after failover. It is strongly
recommended.

DNS:

```json
{ "name": "www.example.com", "recordType": "CNAME", "expect": ["aaaaaaaa-....cfargotunnel.com"], "server": "1.1.1.1" }
```

Proxmox. Ids are the controller's own ids, shown on the Integrations page:

```json
{ "proxmoxInstanceId": "<uuid>" }
{ "proxmoxInstanceId": "<uuid>", "node": "pve-b", "maxCpu": 0.9, "maxMemory": 0.9 }
{ "proxmoxInstanceId": "<uuid>", "node": "pve-b", "vmid": 230, "kind": "qemu", "expectStatus": "stopped" }
```

Tunnel, NPM and replication:

```json
{ "tunnelRef": "<controller tunnel uuid>" }
{ "npmInstanceId": "<uuid>" }
{ "expectationId": "<NPM proxy host expectation uuid>" }
{}
```

A replication check reads the application's workloads at its site. It uses
Proxmox replication job status, or the newest backup in the configured
storage, and compares the age to the application's *maximum replication age*.

## Running a failover

1. Check the dashboard. A NO verdict lists exactly what is wrong.
2. Run **Test Failover** and read the step report. It shows every VM that
   would start and every DNS record that would change.
3. Press **Failover now…**. A fresh live preflight runs.
   - Blockers that cannot be overridden (for example, an unreachable standby
     NPM or a DNS record that does not match its configuration) must be fixed.
   - Overridable blockers can only be acknowledged by an administrator, with a
     written reason. Examples: Site A still reachable (a planned switchover),
     replication older than its limit, or a degraded standby.
4. Type the confirmation phrase, for example `FAILOVER TO SITE B`.
5. Follow the step timeline. The steps run in this order:
   1. Start the standby VMs.
   2. Wait for the applications to answer.
   3. Re-validate NPM and the tunnel.
   4. Update DNS.
   5. Wait for propagation.
   6. Verify public traffic, preferably by the served-by header.
6. After success, Site A is out of service. Do not bring it back into
   production until its data has been resynchronised from Site B. Controlled
   failback arrives in Phase 3.

If a step fails after DNS has started changing, the controller stops in
`FAILOVER_FAILED` and changes nothing further. Read the operation's change
list, fix or decide, then run **Reconcile**.

## Trying it locally without infrastructure

The demo runs the real controller against fake Cloudflare, Proxmox, NPM and
application servers on 127.0.0.1. Nothing real is contacted.

```sh
# PostgreSQL reachable at DATABASE_URL (a scratch schema is created and dropped)
DATABASE_URL=postgres://user:pass@localhost:5432/db npm run demo -w server
npm run dev -w web       # http://localhost:5173
```

Sign in as `admin`, `operator` or `viewer` with the password
`demo password 123`. Type `k` and Enter in the demo terminal to take Site A
down, and `r` and Enter to bring it back.
