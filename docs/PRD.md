# PRD: bil-provisioning

| | |
|---|---|
| **Product** | `Bible-Innovation-Lab/bil-provisioning` |
| **Owner** | Scott Bouma, YouVersion |
| **Status** | Draft v1 — specification only, no code yet |
| **Last updated** | 2026-05-12 |
| **Estimated effort** | 3-5 person-days |

---

## Problem

The BIL Launchpad template needs a way to deploy each student's forked repo into
Vercel without giving every student an admin Vercel API token. A Vercel team token
with project-create scope is a high-value credential — embedding it in the launchpad
template (even via env var) would leak it to every forked repo, which is the same as
publishing it.

We need exactly one path that:
1. Holds the admin token server-side, scoped to known senders.
2. Authenticates students cheaply (they already have GitHub auth).
3. Validates the requested app-id to prevent subdomain abuse.
4. Handles the race condition where two students simultaneously claim the same app-id.
5. Cleans up after the program ends so abandoned subdomains can't be taken over.

This service is what the launchpad's `setup.sh` calls. It's also a security boundary:
a bug here can compromise the entire BIL Vercel team and PostHog org.

## Goal

A small internal HTTP service that handles the one-time provisioning of student
products and the matching teardown when products are retired. It's the only thing in
the BIL stack that holds the Vercel team API token and the PostHog admin token.

## Non-goals

- **Not a multi-tenant SaaS.** Single-customer (BIL). One environment (production)
  + one local dev mode is enough.
- **Not a deploy engine.** Vercel handles deploys; this service just sets up the
  Vercel project so Vercel's GitHub integration can take over.
- **Not a UI.** It's an API called by bash + (occasionally) admin tooling. No web
  interface for students.
- **Not a database service.** Uses Vercel KV (or Upstash Redis) for the small amount
  of state it needs. No Postgres, no schemas to migrate.
- **Not authentication-as-a-service.** Students authenticate via GitHub. The service
  verifies their identity but doesn't issue its own credentials.

## Target user

**Primary user (program):** the launchpad's `setup.sh` bash script. It calls
`POST /provision` with the student's GitHub OAuth token and the desired app-id.

**Secondary user (program):** the BIL platform team. Calls `POST /teardown` (and
maybe `GET /status`) for admin operations.

**Never a user:** students directly. Students see the bash script; the service is
invisible.

## Functional requirements

### F1: `POST /provision`

Creates a Vercel project for a student's forked repo and returns the live URL.

**Auth:** `Authorization: Bearer <github-user-token>` — the student's GitHub OAuth
token, obtained client-side via device flow (see auth model below).

**Body:**

```json
{
  "repo": "Bible-Innovation-Lab/<app-id>",
  "app_id": "bible-trivia"
}
```

**Responses:**

| Status | Body | Meaning |
|---|---|---|
| `201` | `{ url, project_id }` | Provisioned successfully |
| `400` | `{ error: "app_id_invalid" \| "app_id_taken" \| "repo_not_owned" \| "denylisted" }` | Validation failure |
| `403` | `{ error: "not_org_member" }` | Caller is not in the BIL GitHub org |
| `409` | `{ error: "already_provisioned" }` | This repo already has a Vercel project |
| `500` | `{ error: "vercel_api_error" \| "posthog_api_error" \| "internal" }` | Provider or internal failure (retry-safe) |

**Side effects on success:**

1. Atomic claim row in KV: `app_id:<id>` → `{ repo, claimed_at, project_id }`.
2. Vercel project created via `POST /v9/projects`.
3. Vercel project domain attached: `<app-id>.bibleinnovationlab.org` via
   `POST /v10/projects/{id}/domains`.
4. Env vars set: `APP_ID`, `POSTHOG_KEY`, `NODE_ENV` via `POST /v10/projects/{id}/env`.
5. Wait for Vercel cert provisioning (poll up to 60 s with exponential backoff).
6. Return the live URL.

### F2: `POST /teardown`

Removes the subdomain and deletes the Vercel project so a deprecated student
product can't be taken over via subdomain takeover.

**Auth:** same Bearer token pattern, but caller must be in the BIL admin team (a
narrower GitHub group than just "org member").

**Body:**

```json
{ "app_id": "old-product-name" }
```

**Side effects:**

1. Remove the domain from the Vercel project.
2. Delete the Vercel project.
3. Delete the KV claim row.
4. Append to a teardown audit log (Vercel logs or a dedicated KV list).

### F3: `GET /status?app_id=<id>` (optional, for admin tools)

Returns whether an app-id is provisioned and links to the Vercel project. Same auth
as `/teardown` (admin only).

### F4: `GET /health`

Returns 200 OK if the service is alive. No auth required. Monitored by Pingdom or
Better Stack with paging on failure.

### F5: Validation

- **App-id regex:** `^[a-z][a-z0-9-]{2,30}$` (lowercase, dashes, 3-31 chars, starts
  with a letter).
- **App-id denylist:**
  `www, api, admin, app, auth, mail, ftp, blog, docs, status, dashboard, youversion,
  yv, bibleinnovationlab, bil, internal, staging, dev, test, demo, hello, help,
  contact, about, login, signin, signup, register, public, private, root, system`.
- **Repo ownership check:** the GitHub token's user must be a member of the BIL org
  AND the requested repo must exist under the BIL org.
- **One repo, one app-id:** before creating a project, check whether the repo
  already has a Vercel project; if yes, 409.

### F6: Atomic claim

When `POST /provision` arrives:

1. Open a KV transaction (or use `SET key value NX EX 300` for a 5-minute lock).
2. If `app_id:<id>` already exists, 400 `app_id_taken`.
3. Insert claim row with TTL = 5 min (cleanup if subsequent Vercel calls fail).
4. Make Vercel API calls.
5. On success, extend TTL to permanent (or delete TTL).
6. On failure, delete the claim row to allow retry.

Race condition: two students POST simultaneously with the same app-id → whichever
inserts the KV row first wins; the other gets a clean 400.

## Auth model

### Student → service authentication (provision endpoint)

**Chosen:** GitHub OAuth device flow.

Flow inside `scripts/setup.sh`:

1. Bash calls `POST https://github.com/login/device/code` with the BIL OAuth
   App's client ID. Gets back `{ device_code, user_code, verification_uri }`.
2. Bash prints `user_code` and opens `verification_uri` in the user's browser.
3. User logs into GitHub (or is already logged in) and enters the code.
4. Bash polls `POST https://github.com/login/oauth/access_token` until it gets
   an access token.
5. Bash calls `POST <service>/provision` with `Authorization: Bearer <token>`.
6. Service verifies the token via `GET https://api.github.com/user/orgs` and
   confirms BIL org membership.

**Rejected alternatives:**

- **Shared bearer token in the template:** every fork has it = not a secret. Hard pass.
- **Per-user provisioning tokens** (each student gets their own admin token): worse
  blast radius if leaked, more credentials to rotate.
- **mTLS or VPN-restricted access:** overkill for a small program; adds setup
  friction for students.

### Admin → service authentication (teardown, status)

Same GitHub OAuth device flow, but the service additionally checks for membership
in a narrower GitHub team (e.g., `Bible-Innovation-Lab/platform-admins`).

### Service → providers

- **Vercel:** the BIL Vercel team API token, stored in `process.env.VERCEL_API_TOKEN`.
- **PostHog:** PostHog admin (or "personal") API key, stored in
  `process.env.POSTHOG_ADMIN_TOKEN`.

Both are set in the Vercel project's env-var settings, never written into source code.

## Threat model

| Threat | Mitigation |
|---|---|
| Token leak via service logs | Log redactor strips Bearer tokens from request bodies. No raw env vars in logs. |
| Token leak via error responses | Error bodies never include token values. Generic error codes only. |
| Replay attack (someone records a request and replays) | GitHub OAuth tokens are short-lived (8 hours by default). Service re-validates org membership on each call. |
| App-id collision race | KV-backed atomic claim (see F6). |
| Subdomain takeover (abandoned subdomain → attacker claims via new Vercel project) | F2 teardown removes DNS records; weekly scan job (future work) detects orphaned subdomains. |
| Privilege escalation (org member tries to grab `admin` subdomain) | Denylist enforced server-side (see F5). |
| Provisioning service compromise | If this service is compromised, the attacker has full BIL Vercel + PostHog access. Mitigations: small attack surface (one HTTP endpoint, one auth check), regular token rotation, audit log of every provision call. |
| Vercel API rate limit (100 req/min per token) | Rate-limit incoming requests to 10/min/user and 60/min global. |
| GitHub org membership cache staleness | No caching. Re-verify on every request — costs one round-trip per provision, acceptable given the low volume. |

## Non-functional requirements

### NF1: Availability

- **Target:** 99% during program hours (US business hours, weekdays). Not 24/7.
- **SLO:** at most one 30-minute outage per month.
- **Monitoring:** Vercel built-in + a separate health-check ping (Pingdom or Better
  Stack) that pages on > 5 min downtime.

### NF2: Latency

- p99 `/provision` < 30 seconds (dominated by Vercel cert provisioning).
- p99 `/teardown` < 10 seconds.
- p99 `/health` < 100 ms.

### NF3: Observability

- Every `/provision` call logs: request id, GitHub user, app-id, outcome (success
  or error code), Vercel project id.
- No PII beyond GitHub username.
- Logs retained in Vercel for 30 days.
- Counter metrics: provisions/day, teardowns/day, error rates by code.

### NF4: Capacity

- Burst: 10 simultaneous students starting setup.sh at the same time (program kickoff).
- Steady-state: a few provisions per day across the summer.
- Designed for ~100 lifetime provisions, not 100,000.

### NF5: Cost

- Vercel function execution: pennies per month at this volume.
- Vercel KV: < 100 KB stored at any time (a few hundred small KV rows max).
- Upstash Redis is a viable alternative if Vercel KV pricing changes.

## Out of scope

- **Multi-tenant operation.** This is for BIL only.
- **Self-service token rotation.** Platform team rotates tokens manually via Vercel/PostHog dashboards.
- **A web UI.** API-only.
- **Multi-region deployment.** Single Vercel region (`iad1`) is fine.
- **Backups.** The KV state is rebuilt-able from Vercel + GitHub state (low value to back up).
- **Automatic subdomain reclamation.** Teardown is admin-triggered, not automatic on
  repo archive (might come in a future iteration).
- **Payment / billing integration.** N/A — internal program.

## Dependencies

| Dependency | Purpose |
|---|---|
| BIL Vercel Pro team account + API token | Project create / domain attach / env var inject |
| BIL PostHog org + admin token | (Optional v1.1) create per-product PostHog projects; v1 uses a single shared key |
| BIL GitHub OAuth App | Device flow client ID + secret for student auth |
| Vercel KV (or Upstash Redis) | Atomic app-id claim, teardown audit log |
| DNS wildcard `*.bibleinnovationlab.org` → Vercel | Required so domain attach actually works |

## Success criteria

- A student running `setup.sh` from a freshly forked launchpad gets a live URL
  in under 60 seconds (excluding Vercel's cert-provisioning wait).
- Two students starting at the same time with the same app-id → one succeeds, one
  gets a clean 400; no orphaned Vercel projects.
- Zero credential leaks in the service's first 6 months of operation.
- The platform team can teardown a product in one curl command without involving
  Vercel UI clicking.

## Open questions

- **PostHog project per product, or one project with `app_id` dimension?** v1
  recommendation: one project with the dimension (simpler, works with PostHog's
  existing dashboards). v1.5 could switch to per-product if event volume requires
  isolation.
- **GitHub OAuth App ownership:** is it under `bibleinnovationlab` GitHub user or
  the `Bible-Innovation-Lab` org? Recommend the org (survives if Scott leaves).
- **Token rotation cadence:** quarterly is the default in the design doc. Confirm
  with security team.
- **Cron job for orphan-subdomain scan:** valuable to have, but probably v2.

## Design references

- Parent design doc (full threat model + spec):
  `~/.gstack/projects/scottbouma/scottbouma-launchpad-design-20260511-152914.md` —
  see § "Provisioning Service Threat Model + Spec".
- Launchpad PRD: `Bible-Innovation-Lab/launchpad/docs/PRD.md`.
- Implementation plan for this service: [`implementation-plan.md`](implementation-plan.md).
