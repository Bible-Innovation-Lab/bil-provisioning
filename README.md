# bil-provisioning

The internal service that imports BIL Launchpad student products into Vercel,
attaches their subdomains, and injects analytics env vars — without exposing
admin credentials to student machines.

**Status:** live at https://provisioning.bibleinnovationlab.org since 2026-05-13.
See [`docs/PRD.md`](docs/PRD.md) and [`docs/implementation-plan.md`](docs/implementation-plan.md).

---

## What it does

The launchpad's `scripts/setup.sh` calls this service when a student finishes
forking the template. The service:

1. Authenticates the student via GitHub OAuth device flow.
2. Verifies the student is a member of the `Bible-Innovation-Lab` GitHub org.
3. Validates the requested `app-id` (regex + denylist + atomic claim).
4. Imports the student's repo into the BIL Vercel team as a new project.
5. Attaches `<app-id>.bibleinnovationlab.org` as the project domain.
6. Injects `APP_ID`, `POSTHOG_KEY`, `POSTHOG_HOST`, `YOUVERSION_API_KEY` env vars
   — plus the shared `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` pair
   for multiplayer when `APP_UPSTASH_REDIS_REST_*` is configured on this service
   (see `.env.example`). Apps built on `@bil/launchpad/realtime` then get
   cross-invocation state with no setup; if the shared store isn't configured,
   injection is skipped and apps fall back to a dev-only in-memory store.
7. Returns the live URL.

**The whole point:** the BIL Vercel team API token and the PostHog admin token
live ONLY in this service's environment variables. They never touch the launchpad
template, student machines, or chat conversations.

## Why it has its own repo

- Different deploy cadence than the launchpad (rare updates vs. forked-50-times-per-summer)
- Different permission surface (admin tokens vs. public template code)
- Different test posture (integration tests against staging Vercel + PostHog)
- Easier audit story ("here is the only repo that holds admin tokens")

## How students interact with it

They don't, directly. The launchpad's `setup.sh` makes one HTTPS call to
`POST /provision` and shows the user-facing output. From the student's
perspective, they ran `./scripts/setup.sh` and got a live URL back.

If the service is unreachable, `setup.sh` falls back to printing a manual
runbook for the platform team.

## How the platform team interacts with it

- **Read logs** via Vercel dashboard.
- **Trigger teardowns** via `POST /teardown { app_id }` (gated by BIL admin org
  membership) when a student's program slot ends.
- **Rotate tokens** quarterly via the Vercel + PostHog dashboards and update
  this service's env vars.

## Error codes

Every endpoint returns JSON. Successful responses return `200` (or `201` for
`/provision`); error responses return `{ "error": "<code>" }` with the
matching HTTP status. Use the codes — not the messages — for programmatic
error handling.

### Auth (any endpoint that requires a token)

| HTTP | Code | When |
|---|---|---|
| 401 | `missing_token` | No `Authorization` header, or it's not `Bearer <token>` |
| 401 | `invalid_token` | GitHub rejected the bearer token (expired, revoked, malformed) |
| 403 | `not_org_member` | Token holder isn't an active member of `Bible-Innovation-Lab` (`/provision` only) |
| 403 | `not_admin` | Token holder isn't an active member of the admin team `platform-admins` (`/teardown`, `/status`) |
| 502 | `github_unavailable` | GitHub returned 5xx or was unreachable |

### `POST /provision`

| HTTP | Code | When |
|---|---|---|
| 201 | — | Success. Body: `{ url, project_id }` |
| 400 | `malformed_body` | Body isn't `{ repo: "owner/name", app_id: string }` |
| 400 | `app_id_invalid` | `app_id` fails the regex `^[a-z][a-z0-9-]{2,30}$` |
| 400 | `denylisted` | `app_id` is in the reserved-name denylist |
| 400 | `repo_not_owned` | `repo` doesn't have `Bible-Innovation-Lab` as the owner |
| 400 | `app_id_taken` | Another repo owns this `app_id`, or a pending claim is mid-flight |
| 409 | `already_provisioned` | Idempotent retry: the same repo already claimed this `app_id`. Body includes `project_id` + `url` |
| 500 | `vercel_api_error` | Vercel returned an error during project create / domain / env / deploy. Claim + orphan project are rolled back |
| 500 | `internal` | Unexpected non-Vercel error. Claim is released |

### `POST /teardown`

| HTTP | Code | When |
|---|---|---|
| 200 | — | Success. Body: `{ app_id, project_id, released: true }` |
| 400 | `malformed_body` / `app_id_invalid` / `denylisted` | Same as `/provision` |
| 404 | `not_found` | No KV claim exists for this `app_id` |
| 500 | `vercel_api_error` | Vercel returned non-404 error during `removeDomain` or `deleteProject`. **Claim is preserved** so admin can retry — students aren't locked out by a Vercel hiccup |
| 500 | `internal` | Unexpected non-Vercel error. Claim is preserved |

`removeDomain`/`deleteProject` returning **404** is treated as "already gone" — teardown continues and the claim is released. This makes teardown converge to "nothing left" regardless of partial prior state.

### `GET /status?app_id=<id>`

| HTTP | Code | When |
|---|---|---|
| 200 | — | Always 200 on auth success. Body: `{ claimed: false }` or `{ claimed: true, state: "active"\|"pending", repo, claimed_at, project_id, url }` |
| 400 | `missing_app_id` | `app_id` query param wasn't provided |
| 400 | `app_id_invalid` / `denylisted` | Same as `/provision` |

### `GET /health`

| HTTP | Code | When |
|---|---|---|
| 200 | — | Always. Body: `{ status: "ok", ts: "<ISO8601>" }`. No auth. |

### Method mismatch (any endpoint)

| HTTP | Code | When |
|---|---|---|
| 405 | `method_not_allowed` | Used the wrong HTTP method (e.g. `GET /provision`) |

## Documentation

- [`docs/PRD.md`](docs/PRD.md) — requirements: endpoint contract, auth model, threat model, success criteria
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — implementation, deployment, and test plan

## Related

- [`Bible-Innovation-Lab/launchpad`](https://github.com/Bible-Innovation-Lab/launchpad) — the template students fork
- [`Bible-Innovation-Lab/bible-trivia`](https://github.com/Bible-Innovation-Lab/bible-trivia) — product #1, the proving case for this service

## License

Internal use only.
