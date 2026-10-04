/** Domain shapes as read from the database (camelCase mirrors of the tables). */

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  disabled: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface Site {
  id: string;
  code: string;
  name: string;
  description: string;
  designatedRole: 'primary' | 'secondary';
  hostsController: boolean;
}

export interface ProxmoxInstance {
  id: string;
  siteId: string;
  name: string;
  baseUrl: string;
  tokenId: string;
  tokenSecretId: string | null;
  tlsCaPem: string | null;
  tlsInsecure: boolean;
  updatedAt: Date;
}

export interface NpmInstance {
  id: string;
  siteId: string;
  name: string;
  baseUrl: string;
  identity: string;
  secretId: string | null;
  tlsCaPem: string | null;
  tlsInsecure: boolean;
  updatedAt: Date;
}

export interface CloudflareAccount {
  id: string;
  name: string;
  accountId: string;
  apiTokenSecretId: string | null;
  baseUrl: string;
  updatedAt: Date;
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
  replicationSource: 'none' | 'pve_replication' | 'pve_backup';
  replicationVmid: number | null;
  backupStorage: string | null;
  startOrder: number;
}

export interface DnsRecord {
  id: string;
  applicationId: string;
  zoneId: string;
  recordId: string;
  name: string;
  type: 'A' | 'AAAA' | 'CNAME';
  primaryContent: string;
  secondaryContent: string;
  ttl: number;
  proxied: boolean;
  failoverPriority: number;
  lastVerifiedAt: Date | null;
}

export interface NpmExpectation {
  id: string;
  applicationId: string;
  siteId: string;
  npmInstanceId: string;
  proxyHostId: number | null;
  domainNames: string[];
  forwardScheme: 'http' | 'https';
  forwardHost: string;
  forwardPort: number;
  requireSsl: boolean;
  mustBeEnabled: boolean;
  allowAutoEnable: boolean;
}

export type CheckCategory = 'network' | 'infrastructure' | 'application' | 'tunnel' | 'traffic' | 'replication';
export type CheckType =
  | 'icmp'
  | 'tcp'
  | 'http'
  | 'dns'
  | 'proxmox_api'
  | 'proxmox_node'
  | 'proxmox_vm'
  | 'tunnel'
  | 'npm_api'
  | 'npm_proxy_host'
  | 'replication';
export type CheckPath = 'sdwan' | 'internet' | 'cloudflare_api' | 'local';

export interface HealthCheck {
  id: string;
  name: string;
  siteId: string;
  applicationId: string | null;
  category: CheckCategory;
  type: CheckType;
  path: CheckPath;
  independenceGroup: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  timeoutMs: number;
  critical: boolean;
  enabled: boolean;
}

export type CheckStatus = 'UNKNOWN' | 'OK' | 'WARNING' | 'DEGRADED' | 'FAILED';

export interface HealthCheckState {
  checkId: string;
  status: CheckStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  firstFailureAt: Date | null;
  lastSuccessAt: Date | null;
  lastResultAt: Date | null;
  lastLatencyMs: number | null;
  lastMessage: string;
  lastObserved: Record<string, unknown>;
}

export interface Policy {
  id: string;
  name: string;
  isActive: boolean;
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

export type OperationKind = 'failover' | 'failback' | 'dry_run' | 'validate';
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  verdict: string | null;
  sourceSiteId: string | null;
  targetSiteId: string | null;
  requestedBy: string | null;
  requestedByName: string;
  acknowledged: string[];
  overrideReason: string | null;
  cancelRequested: boolean;
  currentStage: string | null;
  failedStage: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  summary: Record<string, unknown>;
}

export type StepStatus = 'RUNNING' | 'PASS' | 'WARNING' | 'FAIL' | 'SKIPPED' | 'PLANNED';

export interface OperationStep {
  id: number;
  operationId: string;
  seq: number;
  key: string;
  name: string;
  status: StepStatus;
  message: string;
  details: Record<string, unknown>;
  startedAt: Date;
  finishedAt: Date | null;
}

export type Actor = { type: 'user'; id: string; name: string; ip?: string } | { type: 'system'; name: string };

export const SYSTEM_ACTOR: Actor = { type: 'system', name: 'controller' };
