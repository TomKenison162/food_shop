import { describe, expect, it } from "vitest";
import { requireUserId } from "./userGuard";
import { buildFeedbackLink, verifyFeedbackLink } from "./feedbackLink";

process.env.CRON_SECRET ??= "test-secret-for-signing";

/**
 * The danger in multi-tenancy here is not difficulty, it is silence. A query
 * that forgets its user filter looks identical to one that works, right up
 * until one person is rating another's meals. These tests exist to make that
 * failure mode loud.
 */
describe("requireUserId", () => {
  it("accepts a real user id", () => {
    expect(requireUserId(1, "test")).toBe(1);
    expect(requireUserId(42, "test")).toBe(42);
  });

  const rejected: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -1],
    ["a fraction", 1.5],
    ["NaN", NaN],
    ["a string", "1"],
  ];

  for (const [label, value] of rejected) {
    it(`throws on ${label} rather than defaulting to user 1`, () => {
      // Defaulting is the whole problem: it would write into someone else's
      // data and never say so.
      expect(() => requireUserId(value as number, "test")).toThrow(/Missing or invalid userId/);
    });
  }

  it("names the calling context, so a leak is traceable", () => {
    expect(() => requireUserId(undefined, "scoreMealsForTonight")).toThrow(/scoreMealsForTonight/);
  });
});

describe("feedback links are bound to one user", () => {
  const base = { mealId: 7, date: "2026-08-17", action: "accept" as const };

  it("round-trips for the user it was built for", () => {
    const url = new URL(buildFeedbackLink("https://x.test", { userId: 1, ...base }));
    expect(verifyFeedbackLink({ userId: 1, ...base }, url.searchParams.get("sig")!)).toBe(true);
  });

  it("refuses the same link replayed as another user", () => {
    // Without the user inside the signature, one household member's tap
    // would label someone else's dinner.
    const url = new URL(buildFeedbackLink("https://x.test", { userId: 1, ...base }));
    expect(verifyFeedbackLink({ userId: 2, ...base }, url.searchParams.get("sig")!)).toBe(false);
  });

  it("carries the user in the query string so the route can read it", () => {
    const url = new URL(buildFeedbackLink("https://x.test", { userId: 3, ...base }));
    expect(url.searchParams.get("user")).toBe("3");
  });

  it("still refuses a tampered rating", () => {
    const url = new URL(buildFeedbackLink("https://x.test", { userId: 1, ...base, rating: 1 }));
    expect(verifyFeedbackLink({ userId: 1, ...base, rating: 5 }, url.searchParams.get("sig")!)).toBe(false);
  });
});
