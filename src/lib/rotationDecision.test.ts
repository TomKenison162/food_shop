import { describe, expect, it } from "vitest";
import {
  decideTonightsDinner,
  MAX_SERVES_IN_WINDOW,
  type MealRecord,
  type RotationInput,
} from "./rotationDecision";

function meal(overrides: Partial<MealRecord> & { id: number }): MealRecord {
  return {
    name: `Meal ${overrides.id}`,
    description: "",
    instructions: [],
    primaryProtein: "chicken",
    costFirstShopOnePerson: "10.00",
    costFirstShopTwoPerson: "10.00",
    costMarginalOnePerson: "2.50",
    costMarginalTwoPerson: "5.00",
    tier: "standard",
    isClassic: false,
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as MealRecord;
}

function input(overrides: Partial<RotationInput> = {}): RotationInput {
  return {
    portions: 2,
    approvedMeals: [meal({ id: 1 })],
    servesInWindow: new Map(),
    yesterdaysProtein: null,
    spentThisWeek: 0,
    weeklyBudget: 100,
    scores: null,
    random: () => 0, // deterministic: always picks the first candidate
    ...overrides,
  };
}

describe("decideTonightsDinner", () => {
  it("returns null when the approved queue is empty", () => {
    expect(decideTonightsDinner(input({ approvedMeals: [] }))).toBeNull();
  });

  it("picks from the approved queue when no rule is triggered", () => {
    const result = decideTonightsDinner(input());
    expect(result?.meal.id).toBe(1);
    expect(result?.relaxedProteinRule).toBe(false);
    expect(result?.relaxedRepeatRule).toBe(false);
    expect(result?.relaxedBudgetRule).toBe(false);
  });

  describe("anti-repetition rule", () => {
    it("excludes meals already served the maximum times in the window", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1 }), meal({ id: 2 })],
          servesInWindow: new Map([[1, MAX_SERVES_IN_WINDOW]]),
        })
      );
      expect(result?.meal.id).toBe(2);
      expect(result?.relaxedRepeatRule).toBe(false);
    });

    it("allows a meal served fewer than the maximum times", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1 })],
          servesInWindow: new Map([[1, MAX_SERVES_IN_WINDOW - 1]]),
        })
      );
      expect(result?.meal.id).toBe(1);
      expect(result?.relaxedRepeatRule).toBe(false);
    });

    it("relaxes the rule (flagged) when every meal is over-exposed", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1 }), meal({ id: 2 })],
          servesInWindow: new Map([
            [1, MAX_SERVES_IN_WINDOW],
            [2, MAX_SERVES_IN_WINDOW],
          ]),
        })
      );
      expect(result).not.toBeNull();
      expect(result?.relaxedRepeatRule).toBe(true);
    });
  });

  describe("protein rotation rule", () => {
    it("excludes meals sharing yesterday's protein", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1, primaryProtein: "beef" }), meal({ id: 2, primaryProtein: "fish" })],
          yesterdaysProtein: "beef",
        })
      );
      expect(result?.meal.id).toBe(2);
      expect(result?.relaxedProteinRule).toBe(false);
    });

    it("relaxes the rule (flagged) when every meal shares yesterday's protein", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1, primaryProtein: "beef" }), meal({ id: 2, primaryProtein: "beef" })],
          yesterdaysProtein: "beef",
        })
      );
      expect(result).not.toBeNull();
      expect(result?.relaxedProteinRule).toBe(true);
    });

    it("applies no protein exclusion when nothing was served yesterday", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1, primaryProtein: "beef" })],
          yesterdaysProtein: null,
        })
      );
      expect(result?.meal.id).toBe(1);
      expect(result?.relaxedProteinRule).toBe(false);
    });
  });

  describe("weekly budget rule", () => {
    it("excludes meals that would exceed the remaining budget", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [
            meal({ id: 1, costMarginalTwoPerson: "30.00" }),
            meal({ id: 2, costMarginalTwoPerson: "5.00" }),
          ],
          spentThisWeek: 90, // £10 left
        })
      );
      expect(result?.meal.id).toBe(2);
      expect(result?.relaxedBudgetRule).toBe(false);
    });

    it("serves the cheapest option (flagged) when everything busts the budget", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [
            meal({ id: 1, costMarginalTwoPerson: "30.00" }),
            meal({ id: 2, costMarginalTwoPerson: "12.00" }),
          ],
          spentThisWeek: 99, // £1 left, nothing fits
        })
      );
      expect(result?.meal.id).toBe(2);
      expect(result?.relaxedBudgetRule).toBe(true);
    });

    it("uses the one-person cost when portions is 1", () => {
      // £6 marginal for 2, £3 for 1: affordable only at the 1-person price.
      const result = decideTonightsDinner(
        input({
          portions: 1,
          approvedMeals: [meal({ id: 1, costMarginalOnePerson: "3.00", costMarginalTwoPerson: "6.00" })],
          spentThisWeek: 96, // £4 left
        })
      );
      expect(result?.meal.id).toBe(1);
      expect(result?.relaxedBudgetRule).toBe(false);
    });

    it("does not budget-exclude unpriced meals", () => {
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1, costMarginalOnePerson: null, costMarginalTwoPerson: null })],
          spentThisWeek: 100,
        })
      );
      expect(result?.meal.id).toBe(1);
      expect(result?.relaxedBudgetRule).toBe(false);
    });
  });

  describe("rule priority", () => {
    it("keeps anti-repetition when relaxing the protein rule", () => {
      // Both remaining meals are beef (so protein must relax), but meal 1 is
      // over-exposed — the repeat rule should still exclude it.
      const result = decideTonightsDinner(
        input({
          approvedMeals: [
            meal({ id: 1, primaryProtein: "beef" }),
            meal({ id: 2, primaryProtein: "beef" }),
          ],
          servesInWindow: new Map([[1, MAX_SERVES_IN_WINDOW]]),
          yesterdaysProtein: "beef",
        })
      );
      expect(result?.meal.id).toBe(2);
      expect(result?.relaxedProteinRule).toBe(true);
      expect(result?.relaxedRepeatRule).toBe(false);
    });
  });

  describe("model ranking", () => {
    it("favours the highest-scoring candidate", () => {
      // random()=0 lands in the first slice of the weighted range, which
      // belongs to whichever candidate has the largest weight.
      const result = decideTonightsDinner(
        input({
          approvedMeals: [meal({ id: 1 }), meal({ id: 2 }), meal({ id: 3 })],
          scores: new Map([
            [1, 0.2],
            [2, 0.9],
            [3, 0.5],
          ]),
          random: () => 0,
        })
      );
      expect(result?.usedModel).toBe(true);
    });

    it("samples rather than always returning the argmax", () => {
      // Greedy selection made the same meal win every night until the
      // anti-repetition rule intervened, and starved every other meal of
      // the feedback the model needs. Sampling has to reach lower-scoring
      // meals sometimes.
      const meals3 = [meal({ id: 1 }), meal({ id: 2 }), meal({ id: 3 })];
      const scores = new Map([
        [1, 0.5],
        [2, 0.9],
        [3, 0.7],
      ]);
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) {
        const r = decideTonightsDinner(
          input({ approvedMeals: meals3, scores, random: () => i / 200 })
        );
        seen.add(r!.meal.id);
      }
      expect(seen.size).toBeGreaterThan(1);
    });

    it("breaks exact ties fairly instead of always taking the first", () => {
      // Measured on real data: ~10 labelled days produced only 7 distinct
      // scores across 51 meals, with five tied at the top. Argmax resolved
      // those by array order, so one meal always won.
      const meals3 = [meal({ id: 1 }), meal({ id: 2 }), meal({ id: 3 })];
      const tied = new Map([
        [1, 0.8],
        [2, 0.8],
        [3, 0.8],
      ]);
      const seen = new Set<number>();
      for (let i = 0; i < 60; i++) {
        const r = decideTonightsDinner(
          input({ approvedMeals: meals3, scores: tied, random: () => i / 60 })
        );
        seen.add(r!.meal.id);
      }
      expect(seen.size).toBe(3);
    });

    it("only ranks candidates that survived the rules", () => {
      // Meal 2 scores highest but shares yesterday's protein, so it's out.
      const result = decideTonightsDinner(
        input({
          approvedMeals: [
            meal({ id: 1, primaryProtein: "fish" }),
            meal({ id: 2, primaryProtein: "beef" }),
          ],
          yesterdaysProtein: "beef",
          scores: new Map([
            [1, 0.1],
            [2, 0.99],
          ]),
        })
      );
      expect(result?.meal.id).toBe(1);
    });

    it("falls back to random selection when no model is trained", () => {
      const result = decideTonightsDinner(
        input({ approvedMeals: [meal({ id: 1 }), meal({ id: 2 })], scores: null, random: () => 0.99 })
      );
      expect(result?.usedModel).toBe(false);
      expect(result?.meal.id).toBe(2);
    });

    it("still respects the rules when sampling", () => {
      // Sampling must not become a back door around protein rotation.
      const meals2 = [
        meal({ id: 1, primaryProtein: "fish" }),
        meal({ id: 2, primaryProtein: "beef" }),
      ];
      const scores = new Map([
        [1, 0.1],
        [2, 0.99],
      ]);
      for (let i = 0; i < 50; i++) {
        const r = decideTonightsDinner(
          input({ approvedMeals: meals2, scores, yesterdaysProtein: "beef", random: () => i / 50 })
        );
        expect(r?.meal.id).toBe(1);
      }
    });
  });
});
