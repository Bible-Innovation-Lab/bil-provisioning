// App-id validation: DNS-safe subdomain label + denylist of reserved names.
// Source of truth: docs/PRD.md § F5. Keep this in sync with the launchpad's
// scripts/setup.sh client-side check (defense in depth — server is authoritative).

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: ValidationReason };

export type ValidationReason =
  | "app_id_invalid"
  | "denylisted";

const APP_ID_REGEX = /^[a-z][a-z0-9-]{2,30}$/;

const DENYLIST = new Set([
  "www",
  "api",
  "admin",
  "app",
  "auth",
  "mail",
  "ftp",
  "blog",
  "docs",
  "status",
  "dashboard",
  "youversion",
  "yv",
  "bibleinnovationlab",
  "bil",
  "internal",
  "staging",
  "dev",
  "test",
  "demo",
  "hello",
  "help",
  "contact",
  "about",
  "login",
  "signin",
  "signup",
  "register",
  "public",
  "private",
  "root",
  "system",
  // Service self-reservation — bil-provisioning's own subdomain.
  "provisioning",
]);

export function validateAppId(s: unknown): ValidationResult {
  if (typeof s !== "string") return { valid: false, reason: "app_id_invalid" };
  if (!APP_ID_REGEX.test(s)) return { valid: false, reason: "app_id_invalid" };
  if (DENYLIST.has(s)) return { valid: false, reason: "denylisted" };
  return { valid: true };
}

export function isDenylisted(appId: string): boolean {
  return DENYLIST.has(appId);
}
