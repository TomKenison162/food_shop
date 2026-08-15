import { describe, expect, it } from "vitest";
import { shelfLifeDays } from "./shelfLife";

describe("shelfLifeDays", () => {
  it("gives fresh meat and fish only a few days", () => {
    expect(shelfLifeDays("chicken thighs")).toBeLessThanOrEqual(3);
    expect(shelfLifeDays("salmon fillets")).toBeLessThanOrEqual(2);
    expect(shelfLifeDays("beef mince")).toBeLessThanOrEqual(3);
  });

  it("gives dry goods a long life", () => {
    expect(shelfLifeDays("basmati rice")).toBeGreaterThan(90);
    expect(shelfLifeDays("plain flour")).toBeGreaterThan(90);
    expect(shelfLifeDays("ground cumin")).toBeGreaterThan(90);
  });

  it("puts fresh produce in between", () => {
    const salad = shelfLifeDays("mixed salad leaves");
    expect(salad).toBeGreaterThan(1);
    expect(salad).toBeLessThan(14);
  });

  it("prefers the most specific match", () => {
    // "beef mince" should be treated as mince (2d), not generic beef (3d).
    expect(shelfLifeDays("beef mince")).toBe(2);
  });

  it("distinguishes dried/ground preparations from their fresh form", () => {
    expect(shelfLifeDays("fresh coriander")).toBeLessThan(14);
    expect(shelfLifeDays("ground coriander")).toBeGreaterThan(90);
    expect(shelfLifeDays("dried apricots")).toBeGreaterThan(90);
  });

  it("falls back to a conservative default for unknown items", () => {
    expect(shelfLifeDays("mystery ingredient")).toBe(7);
  });
});
