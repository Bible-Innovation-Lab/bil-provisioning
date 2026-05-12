# Implementation Plan: bil-provisioning

| | |
|---|---|
| **Service** | `Bible-Innovation-Lab/bil-provisioning` |
| **Effort** | 3-5 person-days, single engineer |
| **Status** | Not started |
| **Last updated** | 2026-05-12 |

This plan turns the [PRD](PRD.md) into concrete build steps, ordered to minimize
backtracking. Pairs with the threat-model section of the parent design doc.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Vercel Functions (Node.js runtime — not Edge) | Need `posthog-node` SDK; Edge can't use it cleanly. Cold starts are fine — this service is called ~1×/day at most. |
| Language | TypeScript | Consistency with launchpad. Strict mode on. |
| Framework | Bare Vercel functions (`api/*.ts`) | Avoid pulling in Next.js when we have no UI. Lower surface area, simpler audit. |
| Package manager | `bun` | Consistency with launchpad. |
| Storage | Vercel KV (Upstash Redis under the hood) | Native to Vercel, free tier ample, atomic SET with NX semantics for the app-id claim. |
| HTTP framework | Hono | ~10KB, TypeScript-native, easy testing. Alternative: bare `Request`/`Response` handlers — also fine. |
| Validation | `zod` | Schema-first input validation; produces typed handlers without ceremony. |
| Auth | Octokit SDK (`@octokit/request`) for the GitHub API checks | Battle-tested, handles rate limits. |

## Repo layout

```
bil-provisioning/
├── api/                            # Vercel functions
│   ├── provision.ts                # POST /provision
│   ├── teardown.ts                 # POST /teardown
│   ├── status.ts                   # GET /status
│   └── health.ts                   # GET /health
├── lib/
│   ├── auth.ts                     # GitHub OAuth token verify + org-member check
│   ├── vercel-client.ts            # Wrapper around Vercel API calls
│   ├── posthog-client.ts           # Wrapper for PostHog (mostly no-op v1; reserved for v1.1)
│   ├── kv.ts                       # Vercel KV helpers (atomic claim, log)
│   ├── validation.ts               # app-id regex + denylist
│   └── log.ts                      # Structured logger with token-redactor
├── test/
│   ├── provision.integration.test.ts
│   ├── teardown.integration.test.ts
│   ├── validation.unit.test.ts
│   └── auth.unit.test.ts
├── docs/
│   ├── PRD.md
│   └── implementation-plan.md      # this file
├── .env.example
├── package.json
├── tsconfig.json
├── vercel.json                     # `outputDirectory: ".vercel/output"` if needed; default works
├── README.md
└── .gitignore
```

## Build phases

### Phase 0: Setup (~2 hours)

1. `bun init` and configure `tsconfig.json` strict-mode equivalent to launchpad.
2. Install deps: `bun add hono zod @octokit/request posthog-node @vercel/kv`.
3. Install dev deps: `bun add -d @types/bun @types/node typescript vitest @vercel/node`.
4. Configure Vercel CLI locally (`vercel link` to the BIL team — needs a one-time
   `vercel login`).
5. Set up `.env.example` documenting required env vars:

```
# Required at runtime
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
GITHUB_ORG=Bible-Innovation-Lab
GITHUB_ADMIN_TEAM_SLUG=platform-admins
VERCEL_API_TOKEN=
VERCEL_TEAM_ID=
POSTHOG_KEY=
POSTHOG_HOST=https://us.i.posthog.com
KV_REST_API_URL=
KV_REST_API_TOKEN=
LOG_LEVEL=info

# Subdomain config
SUBDOMAIN_ROOT=bibleinnovationlab.org
```

6. Create the BIL GitHub OAuth App
   (https://github.com/organizations/Bible-Innovation-Lab/settings/applications/new)
   and put the client ID + secret in `.env.local`.

### Phase 1: Validation + KV (~half day)

**Why first:** smallest unit; no external API calls; easy to test in isolation.

1. `lib/validation.ts` — `validateAppId(s)`: regex + denylist. Returns
   `{ valid: true } | { valid: false, reason }`.
2. `lib/kv.ts` — wrappers around `@vercel/kv`:
   - `claimAppId(appId, repo) → Promise<boolean>` (atomic, returns false if taken).
   - `releaseAppId(appId)` (cleanup on failure).
   - `confirmClaim(appId, projectId)` (extend TTL after Vercel succeeds).
   - `getClaim(appId)` (read-only for status endpoint).
3. **Test:** `validation.unit.test.ts` + `kv.unit.test.ts` (against the in-memory
   KV mock or a test Upstash instance).

**Done when:** validation tests pass + KV atomic claim works against a real test KV
store.

### Phase 2: Auth (~half day)

1. `lib/auth.ts`:
   - `verifyGitHubToken(token): Promise<{ login, valid }>` — `GET /user` with the
     student's Bearer token.
   - `requireOrgMember(login): Promise<void>` — throws if the user isn't a member
     of `GITHUB_ORG`. Uses `GET /orgs/{org}/memberships/{user}`.
   - `requireAdminTeamMember(login): Promise<void>` — throws if not in the admin
     team. Uses `GET /orgs/{org}/teams/{slug}/memberships/{user}`.
2. Add a Hono middleware that runs `verifyGitHubToken` → `requireOrgMember` on
   `/provision`, and the admin variant on `/teardown` + `/status`.
3. **Test:** `auth.unit.test.ts` with mocked Octokit responses (don't hit real GitHub
   in unit tests).

**Done when:** auth middleware rejects requests with no token, bad token, non-member
token, and accepts valid org members.

### Phase 3: Vercel client (~half day)

1. `lib/vercel-client.ts`:
   - `createProject({ name, repo }): Promise<{ id }>` — `POST /v9/projects`.
   - `addDomain(projectId, domain): Promise<void>` — `POST /v10/projects/{id}/domains`.
   - `setEnv(projectId, key, value, targets): Promise<void>` — `POST /v10/projects/{id}/env`.
   - `deleteProject(projectId): Promise<void>` — `DELETE /v9/projects/{id}`.
   - `removeDomain(projectId, domain): Promise<void>` — `DELETE /v10/projects/{id}/domains/{domain}`.
   - `pollCertReady(domain, timeoutMs = 60000): Promise<boolean>` — polls
     `GET /v6/domains/{name}/config` with exponential backoff.
2. Each function wraps fetch calls with proper headers (`Authorization: Bearer
   ${VERCEL_API_TOKEN}`, `x-vercel-team-id: ${VERCEL_TEAM_ID}`) and a redactor that
   strips token strings from any logged error response.
3. **Test:** mocked fetch responses in unit tests; one manual integration probe
   against the real Vercel test team to confirm the API actually behaves as documented.

**Done when:** all six functions work against a Vercel sandbox team with hand-curated
test cases.

### Phase 4: `/provision` endpoint (~half day)

Compose the previous phases:

```
POST /provision
  ├─ auth middleware (verify token → check org member)
  ├─ parse + validate body (zod schema: { repo, app_id })
  ├─ validation.validateAppId(app_id) → 400 if bad
  ├─ kv.claimAppId(app_id, repo) → 400 if taken
  ├─ try:
  │   ├─ vercel.createProject({ name: app_id, repo })
  │   ├─ vercel.addDomain(projectId, `${app_id}.bibleinnovationlab.org`)
  │   ├─ vercel.setEnv(projectId, "APP_ID", app_id, ["production", "preview"])
  │   ├─ vercel.setEnv(projectId, "POSTHOG_KEY", POSTHOG_KEY, ["production", "preview"])
  │   ├─ await vercel.pollCertReady(domain) (best-effort, 60s timeout)
  │   ├─ kv.confirmClaim(app_id, projectId)
  │   └─ return 201 { url, project_id }
  ├─ catch:
  │   ├─ kv.releaseAppId(app_id)
  │   └─ return 500 with error code
  └─ log structured event regardless of outcome
```

**Test:** `provision.integration.test.ts` against a sandbox Vercel team:
- Happy path: full flow, project exists at the end, app-id claimed.
- App-id collision: second simultaneous request gets 400.
- Vercel 5xx during `addDomain`: claim is released, retry works.
- Non-member token: 403.
- Malformed body: 400.

### Phase 5: `/teardown` + `/status` + `/health` (~half day)

1. `/teardown` — same composition but reverse: admin-auth → remove domain → delete
   project → release claim → append audit log.
2. `/status` — admin-auth → read claim from KV → return state.
3. `/health` — no auth → return 200.

### Phase 6: Bash client updates (~1-2 hours)

Update `Bible-Innovation-Lab/launchpad/scripts/setup.sh` to use GitHub OAuth device
flow instead of the current `gh auth token` shortcut:

```bash
# Inside scripts/setup.sh
DEVICE_RESPONSE=$(curl -sX POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=$BIL_OAUTH_CLIENT_ID&scope=read:org")
DEVICE_CODE=$(echo "$DEVICE_RESPONSE" | jq -r .device_code)
USER_CODE=$(echo "$DEVICE_RESPONSE" | jq -r .user_code)
VERIFY_URL=$(echo "$DEVICE_RESPONSE" | jq -r .verification_uri)

echo "Open $VERIFY_URL and enter code: $USER_CODE"
open "$VERIFY_URL"

# Poll for token
while true; do
  TOKEN_RESPONSE=$(curl -sX POST https://github.com/login/oauth/access_token \
    -H "Accept: application/json" \
    -d "client_id=$BIL_OAUTH_CLIENT_ID&device_code=$DEVICE_CODE&grant_type=urn:ietf:params:oauth:grant-type:device_code")
  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)
  if [ "$ACCESS_TOKEN" != "null" ] && [ -n "$ACCESS_TOKEN" ]; then break; fi
  sleep 5
done

# Then call provisioning
curl -X POST "$BIL_PROVISIONING_URL/provision" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"repo\":\"$REPO\",\"app_id\":\"$APP_ID\"}"
```

The `BIL_OAUTH_CLIENT_ID` (public, not a secret) can be committed to the launchpad.

### Phase 7: Tests + polish (~half day)

- Run all integration tests against a Vercel sandbox.
- Add a `bun run smoke` script that runs validation + auth unit tests + a single
  happy-path integration test.
- Add error-code documentation to README.
- Add a log-line sampler to validate the redactor isn't leaking tokens.

## Deploy plan

### One-time bootstrap (~1 hour)

The provisioning service has to exist on Vercel before it can deploy anything else.
This is the only manual deploy in the whole BIL stack.

1. Push `bil-provisioning` to `Bible-Innovation-Lab/bil-provisioning` on GitHub.
2. In the Vercel dashboard (BIL team), click "Add New… → Project" → "Import Git
   Repository" → pick `bil-provisioning`.
3. In the project's Settings → Environment Variables, paste all env vars listed
   in `.env.example`. The Vercel team API token and PostHog admin token go in
   here and ONLY here. They never touch any other system.
4. Click "Deploy."
5. Wait for the first deploy to succeed.
6. Set the domain: project → Settings → Domains → add
   `provisioning.bibleinnovationlab.org`.
7. Verify with `curl https://provisioning.bibleinnovationlab.org/health` → 200.

**After this step:** the launchpad's `setup.sh` knows the URL
(`BIL_PROVISIONING_URL=https://provisioning.bibleinnovationlab.org`) and can call
the service.

### Subsequent deploys

Push to `main` on `Bible-Innovation-Lab/bil-provisioning` → Vercel auto-deploys.
Same flow as any other Vercel project.

### Token rotation

Quarterly cadence per the design doc:

1. Generate new Vercel team token (Vercel dashboard).
2. Update env var in the provisioning Vercel project settings.
3. Trigger a redeploy (or just `vercel env pull` + new push).
4. Revoke old token in Vercel dashboard.
5. Same for PostHog admin token.
6. Log the rotation in the platform-team runbook.

The point: tokens are rotated by editing one Vercel project's env vars, not by
chasing references across the launchpad + every student fork.

## Test plan

### Unit tests

| Suite | Coverage |
|---|---|
| `validation.unit.test.ts` | App-id regex (positives + negatives); denylist matches; edge cases (1-char names, max-length, mixed case, leading dash) |
| `auth.unit.test.ts` | Token verification with mocked Octokit responses; org membership pass/fail; admin team pass/fail; expired token handling |
| `kv.unit.test.ts` | `claimAppId` returns false on collision; `releaseAppId` clears the row; TTL is set; `confirmClaim` extends/removes TTL |

### Integration tests (against a sandbox Vercel team)

| Suite | Coverage |
|---|---|
| `provision.integration.test.ts` | Happy path (project created, domain attached, env vars set); concurrent app-id claim (one wins, one 400s); Vercel 5xx triggers claim release; non-member rejection |
| `teardown.integration.test.ts` | Happy path (project deleted, domain removed, claim released); idempotent (re-running on a torn-down project doesn't error); admin-only |

Integration tests require a Vercel "test" team — same plan as any prod-touching
test suite. Don't run them against the real BIL team.

### Manual verification

Before going live with student traffic:

1. Manually run `setup.sh` from a fresh fork of `launchpad`. Confirm a live URL
   comes back.
2. Tear down the test product via `POST /teardown` and confirm Vercel project +
   domain are gone.
3. Run two `setup.sh` invocations simultaneously with the same app-id; one
   succeeds, one 400s.
4. Try a denylisted app-id (`admin`); confirm 400.
5. Make a fake GitHub user that isn't in the org; confirm 403.

### Load test

Not v1. Volume is far below where load matters. Worth doing if/when usage grows
past ~100 provisions/day.

## Rollout

Phased rollout from "no provisioning service" to "every product uses it":

### Stage 1: Manual provisioning (today)

Platform team manually does provisioning in the Vercel dashboard for any product
that needs to ship before the service is live. Used for `bible-trivia` (product #1).
~5 minutes per repo. Acceptable for the first 1-3 products.

### Stage 2: Service exists in staging

Deploy `bil-provisioning` against a sandbox Vercel team. Test end-to-end with a
throwaway forked repo. Don't touch the real BIL team yet.

### Stage 3: Service in production

Deploy to `provisioning.bibleinnovationlab.org`. Update `setup.sh` in the launchpad
to call it.

### Stage 4: Re-provision bible-trivia through the service

To prove the service works on a real product (and to validate that swapping a
manually-provisioned project for a service-provisioned one is safe):
1. Run `POST /teardown { app_id: "bible-trivia" }` against the manually-created project.
2. Run `setup.sh` from a clean clone of the bible-trivia repo.
3. Confirm the live URL is back and analytics still flow.

### Stage 5: Onboard students

Direct students to fork the launchpad. They run `setup.sh`, which calls the
service. Every new product flows through the service from this point forward.

## Risk mitigation

| Risk | Mitigation |
|---|---|
| Service down when students arrive | Manual fallback in `setup.sh`: if `/provision` 5xxs, print the platform-team runbook URL |
| Token rotation breaks an in-flight provision | Provisions are short (< 1 min); rotation should not run during active program hours |
| Test environment differs from prod (Vercel API surprises) | Use a real sandbox Vercel team for integration tests, not just mocks |
| KV state corruption (claim row out of sync with Vercel reality) | `GET /status` can compare KV vs. Vercel state; manual `/teardown` cleans up if needed |
| Admin endpoint accidentally exposed to non-admins | Belt-and-braces: auth middleware AND a server-side check inside the handler |

## Observability checklist

Before going live:

- [ ] Structured logs on every `/provision` and `/teardown` (request id, github user, app-id, outcome, duration)
- [ ] Log redactor verified against a log sample (no `vcp_…` or `phc_…` strings leak)
- [ ] Vercel function logs visible in the BIL Vercel dashboard
- [ ] `/health` endpoint monitored by an external pinger (Pingdom / Better Stack)
- [ ] PagerDuty / Slack alert on `/health` 5xx for > 5 min

## Decisions to confirm before starting

These show up in the PRD as open questions; resolve before Phase 0:

1. **PostHog: one project with `app_id` dimension, or per-product projects?**
   Default plan is one project (simpler). Reconfirm before writing `posthog-client.ts`.
2. **GitHub OAuth App owner: `bibleinnovationlab` user vs. `Bible-Innovation-Lab` org?**
   Recommend org. Confirm before Phase 0.
3. **Token rotation cadence:** quarterly default. Confirm with YouVersion security.
4. **`VERCEL_TEAM_ID` discovery:** can be looked up once via `gh api` / Vercel CLI;
   needs to be confirmed and stored alongside the other env vars.

## Estimated timeline

| Phase | Effort | Cumulative |
|---|---|---|
| 0: Setup | 2 h | 0.5 d |
| 1: Validation + KV | 4 h | 1.0 d |
| 2: Auth | 4 h | 1.5 d |
| 3: Vercel client | 4 h | 2.0 d |
| 4: `/provision` | 4 h | 2.5 d |
| 5: `/teardown` + status + health | 4 h | 3.0 d |
| 6: Bash client update | 2 h | 3.25 d |
| 7: Tests + polish | 4 h | 3.75 d |
| Bootstrap deploy + manual verification | 2 h | 4.0 d |

Total: ~4 days of focused single-engineer work. The PRD estimate of 3-5 person-days
holds.

## What to do first when picking this up

1. Resolve the four "decisions to confirm" above.
2. Set up the BIL GitHub OAuth App.
3. Confirm Vercel team access + grab the `VERCEL_TEAM_ID`.
4. Phase 0 (setup) + Phase 1 (validation + KV) — these unblock everything else and
   don't depend on external services.
5. Then Phase 2 → 7 in order.
