# bil-provisioning

The internal service that imports BIL Launchpad student products into Vercel,
attaches their subdomains, and injects analytics env vars — without exposing
admin credentials to student machines.

**Status:** specification only. No code yet. See [`docs/PRD.md`](docs/PRD.md) and
[`docs/implementation-plan.md`](docs/implementation-plan.md).

---

## What it does

The launchpad's `scripts/setup.sh` calls this service when a student finishes
forking the template. The service:

1. Authenticates the student via GitHub OAuth device flow.
2. Verifies the student is a member of the `Bible-Innovation-Lab` GitHub org.
3. Validates the requested `app-id` (regex + denylist + atomic claim).
4. Imports the student's repo into the BIL Vercel team as a new project.
5. Attaches `<app-id>.bibleinnovationlab.org` as the project domain.
6. Injects `APP_ID`, `POSTHOG_KEY`, `NODE_ENV` env vars.
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

## Documentation

- [`docs/PRD.md`](docs/PRD.md) — requirements: endpoint contract, auth model, threat model, success criteria
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — implementation, deployment, and test plan

## Related

- [`Bible-Innovation-Lab/launchpad`](https://github.com/Bible-Innovation-Lab/launchpad) — the template students fork
- [`Bible-Innovation-Lab/bible-trivia`](https://github.com/Bible-Innovation-Lab/bible-trivia) — product #1, the proving case for this service

## License

Internal use only.
