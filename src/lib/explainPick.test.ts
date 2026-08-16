import { describe, expect, it } from "vitest";
import { explainPick, type ExplainInput } from "./explainPick";

function input(over: Partial<ExplainInput> = {}): ExplainInput {
  return {
    mealName: "Beef Stew", protein: "beef",
    dish: { effortMinutes: 40, richness: 0.4, carbBase: "potato" },
    temperatureC: 14, precipitationMm: 0, isWeekend: false, dayName: "Tuesday",
    daysSinceLastServed: 20, proteinDaysSinceLastServed: 5,
    expiringUsed: [], pantryUsed: [], usedModel: false,
    scoreRank: null, poolSize: 10,
    relaxedProteinRule: false, relaxedRepeatRule: false, relaxedBudgetRule: false,
    useItUpMode: false, ...over,
  };
}

describe("explainPick", () => {
  it("leads with use-it-up when that drove the choice", () => {
    const s = explainPick(input({ useItUpMode: true, expiringUsed: ["coriander", "cream"] }));
    expect(s).toContain("Use-it-up night");
    expect(s).toContain("coriander and cream");
  });

  it("mentions expiring stock before anything else", () => {
    expect(explainPick(input({ expiringUsed: ["coriander"] }))).toContain("uses up coriander");
  });

  it("links cold weather to a rich dish", () => {
    const s = explainPick(input({ temperatureC: 4, dish: { effortMinutes: 90, richness: 0.6, carbBase: "potato" } }));
    expect(s).toMatch(/4°/);
  });

  it("counts protein gaps in weeks", () => {
    expect(explainPick(input({ proteinDaysSinceLastServed: 22 }))).toContain("haven't had beef in 3 weeks");
  });

  it("notes a quick meal on a weeknight", () => {
    const s = explainPick(input({ dish: { effortMinutes: 20, richness: 0.2, carbBase: "rice" } }));
    expect(s).toContain("Tuesday");
  });

  it("owns up when a rule had to be relaxed", () => {
    const s = explainPick(input({ relaxedBudgetRule: true }));
    expect(s).toContain("over budget");
  });

  it("admits when there is no real reason", () => {
    const s = explainPick(input({ proteinDaysSinceLastServed: 1, daysSinceLastServed: 10, temperatureC: 15 }));
    expect(s.toLowerCase()).toContain("random");
  });

  it("never runs past three reasons", () => {
    const s = explainPick(input({
      expiringUsed: ["coriander"], temperatureC: 2, proteinDaysSinceLastServed: 30,
      daysSinceLastServed: null, usedModel: true, scoreRank: 1,
      dish: { effortMinutes: 15, richness: 0.5, carbBase: "rice" },
    }));
    expect(s.split(/,| and /).length).toBeLessThanOrEqual(6);
  });
});
