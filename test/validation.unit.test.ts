import { describe, expect, it } from "vitest";
import { isDenylisted, validateAppId } from "../lib/validation.js";

describe("validateAppId — accepts", () => {
  it.each([
    "bible-trivia",
    "abc",
    "verse-of-day",
    "a12",
    "z-9",
    "thirty-one-chars-exactly-aaaaaa", // 31 chars (max allowed)
  ])("accepts %s", (id) => {
    expect(validateAppId(id)).toEqual({ valid: true });
  });
});

describe("validateAppId — rejects malformed input", () => {
  it.each([
    ["", "empty string"],
    ["ab", "too short (2 chars)"],
    ["thirty-two-chars-toolong-aaaaaaa", "32 chars, one over the max"], // 32 chars
    ["UPPERCASE", "uppercase"],
    ["Mixed-Case", "mixed case"],
    ["1starts-with-digit", "starts with a digit"],
    ["-starts-with-dash", "starts with a dash"],
    ["has_underscore", "underscore not allowed"],
    ["has space", "whitespace not allowed"],
    ["dots.not.allowed", "dots not allowed"],
    ["emoji-🙂", "non-ascii"],
  ])("rejects %s (%s)", (id) => {
    expect(validateAppId(id)).toEqual({
      valid: false,
      reason: "app_id_invalid",
    });
  });

  it("rejects non-string input", () => {
    expect(validateAppId(undefined)).toEqual({
      valid: false,
      reason: "app_id_invalid",
    });
    expect(validateAppId(null)).toEqual({
      valid: false,
      reason: "app_id_invalid",
    });
    expect(validateAppId(42)).toEqual({
      valid: false,
      reason: "app_id_invalid",
    });
    expect(validateAppId({})).toEqual({
      valid: false,
      reason: "app_id_invalid",
    });
  });
});

describe("validateAppId — denylist", () => {
  it.each([
    "www",
    "api",
    "admin",
    "auth",
    "youversion",
    "bibleinnovationlab",
    "bil",
    "provisioning", // self-reservation
    "staging",
    "test",
    "login",
    "root",
  ])("rejects reserved name %s", (id) => {
    expect(validateAppId(id)).toEqual({
      valid: false,
      reason: "denylisted",
    });
  });

  it("isDenylisted is case-sensitive (denylist holds lowercase forms only)", () => {
    expect(isDenylisted("admin")).toBe(true);
    expect(isDenylisted("Admin")).toBe(false);
  });
});

describe("validateAppId — ordering", () => {
  it("malformed input reports app_id_invalid even if denylisted variant exists", () => {
    // "API" would be denylisted in lowercase form, but capitalization makes
    // it malformed first — denylist check never runs.
    expect(validateAppId("API")).toEqual({
      valid: false,
      reason: "app_id_invalid",
    });
  });
});
