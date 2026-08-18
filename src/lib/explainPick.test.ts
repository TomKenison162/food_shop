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

  describe("random picks never claim to be reasoned", () => {
    // A real report: the email said "Picked because you've never cooked it
    // and it's a Tuesday..." right next to a "random pick" badge, for a user
    // with no trained model. Both halves were individually true — the facts
    // are real, and the pick genuinely was random — but presented together
    // it reads as "the system reasoned its way here", which it didn't. None
    // of daysSinceLastServed, proteinDaysSinceLastServed, weather, pantry
    // overlap or day/effort fit are selection rules; they're ML features
    // that only mattered if a model actually scored the pool.
    it("never says 'Picked because' without a model, however good the facts look", () => {
      const s = explainPick(
        input({
          usedModel: false,
          daysSinceLastServed: null, // "never cooked" — the strongest-looking fact there is
          proteinDaysSinceLastServed: 30,
          dish: { effortMinutes: 15, richness: 0.2, carbBase: "rice" },
        })
      );
      expect(s).not.toMatch(/^Picked because/);
      expect(s.toLowerCase()).toContain("random");
    });

    it("still surfaces the facts, just not as the reason for the pick", () => {
      const s = explainPick(input({ usedModel: false, daysSinceLastServed: null }));
      expect(s).toContain("never actually cooked it");
      expect(s).toContain("For what it's worth");
    });

    it("keeps rule relaxations even without a model, since those are genuinely causal", () => {
      const s = explainPick(input({ usedModel: false, relaxedRepeatRule: true }));
      expect(s).toContain("repetitive");
    });

    it("does claim reasons once a model actually made the pick", () => {
      const s = explainPick(input({ usedModel: false, daysSinceLastServed: null }));
      const withModel = explainPick(input({ usedModel: true, daysSinceLastServed: null }));
      expect(withModel).toMatch(/^Picked because/);
      expect(withModel).not.toContain("Random pick");
      expect(s).not.toBe(withModel);
    });
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
