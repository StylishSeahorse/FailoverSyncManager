// Shapes returned by the controller API. Dates arrive as ISO strings.

export type Role = 'admin' | 'operator' | 'viewer';
export type DimensionStatus = 'HEALTHY' | 'UNKNOWN' | 'WARNING' | 'DEGRADED' | 'FAILED';
export type CheckStatus = 'UNKNOWN' | 'OK' | 'WARNING' | 'DEGRADED' | 'FAILED';
export type StepStatus = 'RUNNING' | 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED' | 'PLANNED';
export type Severity = 'DEBUG' | 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface Me {
  user: { id: string; username: string; role: Role };
  csrfToken: string;
}

export interface Dimension {
  status: DimensionStatus;
  reasons: string[];
  checks: Array<{ id: string; name: string; status: CheckStatus; message: string; critical: boolean }>;
}

export interface ReadinessItem {
  key: string;
  group: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  message: string;
}

export interface Readiness {
  question: string;
  ready: boolean;
  verdict: 'FAILOVER READY' | 'FAILOVER READY WITH WARNINGS' | 'FAILOVER NOT SAFE';
  sourceSiteId: string | null;
  targetSiteId: string | null;
  items: ReadinessItem[];
  estimatedMaxDataLossSeconds: number | null;
  primary: { level: string; reasons: string[] } | null;
  evaluatedAt: string;
}

export interface SiteView {
  id: string;
  code: string;
  name: string;
  designatedRole: 'primary' | 'secondary';
  hostsController: boolean;
  active: boolean;
  state: string | null;
  stateReason: string;
  health: { site: Dimension; tunnel: Dimension; traffic: Dimension };
  providers: { proxmox: Dimension; npm: Dimension; tunnel: Dimension };
}

export interface AppView {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  failoverPriority: number;
  activeSiteId: string | null;
  standbySiteId: string | null;
  standbyMode: 'cold' | 'warm' | null;
  perSite: Record<string, Dimension>;
  replication: { ageSeconds: number | null; maxAgeSeconds: number; safety: 'SAFE' | 'WARNING' | 'UNSAFE' | 'UNKNOWN'; message: string };
}

export interface Operation {
  id: string;
  kind: 'failover' | 'failback' | 'dry_run' | 'validate';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  verdict: string | null;
  sourceSiteId: string | null;
  targetSiteId: string | null;
  requestedByName: string;
  acknowledged: string[];
  overrideReason: string | null;
  cancelRequested: boolean;
  currentStage: string | null;
  failedStage: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  summary: Record<string, unknown>;
  steps?: OperationStep[];
}

export interface OperationStep {
  id: number;
  seq: number;
  key: string;
  name: string;
  status: StepStatus;
  message: string;
  details: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

export interface AuditEvent {
  id: number;
  at: string;
  severity: Severity;
  category: string;
  action: string;
  message: string;
  actorType: 'user' | 'system';
  actorName: string;
  siteId: string | null;
  applicationId: string | null;
  operationId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

export interface SystemStatus {
  controller: {
    failoverState: string;
    activeSiteId: string | null;
    currentOperationId: string | null;
    monitoringPaused: boolean;
    circuitOpen: boolean;
    updatedAt: string;
    automaticFailover: boolean;
  };
  sites: SiteView[];
  cloudflare: { status: string; message: string };
  applications: AppView[];
  readiness: Readiness;
  operation: Operation | null;
  recentEvents: AuditEvent[];
  serverTime: string;
}

export interface Blocker {
  key: string;
  message: string;
  overridable: boolean;
}

export interface PreflightReport {
  sourceSiteId: string;
  targetSiteId: string;
  verdict: 'READY FOR FAILOVER' | 'READY WITH WARNINGS' | 'NOT READY';
  steps: Array<{ key: string; name: string; status: StepStatus; message: string; details?: Record<string, unknown> }>;
  blockers: Blocker[];
  overridable: string[];
  estimatedMaxDataLossSeconds: number | null;
  confirmationPhrase: string;
}

export interface Site {
  id: string;
  code: string;
  name: string;
  description: string;
  designatedRole: 'primary' | 'secondary';
  hostsController: boolean;
  state: string | null;
  stateReason: string;
  active: boolean;
}

export interface ProxmoxInstance {
  id: string;
  siteId: string;
  name: string;
  baseUrl: string;
  tokenId: string;
  tokenSecretConfigured: boolean;
  tlsCaConfigured: boolean;
  tlsInsecure: boolean;
}

export interface NpmInstance {
  id: string;
  siteId: string;
  name: string;
  baseUrl: string;
  identity: string;
  passwordConfigured: boolean;
  tlsCaConfigured: boolean;
  tlsInsecure: boolean;
}

export interface CloudflareAccount {
  id: string;
  name: string;
  accountId: string;
  baseUrl: string;
  apiTokenConfigured: boolean;
}

export interface CloudflareZone {
  id: string;
  cloudflareAccountId: string;
  zoneId: string;
  name: string;
}

export interface Tunnel {
  id: string;
  siteId: string;
  cloudflareAccountId: string;
  tunnelId: string;
  name: string;
}

export interface Application {
  id: string;
  slug: string;
  name: string;
  description: string;
  failoverPriority: number;
  maxReplicationAgeSeconds: number;
  activeSiteId: string | null;
  enabled: boolean;
}

export interface Workload {
  id: string;
  applicationId: string;
  siteId: string;
  proxmoxInstanceId: string;
  node: string;
  vmid: number;
  kind: 'qemu' | 'lxc';
  expectedName: string;
  standbyState: 'stopped' | 'running';
  allowStart: boolean;
  allowStop: boolean;
  replicationSource: string;
  startOrder: number;
}

export interface DnsRecord {
  id: string;
  applicationId: string;
  zoneId: string;
  recordId: string;
  name: string;
  type: string;
  primaryContent: string;
  secondaryContent: string;
  ttl: number;
  proxied: boolean;
}

export interface NpmExpectation {
  id: string;
  siteId: string;
  npmInstanceId: string;
  proxyHostId: number;
  domainNames: string[];
  forwardScheme: string;
  forwardHost: string;
  forwardPort: number;
  mustBeEnabled: boolean;
  allowAutoEnable: boolean;
}

export interface HealthCheck {
  id: string;
  name: string;
  siteId: string;
  applicationId: string | null;
  category: string;
  type: string;
  path: string;
  independenceGroup: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  timeoutMs: number;
  critical: boolean;
  enabled: boolean;
  state?: { status: CheckStatus; lastMessage: string; lastResultAt: string | null; lastLatencyMs: number | null; consecutiveFailures: number } | null;
}

export interface Policy {
  automaticFailover: boolean;
  automaticFailback: boolean;
  consecutiveFailures: number;
  minimumFailureDurationSeconds: number;
  recoveryConsecutiveSuccesses: number;
  requiredFailedGroups: number;
  requireNonSdwanFailure: boolean;
  minimumSecondaryHealth: 'HEALTHY' | 'DEGRADED';
  serviceWaitTimeoutSeconds: number;
  propagationWaitSeconds: number;
  verifyTimeoutSeconds: number;
  circuitBreakerMaxFailovers: number;
  circuitBreakerWindowSeconds: number;
}

export interface UserView {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}
