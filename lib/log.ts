// Token-redacting logger. The only data that leaves this service in log lines
// passes through `redact()` first.
//
// Patterns we redact:
//   - Vercel API tokens (vck_…, vcp_…, and generic 24+ char hex/alnum that follows
//     a "Bearer" prefix or appears as a value in an Authorization header)
//   - PostHog keys: phc_… (public) and phx_…/phs_… (private)
//   - GitHub OAuth tokens: ghu_, ghs_, gho_, ghp_, ghr_
//   - Upstash KV tokens: ATAxxx… (Upstash REST tokens are JWT-shaped, ~100+ chars)
//
// All replacements drop to a fixed sentinel so log lines stay grep-able as
// "something happened" without leaking the value.

interface TokenPattern {
  pattern: RegExp;
  preservePrefix: boolean;
}

const TOKEN_PATTERNS: TokenPattern[] = [
  // Vercel
  { pattern: /vck_[A-Za-z0-9]{16,}/g, preservePrefix: false },
  { pattern: /vcp_[A-Za-z0-9]{16,}/g, preservePrefix: false },
  // PostHog
  { pattern: /ph[cxs]_[A-Za-z0-9]{16,}/g, preservePrefix: false },
  // GitHub OAuth & PAT
  { pattern: /gh[ouspr]_[A-Za-z0-9]{30,}/g, preservePrefix: false },
  // Bearer header values (catch-all). Capture group keeps "Bearer " in output.
  { pattern: /(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi, preservePrefix: true },
  // Authorization header in object form. Captures the prefix.
  { pattern: /(authorization["'\s:=]+)[A-Za-z0-9._\-]{16,}/gi, preservePrefix: true },
  // Upstash JWT-shaped tokens
  { pattern: /\bA[A-Z][A-Za-z0-9]{50,}\b/g, preservePrefix: false },
];

const SENTINEL = "<redacted>";

export function redact(input: string): string {
  let out = input;
  for (const { pattern, preservePrefix } of TOKEN_PATTERNS) {
    if (preservePrefix) {
      out = out.replace(pattern, (_match, prefix: string) => `${prefix}${SENTINEL}`);
    } else {
      out = out.replace(pattern, SENTINEL);
    }
  }
  return out;
}

export function redactObject(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactObject);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Drop any field literally named like a secret, regardless of value.
    if (
      /(token|secret|password|api[_-]?key|authorization|bearer)/i.test(k) &&
      typeof v === "string"
    ) {
      out[k] = SENTINEL;
    } else {
      out[k] = redactObject(v);
    }
  }
  return out;
}

// Structured log writer. Stdout JSON line; Vercel surfaces these in the dashboard.
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || "info").toLowerCase();
  return (env in LEVELS ? env : "info") as LogLevel;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redactObject(fields) as Record<string, unknown>),
  };
  const writer = level === "error" || level === "warn" ? console.error : console.log;
  writer(JSON.stringify(line));
}
