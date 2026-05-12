import { beforeEach, describe, expect, it } from "vitest";
import {
  claimAppId,
  confirmClaim,
  getClaim,
  releaseAppId,
  type ClaimRecord,
} from "../lib/kv.js";
import { FakeKv } from "./fake-kv.js";

let now = 1_700_000_000_000;
let kv: FakeKv;

beforeEach(() => {
  now = 1_700_000_000_000;
  kv = new FakeKv(() => now);
});

describe("claimAppId — atomicity", () => {
  it("first caller wins, second caller is rejected", async () => {
    const first = await claimAppId("bible-trivia", "Bible-Innovation-Lab/bible-trivia", kv);
    const second = await claimAppId("bible-trivia", "Bible-Innovation-Lab/bible-trivia-fork", kv);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("different app-ids do not collide", async () => {
    // claimAppId is format-agnostic; validation lives one layer up. Two
    // distinct ids should each succeed independently.
    expect(await claimAppId("foo", "Bible-Innovation-Lab/foo", kv)).toBe(true);
    expect(await claimAppId("bar", "Bible-Innovation-Lab/bar", kv)).toBe(true);
    expect(await claimAppId("foo", "Bible-Innovation-Lab/foo2", kv)).toBe(false);
  });

  it("writes a claim record with repo + claimed_at", async () => {
    await claimAppId("memory-verse", "Bible-Innovation-Lab/memory-verse", kv);
    const record = await getClaim("memory-verse", kv);
    expect(record).not.toBeNull();
    expect(record!.repo).toBe("Bible-Innovation-Lab/memory-verse");
    expect(record!.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record!.project_id).toBeUndefined();
  });

  it("sets a 5-minute TTL on the lock", async () => {
    await claimAppId("pending-lock", "Bible-Innovation-Lab/pending-lock", kv);
    const ttlMs = kv._ttlMs("app_id:pending-lock");
    expect(ttlMs).not.toBeNull();
    expect(ttlMs!).toBeGreaterThan(299_000);
    expect(ttlMs!).toBeLessThanOrEqual(300_000);
  });
});

describe("claimAppId — TTL expiry frees the lock", () => {
  it("an expired claim can be re-acquired", async () => {
    await claimAppId("lapsed", "Bible-Innovation-Lab/lapsed", kv);
    expect(await claimAppId("lapsed", "Bible-Innovation-Lab/other", kv)).toBe(false);

    now += 301_000; // 5m + 1s
    expect(await claimAppId("lapsed", "Bible-Innovation-Lab/other", kv)).toBe(true);
    const record = await getClaim("lapsed", kv);
    expect(record!.repo).toBe("Bible-Innovation-Lab/other");
  });
});

describe("confirmClaim — promotes lock to permanent", () => {
  it("overwrites payload with project_id and removes TTL", async () => {
    await claimAppId("promote", "Bible-Innovation-Lab/promote", kv);
    await confirmClaim("promote", "prj_abc123", kv);

    const record = await getClaim("promote", kv);
    expect(record).toEqual<ClaimRecord>({
      repo: "Bible-Innovation-Lab/promote",
      claimed_at: expect.any(String),
      project_id: "prj_abc123",
    });
    expect(kv._ttlMs("app_id:promote")).toBeNull();
  });

  it("confirmed claim survives well past the original TTL", async () => {
    await claimAppId("durable", "Bible-Innovation-Lab/durable", kv);
    await confirmClaim("durable", "prj_durable", kv);

    now += 24 * 60 * 60 * 1000; // a day later
    expect(await getClaim("durable", kv)).not.toBeNull();
  });

  it("throws when called on an unclaimed app-id", async () => {
    await expect(confirmClaim("ghost", "prj_ghost", kv)).rejects.toThrow(
      /unclaimed app_id: ghost/
    );
  });
});

describe("releaseAppId — cleanup path", () => {
  it("frees a pending claim so it can be re-acquired", async () => {
    await claimAppId("rollback", "Bible-Innovation-Lab/rollback", kv);
    expect(await releaseAppId("rollback", kv)).toBe(true);
    expect(await getClaim("rollback", kv)).toBeNull();
    expect(await claimAppId("rollback", "Bible-Innovation-Lab/retry", kv)).toBe(true);
  });

  it("frees a confirmed claim too (admin teardown path)", async () => {
    await claimAppId("teardown-me", "Bible-Innovation-Lab/teardown-me", kv);
    await confirmClaim("teardown-me", "prj_teardown", kv);
    expect(await releaseAppId("teardown-me", kv)).toBe(true);
    expect(await getClaim("teardown-me", kv)).toBeNull();
  });

  it("is a no-op (returns false) for a missing claim", async () => {
    expect(await releaseAppId("never-existed", kv)).toBe(false);
  });
});

describe("getClaim — read-only", () => {
  it("returns null for missing", async () => {
    expect(await getClaim("nope", kv)).toBeNull();
  });

  it("returns the record after claim", async () => {
    await claimAppId("readable", "Bible-Innovation-Lab/readable", kv);
    const record = await getClaim("readable", kv);
    expect(record).toMatchObject({
      repo: "Bible-Innovation-Lab/readable",
    });
  });

  it("does not return an expired claim", async () => {
    await claimAppId("temp", "Bible-Innovation-Lab/temp", kv);
    now += 301_000;
    expect(await getClaim("temp", kv)).toBeNull();
  });
});
