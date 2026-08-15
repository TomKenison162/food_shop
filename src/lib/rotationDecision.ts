import type { meals } from "./db/schema";
import { costForPortions } from "./budget";

export type MealRecord = typeof meals.$inferSelect;

export const REPEAT_WINDOW_DAYS = 60;
export const MAX_SERVES_IN_WINDOW = 2;

export interface RotationInput {
  portions: 1 | 2;
  approvedMeals: MealRecord[];
  /** mealId -> times served within REPEAT_WINDOW_DAYS. */
  servesInWindow: Map<number, number>;
  /** Primary protein of yesterday's meal, or null if nothing was served. */
  yesterdaysProtein: string | null;
  spentThisWeek: number;
  weeklyBudget: number;
  /** mealId -> P(accepted) from the trained model, or null when no model exists yet. */
  scores: Map<number, number> | null;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export interface RotationDecision {
  meal: MealRecord;
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  relaxedBudgetRule: boolean;
  usedModel: boolean;
}

/**
 * Pure meal-selection logic — no database, no clock, no network — so the
 * rules can actually be tested. `selectTonightsDinner` in rotation.ts is
 * the thin wrapper that gathers this input and persists the result.
 *
 * Rules, in order of priority:
 *  1. anti-repetition — a meal already served MAX_SERVES_IN_WINDOW times in
 *     the last REPEAT_WINDOW_DAYS is out
 *  2. protein rotation — anything sharing yesterday's protein is out
 *  3. weekly budget — anything that would push the week past `weeklyBudget` is out
 *  4. of whatever survives, the ML model picks the best; without a trained
 *     model, uniform random
 *
 * Rules 1-3 are relaxed in reverse-priority order (budget first, then
 * protein, then repetition) when they'd otherwise leave nothing to serve —
 * dinner still has to happen. Each relaxation is reported back so the email
 * can say why, rather than silently ignoring a constraint.
 */
export function decideTonightsDinner(input: RotationInput): RotationDecision | null {
  const { approvedMeals, portions, servesInWindow, yesterdaysProtein, spentThisWeek, weeklyBudget } = input;
  const random = input.random ?? Math.random;

  if (approvedMeals.length === 0) return null;

  const notOverExposed = approvedMeals.filter(
    (m) => (servesInWindow.get(m.id) ?? 0) < MAX_SERVES_IN_WINDOW
  );

  let relaxedRepeatRule = false;
  let base = notOverExposed;
  if (base.length === 0) {
    base = approvedMeals;
    relaxedRepeatRule = true;
  }

  let relaxedProteinRule = false;
  let pool = yesterdaysProtein
    ? base.filter((m) => m.primaryProtein !== yesterdaysProtein)
    : base;
  if (pool.length === 0) {
    pool = base;
    relaxedProteinRule = true;
  }

  const remaining = weeklyBudget - spentThisWeek;
  const affordable = pool.filter((m) => {
    const cost = costForPortions(m, portions);
    return cost === null || cost <= remaining; // unpriced meals can't be budget-checked
  });

  let relaxedBudgetRule = false;
  if (affordable.length > 0) {
    pool = affordable;
  } else {
    // Everything busts the budget — serve the cheapest rather than the
    // most expensive, and flag that the cap was blown.
    relaxedBudgetRule = true;
    pool = [cheapestOf(pool, portions)];
  }

  const { meal, usedModel } = pick(pool, input.scores, random);
  return { meal, relaxedProteinRule, relaxedRepeatRule, relaxedBudgetRule, usedModel };
}

function pick(
  pool: MealRecord[],
  scores: Map<number, number> | null,
  random: () => number
): { meal: MealRecord; usedModel: boolean } {
  if (scores === null) {
    return { meal: pool[Math.floor(random() * pool.length)], usedModel: false };
  }
  let best = pool[0];
  let bestScore = scores.get(best.id) ?? -Infinity;
  for (const m of pool.slice(1)) {
    const s = scores.get(m.id) ?? -Infinity;
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return { meal: best, usedModel: true };
}

function cheapestOf(pool: MealRecord[], portions: 1 | 2): MealRecord {
  return pool.reduce((cheapest, m) => {
    const a = costForPortions(m, portions);
    const b = costForPortions(cheapest, portions);
    if (a === null) return cheapest;
    if (b === null) return m;
    return a < b ? m : cheapest;
  }, pool[0]);
}
