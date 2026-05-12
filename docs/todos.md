# Deferred TODOs

Items intentionally scoped out of v1 but worth shipping later.

## Slack alerting on `/health` outages (low priority)

**Goal:** Page (Slack DM) and notify a Slack channel when bil-provisioning
`/health` returns non-200 for > 5 minutes.

**Why deferred:** Per C4 of the bootstrap checklist, external uptime
monitoring is skipped for v1. Vercel's built-in email alerts cover the
mission-critical fail-loud case. Slack notification is nice-to-have, not
on the critical path for the summer program.

**Sketch when picked up:**
- Add a Better Stack (or UptimeRobot) monitor pinging
  `https://provisioning.bibleinnovationlab.org/health` every 60s.
- Wire it to a BIL Slack workspace channel (e.g. `#bil-alerts`).
- Add the platform-team Slack handle as a fallback DM.
- Document the on-call rotation if more than one person is admin.

**Dependencies before this lands:**
- Bootstrap deploy of bil-provisioning is complete (so `/health` exists).
- A Slack channel + incoming-webhook exists in the appropriate workspace.
- Decision on which monitoring vendor (Better Stack free tier covers it).

## Orphan-subdomain scanner cron (v2)

Per PRD § threat model and § open questions. Cron job that compares Vercel
project state vs KV claim state and reports drift.

## Load testing (v2)

Per implementation-plan § "Load test" — not v1.

## Per-product PostHog projects (v1.1)

Currently we use a single project with `app_id` event dimension. If event
volume forces isolation, build PostHog client to provision a project per
product on `/provision`.
