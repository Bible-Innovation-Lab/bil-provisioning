import { describe, expect, it } from "vitest";
import { handleHealth } from "../../lib/handlers/health.js";

describe("handleHealth", () => {
  it("returns 200 with status ok and an ISO timestamp", () => {
    const fixed = new Date("2026-05-12T18:00:00.000Z");
    const result = handleHealth({ now: () => fixed });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok", ts: "2026-05-12T18:00:00.000Z" });
  });

  it("defaults to real Date when no clock is injected", () => {
    const result = handleHealth();
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("ok");
    // ts is an ISO 8601 string
    expect(new Date(result.body.ts).toString()).not.toBe("Invalid Date");
  });
});
