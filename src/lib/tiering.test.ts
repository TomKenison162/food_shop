import { describe, expect, it } from "vitest";
import { tierForCost } from "./tiering";
import { WEEKLY_BUDGET_GBP } from "./budget";

const dailyAllowance = WEEKLY_BUDGET_GBP / 7;

describe("tierForCost", () => {
  it("returns null for unpriced meals", () => {
    expect(tierForCost(null)).toBeNull();
  });

  it("scales with the weekly budget rather than fixed thresholds", () => {
    expect(tierForCost(dailyAllowance * 0.25)).toBe("budget");
    expect(tierForCost(dailyAllowance * 0.75)).toBe("standard");
    expect(tierForCost(dailyAllowance * 1.5)).toBe("gourmet");
  });

  it("puts boundary values in the cheaper tier", () => {
    expect(tierForCost(dailyAllowance * 0.5)).toBe("budget");
    expect(tierForCost(dailyAllowance)).toBe("standard");
  });

  it("treats free meals as budget", () => {
    expect(tierForCost(0)).toBe("budget");
  });
});
