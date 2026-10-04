/**
 * Removes credentials from text before it reaches logs, audit events or API
 * responses. Known secret values are replaced verbatim; common credential
 * shapes are replaced by pattern as a second line of defence.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/(PVEAPIToken=)[^\s"',]+/g, '$1[REDACTED]'],
  [/("(?:password|secret|token|apiToken|api_token|tokenSecret|authorization)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2'],
  [/((?:password|secret|token)=)[^\s&"']+/gi, '$1[REDACTED]'],
];

export function redact(input: string, secrets: Iterable<string> = []): string {
  let out = input;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const SENSITIVE_KEYS = /^(password|secret|token|apitoken|api_token|tokensecret|authorization|cookie|identitysecret|csrftoken)$/i;

/** Deep-copies a value, replacing sensitive keys and redacting string values. */
export function redactObject<T>(value: T, secrets: Iterable<string> = []): T {
  const list = [...secrets];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v, list);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
