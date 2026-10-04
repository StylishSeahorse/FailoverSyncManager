-- FailoverSyncManager initial schema (Phase 1).
-- See docs/design/03-database-schema.md for the rationale behind each table.


-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  disabled        boolean NOT NULL DEFAULT false,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash       text PRIMARY KEY,               -- sha256 of the cookie token; raw token never stored
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ---------------------------------------------------------------- secrets
CREATE TABLE secrets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose      text NOT NULL,                   -- e.g. 'cloudflare.api_token'
  ciphertext   bytea NOT NULL,                  -- AES-256-GCM
  iv           bytea NOT NULL,
  auth_tag     bytea NOT NULL,
  key_version  integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- topology
CREATE TABLE sites (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{1,8}$'),
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  designated_role    text NOT NULL CHECK (designated_role IN ('primary','secondary')),
  hosts_controller   boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sites_one_primary ON sites(designated_role) WHERE designated_role = 'primary';

CREATE TABLE proxmox_instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name             text NOT NULL,
  base_url         text NOT NULL,               -- https://pve-a.lan:8006
  token_id         text NOT NULL,               -- user@realm!tokenname (not secret)
  token_secret_id  uuid REFERENCES secrets(id),
  tls_ca_pem       text,
  tls_insecure     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);

CREATE TABLE npm_instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name             text NOT NULL,
  base_url         text NOT NULL,               -- http://npm-a.lan:81
  identity         text NOT NULL,               -- login e-mail (not secret)
  secret_id        uuid REFERENCES secrets(id), -- password
  tls_ca_pem       text,
  tls_insecure     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);

CREATE TABLE cloudflare_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL UNIQUE,
  account_id         text NOT NULL,             -- Cloudflare account tag
  api_token_secret_id uuid REFERENCES secrets(id),
  base_url           text NOT NULL DEFAULT 'https://api.cloudflare.com/client/v4',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cloudflare_zones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cloudflare_account_id uuid NOT NULL REFERENCES cloudflare_accounts(id) ON DELETE CASCADE,
  zone_id               text NOT NULL,          -- discovered, never typed by hand
  name                  text NOT NULL,
  discovered_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cloudflare_account_id, zone_id)
);

CREATE TABLE tunnels (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id               uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  cloudflare_account_id uuid NOT NULL REFERENCES cloudflare_accounts(id) ON DELETE CASCADE,
  tunnel_id             text NOT NULL,          -- tunnel UUID
  name                  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id),
  UNIQUE (cloudflare_account_id, tunnel_id)
);

-- ---------------------------------------------------------------- applications
CREATE TABLE applications (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,48}$'),
  name                         text NOT NULL,
  description                  text NOT NULL DEFAULT '',
  failover_priority            integer NOT NULL DEFAULT 100,
  max_replication_age_seconds  integer NOT NULL DEFAULT 900 CHECK (max_replication_age_seconds > 0),
  active_site_id               uuid REFERENCES sites(id),
  enabled                      boolean NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

-- A Proxmox VM/CT explicitly registered as part of an application.
-- Nothing that is not registered here is ever started or stopped.
CREATE TABLE workloads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id       uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  site_id              uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  proxmox_instance_id  uuid NOT NULL REFERENCES proxmox_instances(id) ON DELETE CASCADE,
  node                 text NOT NULL,
  vmid                 integer NOT NULL CHECK (vmid > 0),
  kind                 text NOT NULL DEFAULT 'qemu' CHECK (kind IN ('qemu','lxc')),
  expected_name        text NOT NULL,           -- verified against Proxmox before any action
  standby_state        text NOT NULL DEFAULT 'stopped' CHECK (standby_state IN ('stopped','running')),
  allow_start          boolean NOT NULL DEFAULT false,
  allow_stop           boolean NOT NULL DEFAULT false,
  replication_source   text NOT NULL DEFAULT 'none' CHECK (replication_source IN ('none','pve_replication','pve_backup')),
  replication_vmid     integer,                 -- guest id whose replication/backup proves freshness (defaults to vmid)
  backup_storage       text,                    -- storage id for pve_backup (e.g. a PBS datastore visible from this node)
  start_order          integer NOT NULL DEFAULT 100,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proxmox_instance_id, vmid)
);
CREATE INDEX workloads_app_idx ON workloads(application_id);

CREATE TABLE dns_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  zone_id             uuid NOT NULL REFERENCES cloudflare_zones(id) ON DELETE CASCADE,
  record_id           text NOT NULL,            -- Cloudflare record ID, discovered
  name                text NOT NULL,
  type                text NOT NULL CHECK (type IN ('A','AAAA','CNAME')),
  primary_content     text NOT NULL,
  secondary_content   text NOT NULL,
  ttl                 integer NOT NULL DEFAULT 1 CHECK (ttl = 1 OR ttl BETWEEN 30 AND 86400),
  proxied             boolean NOT NULL DEFAULT true,
  failover_priority   integer NOT NULL DEFAULT 100,
  last_verified_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zone_id, record_id),
  CHECK (primary_content <> secondary_content)
);

CREATE TABLE npm_expectations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  site_id           uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  npm_instance_id   uuid NOT NULL REFERENCES npm_instances(id) ON DELETE CASCADE,
  proxy_host_id     integer,                    -- discovered NPM id
  domain_names      text[] NOT NULL,
  forward_scheme    text NOT NULL CHECK (forward_scheme IN ('http','https')),
  forward_host      text NOT NULL,
  forward_port      integer NOT NULL CHECK (forward_port BETWEEN 1 AND 65535),
  require_ssl       boolean NOT NULL DEFAULT true,
  must_be_enabled   boolean NOT NULL DEFAULT true,
  allow_auto_enable boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, site_id, npm_instance_id)
);

-- ---------------------------------------------------------------- health
CREATE TABLE health_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  site_id             uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  application_id      uuid REFERENCES applications(id) ON DELETE CASCADE,  -- null = site-scoped
  category            text NOT NULL CHECK (category IN ('network','infrastructure','application','tunnel','traffic','replication')),
  type                text NOT NULL CHECK (type IN ('icmp','tcp','http','dns','proxmox_api','proxmox_node','proxmox_vm','tunnel','npm_api','npm_proxy_host','replication')),
  path                text NOT NULL DEFAULT 'sdwan' CHECK (path IN ('sdwan','internet','cloudflare_api','local')),
  independence_group  text NOT NULL,            -- checks in the same group count once for confirmation
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  interval_seconds    integer NOT NULL DEFAULT 15 CHECK (interval_seconds BETWEEN 5 AND 3600),
  timeout_ms          integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 100 AND 120000),
  critical            boolean NOT NULL DEFAULT true,
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_checks_site_idx ON health_checks(site_id);

CREATE TABLE health_check_state (
  check_id               uuid PRIMARY KEY REFERENCES health_checks(id) ON DELETE CASCADE,
  status                 text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','OK','WARNING','DEGRADED','FAILED')),
  consecutive_failures   integer NOT NULL DEFAULT 0,
  consecutive_successes  integer NOT NULL DEFAULT 0,
  first_failure_at       timestamptz,
  last_success_at        timestamptz,
  last_result_at         timestamptz,
  last_latency_ms        integer,
  last_message           text NOT NULL DEFAULT '',
  last_observed          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE health_check_results (
  id          bigserial PRIMARY KEY,
  check_id    uuid NOT NULL REFERENCES health_checks(id) ON DELETE CASCADE,
  ok          boolean NOT NULL,
  latency_ms  integer,
  message     text NOT NULL,
  observed    jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_check_results_check_time ON health_check_results(check_id, checked_at DESC);

-- ---------------------------------------------------------------- policy
CREATE TABLE policies (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                                text NOT NULL UNIQUE,
  is_active                           boolean NOT NULL DEFAULT false,
  automatic_failover                  boolean NOT NULL DEFAULT false,  -- Phase 2
  automatic_failback                  boolean NOT NULL DEFAULT false,  -- Phase 3; never true by default
  consecutive_failures                integer NOT NULL DEFAULT 5 CHECK (consecutive_failures >= 1),
  minimum_failure_duration_seconds    integer NOT NULL DEFAULT 60 CHECK (minimum_failure_duration_seconds >= 0),
  recovery_consecutive_successes      integer NOT NULL DEFAULT 5 CHECK (recovery_consecutive_successes >= 1),
  required_failed_groups              integer NOT NULL DEFAULT 3 CHECK (required_failed_groups >= 1),
  require_non_sdwan_failure           boolean NOT NULL DEFAULT true,
  minimum_secondary_health            text NOT NULL DEFAULT 'HEALTHY' CHECK (minimum_secondary_health IN ('HEALTHY','DEGRADED')),
  service_wait_timeout_seconds        integer NOT NULL DEFAULT 300,
  propagation_wait_seconds            integer NOT NULL DEFAULT 30,
  verify_timeout_seconds              integer NOT NULL DEFAULT 180,
  circuit_breaker_max_failovers       integer NOT NULL DEFAULT 2,      -- Phase 2
  circuit_breaker_window_seconds      integer NOT NULL DEFAULT 3600,   -- Phase 2
  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX policies_one_active ON policies(is_active) WHERE is_active;

-- ---------------------------------------------------------------- state
CREATE TABLE controller_state (
  id                    integer PRIMARY KEY CHECK (id = 1),
  failover_state        text NOT NULL,
  active_site_id        uuid REFERENCES sites(id),
  current_operation_id  uuid,
  monitoring_paused     boolean NOT NULL DEFAULT false,
  circuit_open          boolean NOT NULL DEFAULT false,
  version               integer NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_states (
  site_id     uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  state       text NOT NULL CHECK (state IN ('PRIMARY','SECONDARY','FAILED','PROMOTING','ACTIVE','DEGRADED','RECOVERY','MAINTENANCE')),
  reason      text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('failover','failback','dry_run','validate')),
  status            text NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  verdict           text,                         -- READY/NOT_READY for dry runs
  source_site_id    uuid REFERENCES sites(id),
  target_site_id    uuid REFERENCES sites(id),
  requested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name text NOT NULL,
  acknowledged      text[] NOT NULL DEFAULT '{}', -- overridable blockers explicitly accepted
  override_reason   text,
  cancel_requested  boolean NOT NULL DEFAULT false,
  current_stage     text,
  failed_stage      text,
  error             text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX operations_started_idx ON operations(started_at DESC);

CREATE TABLE operation_steps (
  id            bigserial PRIMARY KEY,
  operation_id  uuid NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  key           text NOT NULL,
  name          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('RUNNING','PASS','WARNING','FAIL','SKIPPED','PLANNED')),
  message       text NOT NULL DEFAULT '',
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (operation_id, seq)
);

CREATE TABLE state_transitions (
  id            bigserial PRIMARY KEY,
  machine       text NOT NULL,                  -- 'failover' or 'site:<code>'
  from_state    text NOT NULL,
  to_state      text NOT NULL,
  event         text NOT NULL,
  reason        text NOT NULL DEFAULT '',
  operation_id  uuid,
  actor         text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  severity        text NOT NULL CHECK (severity IN ('DEBUG','INFO','SUCCESS','WARNING','ERROR','CRITICAL')),
  category        text NOT NULL CHECK (category IN ('auth','config','health','failover','change','provider','system','security')),
  action          text NOT NULL,
  message         text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','system')),
  actor_id        uuid,
  actor_name      text NOT NULL,
  site_id         uuid,
  application_id  uuid,
  operation_id    uuid,
  ip              text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple', action || ' ' || message || ' ' || actor_name)) STORED
);
CREATE INDEX audit_events_at_idx ON audit_events(at DESC);
CREATE INDEX audit_events_search_idx ON audit_events USING gin(search);
CREATE INDEX audit_events_operation_idx ON audit_events(operation_id) WHERE operation_id IS NOT NULL;

-- Audit log is append-only.
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
