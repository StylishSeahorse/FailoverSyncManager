# 7. Security model

FSM can redirect all production traffic and start/stop VMs. Compromise of FSM
is equivalent to compromise of routing for every protected application, so it
is designed as a security-sensitive system first.

## 7.1 Threats considered

| Threat | Control |
|---|---|
| Stolen DB dump / backup | Secrets encrypted with AES-256-GCM under a master key that is **not** in the DB (`FSM_MASTER_KEY`, 32 random bytes, base64). Sessions stored as SHA-256 hashes. Passwords hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt). |
| Credential exposure through UI/API | Secret fields are write-only: APIs accept `{ "apiToken": "..." }` and return only `{ "apiTokenConfigured": true }`. No endpoint returns a decrypted secret. |
| Credentials in logs | Structured logger with redaction paths (`*.password`, `*.token`, `authorization`, `cookie`, …); provider errors are passed through `redact()` which strips bearer tokens, `PVEAPIToken=` values and known secret values before audit/log. A unit test feeds every secret through every error path. |
| Session theft / XSS | Cookie `fsm_session`: `HttpOnly`, `Secure` (prod), `SameSite=Strict`, `Path=/`, 12 h absolute + 30 min idle expiry. Strict CSP via `@fastify/helmet`; the UI does not use `dangerouslySetInnerHTML`. |
| CSRF | Per-session CSRF token returned by `/api/auth/me`, required in `X-CSRF-Token` on every state-changing request (constant-time compare), plus `SameSite=Strict`. |
| Brute force | `@fastify/rate-limit` (global 300/min/IP; login 10/min/IP); account lockout after 5 failures for 15 min; generic "invalid credentials" message. |
| Privilege misuse | RBAC (below); every mutation audited with actor, IP, before/after (redacted). |
| Accidental or malicious mass DNS change | FSM only edits records registered as managed; refuses records whose current content is not one of the two registered targets; Cloudflare token scoped to `Zone:DNS:Edit` on selected zones only. |
| Arbitrary VM control | Only registered workloads, with `allow_start`/`allow_stop`, after verifying `expected_name`. Proxmox token role grants only `VM.PowerMgmt` + `VM.Audit` + `Datastore.Audit` + `Sys.Audit` on the specific VM pool. |
| Tests or dev calling production APIs | Single egress HTTP client enforces `FSM_EGRESS_ALLOWLIST`; tests set it to loopback. |
| MITM to Proxmox/NPM | TLS verification on by default; per-instance CA PEM pinning; `tls_insecure` is allowed but shown as a red warning and audited when set. |
| Replay of dangerous actions | Failover execute requires a typed confirmation phrase (`FAILOVER TO SITE B`) and fresh CSRF; overrides need an explicit list of acknowledged blocker keys plus a reason. |

## 7.2 RBAC

| Capability | viewer | operator | admin |
|---|:-:|:-:|:-:|
| View dashboard, health, events, operations | ✓ | ✓ | ✓ |
| Validate site/Cloudflare/NPM/Proxmox, Test Failover (dry run) | | ✓ | ✓ |
| Prepare / Execute / Cancel failover, Reconcile | | ✓ | ✓ |
| Override (acknowledge) blockers ("Force Failover") | | | ✓ |
| Pause / resume monitoring | | ✓ | ✓ |
| Edit sites, applications, checks, DNS records, NPM expectations, policies | | | ✓ |
| Set credentials, manage users | | | ✓ |

## 7.3 Least-privilege provider credentials

* **Cloudflare:** API token with `Zone → DNS → Edit` and `Zone → Zone → Read`
  for the selected zones only, plus `Account → Cloudflare Tunnel → Read` for
  tunnel status. Never a Global API Key.
* **Proxmox:** dedicated user `fsm@pve`, API token with privilege separation,
  custom role `FSMOperator` = `VM.Audit, VM.PowerMgmt, Datastore.Audit,
  Sys.Audit`, assigned on `/vms/<id>` for registered VMs (or a pool) and
  `/nodes/<node>` for status, `/storage/<id>` for backup listing.
* **NPM:** NPM has no fine-grained roles; use a dedicated user with
  "Manage" on proxy hosts only and "View" on certificates.

## 7.4 Transport

The Compose stack terminates TLS in nginx (operator certificate, or a
self-signed one generated on first start). The API server binds to the
internal Docker network only. HSTS is set. The controller should additionally
be reachable only from the management network or via Cloudflare Access.

## 7.5 Key management

`FSM_MASTER_KEY` is required at startup; the server refuses to start without a
32-byte key. `key_version` on each secret allows rotation (Phase 2): set
`FSM_MASTER_KEY_PREVIOUS`, start, run a rotate command that re-encrypts
every secret under the new key. Losing the key means re-entering credentials;
it never means data loss for the protected applications.
