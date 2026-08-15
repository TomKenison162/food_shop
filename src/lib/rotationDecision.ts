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

/**
 * Higher temperature = more adventurous. 0.08 keeps a clear preference for
 * better-scoring meals while still giving the rest a real chance: with
 * scores of 0.9 vs 0.7, the favourite is picked ~9x as often, not always.
 */
export const SOFTMAX_TEMPERATURE = 0.08;

/**
 * Picks from the pool by sampling in proportion to exp(score / T), rather
 * than always taking the argmax.
 *
 * Greedy argmax was actively harmful here for two measured reasons:
 *
 *  1. Ties. On this feature set with shallow trees and a small training
 *     set, the model emits very few distinct values — at ~10 labelled days
 *     it scored 51 candidate meals with only 7 distinct probabilities, five
 *     of them tied at the top. Argmax broke those ties by array order, so
 *     the same meal won every time until the anti-repetition rule forced a
 *     change.
 *  2. Exploration. The model is only ever labelled on meals it chose, so
 *     greedy selection is a closed loop: dishes it never picks never get
 *     feedback and can never rise. Sampling keeps that loop open.
 */
function pick(
  pool: MealRecord[],
  scores: Map<number, number> | null,
  random: () => number
): { meal: MealRecord; usedModel: boolean } {
  if (scores === null) {
    return { meal: pool[Math.floor(random() * pool.length)], usedModel: false };
  }

  const weights = pool.map((m) => Math.exp((scores.get(m.id) ?? 0) / SOFTMAX_TEMPERATURE));
  const total = weights.reduce((a, b) => a + b, 0);

  if (!Number.isFinite(total) || total <= 0) {
    // Degenerate weights (all zero, or overflowed to Infinity) — fall back
    // to a uniform pick rather than silently always taking index 0.
    return { meal: pool[Math.floor(random() * pool.length)], usedModel: true };
  }

  let threshold = random() * total;
  for (let i = 0; i < pool.length; i++) {
    threshold -= weights[i];
    if (threshold <= 0) return { meal: pool[i], usedModel: true };
  }
  return { meal: pool[pool.length - 1], usedModel: true };
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
