import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z.string().min(1),
  FSM_MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'FSM_MASTER_KEY must be 32 bytes, base64 encoded'),
  FSM_LISTEN_HOST: z.string().default('0.0.0.0'),
  FSM_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FSM_COOKIE_SECURE: bool(true),
  FSM_TRUST_PROXY: bool(false),
  /** Comma separated hostnames (or *.suffix) the controller may contact. "*" allows any. */
  FSM_EGRESS_ALLOWLIST: z.string().default('*'),
  FSM_INITIAL_ADMIN_USERNAME: z.string().optional(),
  FSM_INITIAL_ADMIN_PASSWORD: z.string().min(12).optional(),
  FSM_ENGINE_ENABLED: bool(true),
  FSM_RESULT_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
  FSM_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  FSM_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(30),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema> & { egressAllowlist: string[] | '*' };

export function parseAllowlist(raw: string): string[] | '*' {
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes('*')) return '*';
  return parts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return { ...parsed.data, egressAllowlist: parseAllowlist(parsed.data.FSM_EGRESS_ALLOWLIST) };
}
