// Vercel KV (Upstash Redis) helpers for the app-id atomic claim.
// Spec: docs/PRD.md § F6.
//
// Claim lifecycle:
//   1. claimAppId(id, repo)      → SET app_id:<id> {…} NX EX 300   (5-min lock)
//   2. confirmClaim(id, project) → overwrite payload + PERSIST       (permanent)
//   3. releaseAppId(id)          → DEL                               (on failure)
//
// confirmClaim only runs after the Vercel API calls succeed; releaseAppId is
// the rollback path. If the lock TTL (300s) lapses before either fires, the
// app-id frees up automatically — that's the recovery for a crashed handler.

import { kv as defaultKv } from "@vercel/kv";

const CLAIM_TTL_SECONDS = 300;

export interface ClaimRecord {
  repo: string;
  claimed_at: string; // ISO 8601
  project_id?: string; // set on confirmClaim, undefined while pending
}

// Minimal subset of @vercel/kv we depend on. Lets tests pass a fake without
// pulling in a real Redis. Generic param mirrors upstash-redis's overloads.
export interface KvClient {
  set(
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: true }
  ): Promise<unknown>;
  get<T = unknown>(key: string): Promise<T | null>;
  del(...keys: string[]): Promise<number>;
  persist(key: string): Promise<unknown>;
}

function claimKey(appId: string): string {
  return `app_id:${appId}`;
}

/**
 * Atomically claim an app-id. Returns true on win, false if already claimed.
 * The claim is held with a 5-minute TTL; the caller must follow with
 * confirmClaim (on Vercel success) or releaseAppId (on failure).
 */
export async function claimAppId(
  appId: string,
  repo: string,
  client: KvClient = defaultKv
): Promise<boolean> {
  const record: ClaimRecord = {
    repo,
    claimed_at: new Date().toISOString(),
  };
  const result = await client.set(claimKey(appId), record, {
    ex: CLAIM_TTL_SECONDS,
    nx: true,
  });
  return result === "OK";
}

/**
 * Promote a pending claim to permanent. Overwrites the payload with the
 * project_id and removes the TTL. Idempotent.
 */
export async function confirmClaim(
  appId: string,
  projectId: string,
  client: KvClient = defaultKv
): Promise<void> {
  const existing = await client.get<ClaimRecord>(claimKey(appId));
  if (!existing) {
    throw new Error(`confirmClaim called for unclaimed app_id: ${appId}`);
  }
  const confirmed: ClaimRecord = { ...existing, project_id: projectId };
  // Overwrite without nx; explicitly drop TTL via persist().
  await client.set(claimKey(appId), confirmed);
  await client.persist(claimKey(appId));
}

/**
 * Release a claim. Called on Vercel provisioning failure so the app-id is
 * available for retry. Returns true if a row was deleted, false if nothing
 * was there (already released or TTL expired).
 */
export async function releaseAppId(
  appId: string,
  client: KvClient = defaultKv
): Promise<boolean> {
  const removed = await client.del(claimKey(appId));
  return removed > 0;
}

/**
 * Read the current claim record. Used by /status and integration tests.
 */
export async function getClaim(
  appId: string,
  client: KvClient = defaultKv
): Promise<ClaimRecord | null> {
  return client.get<ClaimRecord>(claimKey(appId));
}
