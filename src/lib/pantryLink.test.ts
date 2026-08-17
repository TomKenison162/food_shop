import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  process.env.CRON_SECRET = "test-secret-for-signing";
});

describe("pantry correction links", () => {
  it("round-trips a valid signature", async () => {
    const { buildPantryMissingLink, verifyPantryLink } = await import("./pantryLink");
    const url = new URL(buildPantryMissingLink("https://x.test", 1, "2026-08-17", "teriyaki sauce"));
    expect(verifyPantryLink(1, url.searchParams.get("date")!, url.searchParams.get("name")!, url.searchParams.get("sig")!)).toBe(true);
  });

  it("refuses a link edited to target a different ingredient", async () => {
    // The name is inside the signature, so holding one valid link does not
    // let you clear the whole pantry.
    const { buildPantryMissingLink, verifyPantryLink } = await import("./pantryLink");
    const url = new URL(buildPantryMissingLink("https://x.test", 1, "2026-08-17", "teriyaki sauce"));
    expect(verifyPantryLink(1, "2026-08-17", "beef mince", url.searchParams.get("sig")!)).toBe(false);
  });

  it("refuses a link replayed against another user", async () => {
    // Without the user inside the signature, one household member's link
    // would clear another's pantry.
    const { buildPantryMissingLink, verifyPantryLink } = await import("./pantryLink");
    const url = new URL(buildPantryMissingLink("https://x.test", 1, "2026-08-17", "rice"));
    expect(verifyPantryLink(2, "2026-08-17", "rice", url.searchParams.get("sig")!)).toBe(false);
  });

  it("refuses a link replayed against another date", async () => {
    const { buildPantryMissingLink, verifyPantryLink } = await import("./pantryLink");
    const url = new URL(buildPantryMissingLink("https://x.test", 1, "2026-08-17", "rice"));
    expect(verifyPantryLink(1, "2026-08-18", "rice", url.searchParams.get("sig")!)).toBe(false);
  });

  it("refuses a malformed signature without throwing", async () => {
    const { verifyPantryLink } = await import("./pantryLink");
    expect(verifyPantryLink(1, "2026-08-17", "rice", "nonsense")).toBe(false);
    expect(verifyPantryLink(1, "2026-08-17", "rice", "")).toBe(false);
  });
});
