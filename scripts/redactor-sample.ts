// scripts/redactor-sample.ts — end-to-end visual proof that the log
// redactor catches realistic token shapes.
//
// Runs a corpus of realistic-looking error messages (real prefixes,
// fake values) through redact() and reports any that still contain a
// token-shaped string. Doubles as:
//   1. Human-readable evidence (you can eyeball input → output)
//   2. CI guard (exits non-zero if any token shape survives)
//
// Usage: bun scripts/redactor-sample.ts
//
// Add new entries here whenever we touch a new provider so the regression
// is caught the next time someone changes redact().

import { redact, redactObject } from "../lib/log.js";

// Each sample is a {what,input} pair. `input` is a fake-but-realistic
// error message — actual token PREFIXES (vck_, phc_, ghu_, etc.) so the
// patterns are exercised, with synthetic random-looking suffixes.
const STRING_SAMPLES: Array<{ what: string; input: string }> = [
  {
    what: "Vercel client-side token (vck_)",
    input: "Bearer vck_abcd1234efgh5678ijkl is malformed",
  },
  {
    what: "Vercel project token (vcp_)",
    input: "Failed to GET /v9/projects/x with token vcp_8Xq5bfM3RsPJ015l2AzULjm3",
  },
  {
    what: "PostHog public key (phc_)",
    input: "PostHog request failed: key phc_examplekeyhasenoughchars",
  },
  {
    what: "PostHog secret (phs_)",
    input: "Forbidden phs_abcd1234efgh5678ijkl — wrong scope",
  },
  {
    what: "GitHub user OAuth token (ghu_)",
    input: "GET /user returned 401: token ghu_abcdefghijklmnopqrstuvwxyz0123456789",
  },
  {
    what: "GitHub app token (ghs_)",
    input: "Server token ghs_abcdefghijklmnopqrstuvwxyz0123456789 expired",
  },
  {
    what: "Bearer header (catch-all)",
    input: "authorization: Bearer randomopaquetoken1234567890abcdef",
  },
  {
    what: "authorization header in object-form serialisation",
    input: 'request headers: {"authorization": "Bearer xyz1234567890abcdefghij"}',
  },
  {
    what: "Upstash REST token (JWT-shaped, starts with A[A-Z])",
    input:
      "KV connect failed using token AYzABBCDefghijklmnopqrstuvwxyz0123456789ABCDEFGHijkl1234567890",
  },
  {
    what: "value already wrapped (no false-positive re-replacement)",
    input: "previous redaction left this: <redacted>",
  },
  {
    what: "short value below threshold (should NOT redact — not token-shaped)",
    input: "Bearer abc",
  },
];

// redactObject samples — same idea but exercising the field-name-based
// drop and the nested-walk behaviour.
const OBJECT_SAMPLES: Array<{ what: string; input: unknown }> = [
  {
    what: "field named 'token' is sentinel'd regardless of value",
    input: { user: "scott", token: "totally-not-token-shaped-value" },
  },
  {
    what: "nested 'authorization' header",
    input: {
      method: "POST",
      headers: { authorization: "Bearer ghu_realtokenshapeabcdefghijklmnop" },
    },
  },
  {
    what: "array of strings each carrying a token shape",
    input: [
      "log line 1: vck_aaaabbbbccccdddd1111",
      "log line 2: gho_abcdefghijklmnopqrstuvwxyz0123456789",
    ],
  },
  {
    what: "deeply nested with token mixed into a string",
    input: {
      request_id: "abc-123",
      payload: {
        body: "error: Bearer phc_demonstrationkeylongenough invalid",
      },
    },
  },
];

// Any output that still contains one of these patterns is a leak.
// Keep this list in sync with lib/log.ts. Anchored to "raw" matches
// (the redactor's sentinel "<redacted>" is the only exception).
const TOKEN_SHAPES = [
  /vck_[A-Za-z0-9]{16,}/,
  /vcp_[A-Za-z0-9]{16,}/,
  /ph[cxs]_[A-Za-z0-9]{16,}/,
  /gh[ouspr]_[A-Za-z0-9]{30,}/,
  /\bA[A-Z][A-Za-z0-9]{50,}\b/,
];

function findLeak(s: string): RegExp | null {
  for (const re of TOKEN_SHAPES) {
    if (re.test(s)) return re;
  }
  return null;
}

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

console.log(`${BOLD}log-redactor sampler${RESET}`);
console.log(`${DIM}runs realistic token shapes through redact()/redactObject() and flags survivors${RESET}\n`);

let leaks = 0;

console.log(`${BOLD}--- string inputs (redact) ---${RESET}`);
for (const sample of STRING_SAMPLES) {
  const out = redact(sample.input);
  const leak = findLeak(out);
  const marker = leak ? `${RED}LEAK${RESET}` : `${GREEN}ok${RESET}`;
  console.log(`  [${marker}] ${sample.what}`);
  console.log(`         in : ${sample.input}`);
  console.log(`         out: ${out}`);
  if (leak) {
    leaks += 1;
    console.log(`         ${RED}^^ matches ${leak}${RESET}`);
  }
}

console.log(`\n${BOLD}--- object inputs (redactObject) ---${RESET}`);
for (const sample of OBJECT_SAMPLES) {
  const out = redactObject(sample.input);
  const serialised = JSON.stringify(out);
  const leak = findLeak(serialised);
  const marker = leak ? `${RED}LEAK${RESET}` : `${GREEN}ok${RESET}`;
  console.log(`  [${marker}] ${sample.what}`);
  console.log(`         in : ${JSON.stringify(sample.input)}`);
  console.log(`         out: ${serialised}`);
  if (leak) {
    leaks += 1;
    console.log(`         ${RED}^^ matches ${leak}${RESET}`);
  }
}

console.log("");
if (leaks > 0) {
  console.log(`${RED}${BOLD}✗ ${leaks} token shape(s) survived redact()${RESET}`);
  console.log(
    `${DIM}update the patterns in lib/log.ts and re-run before shipping.${RESET}`
  );
  process.exit(1);
}
console.log(`${GREEN}${BOLD}✓ no token shapes leaked${RESET}`);
