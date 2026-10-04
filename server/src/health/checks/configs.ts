import { z } from 'zod';
import type { CheckType } from '../../domain/types.js';

const host = z.string().min(1).max(253);

export const CHECK_CONFIG_SCHEMAS = {
  icmp: z.object({ host }),
  tcp: z.object({ host, port: z.number().int().min(1).max(65535) }),
  http: z.object({
    url: z.string().url().refine((u) => /^https?:/.test(u), 'must be http(s)'),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    expectStatus: z.array(z.number().int()).min(1).default([200]),
    bodyContains: z.array(z.string()).default([]),
    bodyNotContains: z.array(z.string()).default([]),
    bodyRegex: z.string().optional(),
    json: z.array(z.object({ path: z.string().min(1), equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) })).default([]),
    /** Proves which site answered, e.g. {name: "x-served-by", equals: "site-b"}. */
    header: z.object({ name: z.string().min(1), equals: z.string().optional(), contains: z.string().optional() }).optional(),
    hostHeader: z.string().optional(),
    tlsInsecure: z.boolean().default(false),
    caPem: z.string().optional(),
  }),
  dns: z.object({
    name: host,
    recordType: z.enum(['A', 'AAAA', 'CNAME']).default('A'),
    expect: z.array(z.string()).default([]),
    server: z.string().optional(),
  }),
  proxmox_api: z.object({ proxmoxInstanceId: z.string().uuid() }),
  proxmox_node: z.object({
    proxmoxInstanceId: z.string().uuid(),
    node: z.string().min(1),
    maxCpu: z.number().min(0).max(1).default(0.95),
    maxMemory: z.number().min(0).max(1).default(0.95),
    maxRootfs: z.number().min(0).max(1).default(0.95),
  }),
  proxmox_vm: z.object({
    proxmoxInstanceId: z.string().uuid(),
    node: z.string().min(1),
    vmid: z.number().int().positive(),
    kind: z.enum(['qemu', 'lxc']).default('qemu'),
    expectStatus: z.enum(['running', 'stopped', 'any']).default('running'),
  }),
  tunnel: z.object({ tunnelRef: z.string().uuid() }),
  npm_api: z.object({ npmInstanceId: z.string().uuid() }),
  npm_proxy_host: z.object({ expectationId: z.string().uuid() }),
  replication: z.object({}).default({}),
} satisfies Record<CheckType, z.ZodType>;

export type CheckConfig<T extends CheckType> = z.infer<(typeof CHECK_CONFIG_SCHEMAS)[T]>;

export function parseCheckConfig<T extends CheckType>(type: T, config: unknown): CheckConfig<T> {
  const r = CHECK_CONFIG_SCHEMAS[type].safeParse(config ?? {});
  if (!r.success) throw new Error(`Invalid ${type} check config: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return r.data as CheckConfig<T>;
}
