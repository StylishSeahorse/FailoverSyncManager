# 1. Architecture analysis, dangerous assumptions, missing information

This document is the first deliverable of the development method (spec §33). It
records what the controller is really being asked to do, where the obvious
design would be unsafe, and what we still need to know from the operator.

## 1.1 What the system actually is

FailoverSyncManager (FSM) is a **single decision-maker** for a two-site
deployment. The sites never decide for themselves; the controller observes
both, decides, and is the only component that changes routing (Cloudflare DNS),
starts/stops protected workloads (Proxmox) or touches reverse-proxy state (NPM).

The "active site" is therefore not a property a site claims about itself. It is
a fact recorded by the controller **and** verifiable from the outside world: the
content of the managed Cloudflare DNS records. The controller always treats the
DNS records as the ground truth for "where is traffic going", and its own
database as the ground truth for "what did we intend and why".

Four independent health dimensions are tracked separately (spec §3, §8):

| Dimension | Question | Typical signals |
|---|---|---|
| Site | Is the site/host/network up? | ICMP/TCP over SD-WAN, Proxmox API, node status |
| Application | Does WordPress/Invoice Ninja/Nextcloud work? | HTTPS + content/JSON assertions, app health endpoints, DB port |
| Replication | Is the standby data fresh enough to promote? | Proxmox replication jobs, backup timestamps |
| Traffic | Can users actually reach the active site? | Cloudflare tunnel status + ingress, public HTTPS through Cloudflare, NPM config |

A site is only promoted when all *required* conditions hold, and every decision
is explained as a list of concrete checks that passed or failed (spec §34, §35).

## 1.2 Dangerous assumptions (and what the design does about them)

These are the assumptions that a naive "ping and switch DNS" script makes. Each
one would cause a false failover, split-brain or silent data loss.

### D1. "If the controller can't reach Site A, Site A is down."
The controller VM lives *somewhere*. If it lives at Site B, an SD-WAN outage
makes Site A look dead while Site A is still happily serving users through
Tunnel A. Failing over then moves users to stale data and creates two
diverging copies of the application data (the real-world split-brain for this
topology).

**Mitigation:** every health check is tagged with the **path** it uses
(`sdwan`, `internet`, `cloudflare_api`, `local`) and an **independence group**.
Site failure is only *confirmed* when failures are observed across a
configurable number of independent groups, and the policy can require that at
least one failing group uses a path that does not traverse the SD-WAN
(e.g. Cloudflare reports Tunnel A has zero connections, *and* the public HTTPS
endpoint via Cloudflare fails). An SD-WAN-only outage is reported as
"Site A unreachable over SD-WAN; reachable via internet: failover NOT
recommended".

### D2. "If the controller lives at Site A it can still fail over."
If the controller runs at Site A it disappears with Site A, and nothing fails
over. **Recommendation:** run the controller at Site B, or (better) at a third
location. The witness design (Phase 3) addresses this properly. The UI shows
where the controller is deployed (config value) and warns if it is co-located
with the primary.

### D3. "Tunnel up = site up = app up."
Explicitly false (spec §8). Tunnel connectivity, site health and application
health are separate check categories and are aggregated separately.

### D4. "HTTP 200 means the app works."
WordPress returns 200 for a "database connection error" page in some setups;
Nextcloud returns 200 from `status.php` while `maintenance: true`. HTTP checks
support status + body substring/regex + negative content + JSON path assertions
(`installed == true`, `maintenance == false`), and DB port checks.

### D5. "Changing DNS is instant and atomic."
Multiple records change one at a time and any call can fail halfway. Each
record change is recorded individually (before/after), re-read for
verification, and a partial failure stops the sequence in `FAILOVER_FAILED`
with the exact per-record state. **No automatic rollback** back to a site we
just confirmed as failed; the operator reconciles from a screen that shows
actual DNS content. Proxied records change at the Cloudflare edge in seconds;
unproxied records are subject to TTL and resolver caching.

### D6. "Cloudflare Tunnel B will serve the hostname once DNS points at it."
With Cloudflare Tunnel, a CNAME to `<tunnel-B>.cfargotunnel.com` only works if
Tunnel B's ingress rules include that hostname. Otherwise Cloudflare returns
an error page. The tunnel validation step checks Tunnel B's remotely-managed
configuration for every hostname being moved (locally-managed configs cannot be
read via API: reported as WARNING "cannot verify ingress").

### D7. "We can check Site B's apps before switching DNS."
Not through the production hostname; it still points at A. Each site needs a
**validation hostname** per app (e.g. `wp-b.example.com`) permanently routed
through its own tunnel, or an internal URL over the SD-WAN. Pre-promotion
application checks run against those.

### D8. "Users reaching the site = users reaching Site B."
After the DNS switch a 200 response could still come from Site A (stale
caches, wrong record). Traffic verification checks a **site marker** (e.g. a
response header `X-Served-By: site-b` added in NPM B's advanced config, or a
body marker) so we can prove which site answered.

### D9. "A backup exists, so the standby is safe."
Backup available ≠ replication current (spec §12). Replication age is computed
per application from the newest successful replication/backup of the
*secondary* workload, compared against the app's maximum acceptable data age.
Stale data blocks promotion unless the operator explicitly acknowledges it.

### D10. "A planned switchover is harmless."
Failing over while Site A is still healthy and accepting writes loses
everything written since the last replication. Manual failover with a healthy
primary is a separate, explicitly-acknowledged blocker ("primary is still
serving; writes since last replication will be lost").

### D11. "Starting the standby VM is safe."
If the standby VM's disks are a replica target, starting it may break
replication or diverge data. Workloads must be explicitly registered with
`allow_start` / `allow_stop` flags; nothing unregistered is ever touched, and
VM IDs are verified against their registered name before any action.

### D12. "DNS records are identified by name."
Names can be duplicated (multiple A records) and edited by humans. Records are
discovered and stored by Cloudflare record ID, and *before every change* the
current content is compared with the expected primary content. If someone
changed it out-of-band, FSM refuses to touch it.

### D13. "One controller process = no concurrency."
Manual actions from two browser tabs, an automatic trigger (Phase 2) and a
dry-run can race. All operations take a PostgreSQL advisory lock plus an
optimistic version check on the controller state row.

### D14. "TLS to Proxmox/NPM can be skipped because it's internal."
Self-signed certificates are common. Each instance can pin a CA certificate;
"skip verification" exists but is flagged as insecure in the UI and audit log.

### D15. "Tests can point at the real APIs carefully."
Never. All outbound HTTP goes through one client with a host allow-list; the
test suite sets the allow-list to loopback only so a misconfigured test fails
closed instead of calling Cloudflare/Proxmox/NPM.

## 1.3 Missing information (questions for the operator)

Recommended defaults are what Phase 1 implements until told otherwise.

| # | Question | Default chosen |
|---|---|---|
| Q1 | Where does the controller VM run: Site A, Site B or a third location? | Assume Site B; UI warns if configured as Site A. |
| Q2 | How is data copied from A to B today: Proxmox storage replication (same cluster, ZFS), PBS backups + restore, application-level replication (MariaDB/Postgres replicas, rsync)? | Support Proxmox replication jobs and Proxmox backup timestamps; app-level replication reported via a custom HTTP "replication age" check. |
| Q3 | Are the Site B VMs normally **stopped** (cold standby) or **running** (warm standby)? | Configurable per workload; default `stopped` with `allow_start = true`. |
| Q4 | Are Site A and Site B separate Proxmox clusters or one stretched cluster? | Separate clusters (separate API endpoints/tokens). |
| Q5 | Are the Cloudflare tunnels remotely managed (dashboard) or locally managed (config.yml)? | Remotely managed; locally managed degrades ingress validation to WARNING. |
| Q6 | How do DNS records point to the tunnels today: CNAME to `<uuid>.cfargotunnel.com` per site? | Yes; failover rewrites the CNAME content. |
| Q7 | Can each app get a per-site validation hostname (e.g. `wp-a`/`wp-b`) and a site marker header in NPM? | Recommended; without them pre-promotion and post-switch verification are WARNING, not PASS. |
| Q8 | Do NPM A and NPM B proxy to local IPs at their own site (different upstreams per site)? | Yes; expectations are defined per site. |
| Q9 | What should happen to Site A when it is confirmed failed but partly reachable (fencing)? Stop A's VMs? Disable NPM A hosts? | Phase 1: no automatic fencing; offered as explicit optional steps in Phase 2/3. |
| Q10 | Maximum acceptable data age per app? | 15 min WordPress/Invoice Ninja, 15 min Nextcloud (configurable). |
| Q11 | Email (SMTP) / Discord webhook details for notifications? | Phase 2. |
| Q12 | Single admin user or several people with roles? | RBAC with admin/operator/viewer; first admin created from env on first boot. |
| Q13 | How is HTTPS terminated for the controller UI itself? | Nginx container with operator-supplied cert, or behind Cloudflare Access. Self-signed generated if none provided. |

## 1.4 Scope of Phase 1

Per spec §32: authentication, dashboard, site configuration, application
configuration, health-check engine, Cloudflare integration, Proxmox
integration, basic NPM integration, state machine, manual failover, dry-run
failover and audit logs.

Phase 1 additionally includes *basic* replication-age reporting (the Proxmox
provider must read backup/replication status anyway, and manual failover must
not promote known-stale data). Automatic failover, notifications, circuit
breaker, maintenance mode, failback, witness and metrics are designed for here
(tables and interfaces are shaped for them) but implemented in Phases 2–3.
