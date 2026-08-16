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
  /** How many runners-up to offer alongside the primary pick. Default 2. */
  alternativesWanted?: number;
  /**
   * mealId -> grams of pantry stock this meal would use that expires soon.
   * Present regardless of mode, so the email can mention it either way.
   */
  expiringOverlap?: Map<number, number>;
  /**
   * When true, whatever clears the most expiring stock wins outright,
   * overriding the model. Food going in the bin is a certain loss; the
   * model's opinion is a probabilistic one, so the certain loss wins.
   */
  useItUp?: boolean;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export interface RotationDecision {
  meal: MealRecord;
  /**
   * Runners-up from the same rule-filtered pool, offered in the same email.
   * Whichever gets clicked is a comparative judgement between meals that
   * shared a context exactly — the densest preference signal available, and
   * the reason one evening now yields several training examples instead of
   * one noisy bit.
   */
  alternatives: MealRecord[];
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  relaxedBudgetRule: boolean;
  usedModel: boolean;
  /** True when use-it-up overrode normal selection. */
  useItUpMode: boolean;
  diagnostics: SelectionDiagnostics;
}

export const DEFAULT_ALTERNATIVES = 2;

/**
 * Why each meal did or didn't make it, and the sampling weights used.
 *
 * Reported purely so the event log can capture it. None of this changes the
 * decision; it exists because the alternative is throwing away the only
 * record of how a choice was actually made.
 */
export interface SelectionDiagnostics {
  approvedCount: number;
  useItUpMode: boolean;
  expiringOverlap: { mealId: number; grams: number }[];
  excludedByRepeat: number[];
  excludedByProtein: number[];
  excludedByBudget: number[];
  finalPoolIds: number[];
  temperature: number;
  /** mealId -> softmax weight, and the resulting selection probability. */
  weights: { mealId: number; weight: number; probability: number }[];
  chosenProbability: number | null;
  chosenScoreRank: number | null;
  /** Shannon entropy of the selection distribution, in nats. */
  entropy: number | null;
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

  const wanted = 1 + (input.alternativesWanted ?? DEFAULT_ALTERNATIVES);

  // Use-it-up: rank by expiring stock cleared, not by model score. Only
  // engages when something in the pool would actually use something up,
  // so switching it on during an empty pantry changes nothing.
  const expiring = input.expiringOverlap ?? new Map<number, number>();
  const clearsSomething = pool.some((m) => (expiring.get(m.id) ?? 0) > 0);
  const useItUpMode = (input.useItUp ?? false) && clearsSomething;

  let picked: MealRecord[];
  let usedModel: boolean;
  if (useItUpMode) {
    picked = [...pool]
      .sort((a, b) => (expiring.get(b.id) ?? 0) - (expiring.get(a.id) ?? 0))
      .slice(0, wanted);
    usedModel = false;
  } else {
    const sampled = sampleDistinct(pool, input.scores, random, wanted);
    picked = sampled.meals;
    usedModel = sampled.usedModel;
  }
  const chosen = picked[0];

  const inPool = new Set(pool.map((m) => m.id));
  const rawWeights = pool.map((m) =>
    input.scores ? Math.exp((input.scores.get(m.id) ?? 0) / SOFTMAX_TEMPERATURE) : 1
  );
  const totalWeight = rawWeights.reduce((a, b) => a + b, 0);
  const weights = pool.map((m, i) => ({
    mealId: m.id,
    weight: rawWeights[i],
    probability: totalWeight > 0 ? rawWeights[i] / totalWeight : 0,
  }));
  const entropy = totalWeight > 0
    ? -weights.reduce((acc, w) => (w.probability > 0 ? acc + w.probability * Math.log(w.probability) : acc), 0)
    : null;

  const ranked = input.scores
    ? [...pool].sort((a, b) => (input.scores!.get(b.id) ?? 0) - (input.scores!.get(a.id) ?? 0))
    : null;

  return {
    meal: chosen,
    alternatives: picked.slice(1),
    relaxedProteinRule,
    relaxedRepeatRule,
    relaxedBudgetRule,
    usedModel,
    useItUpMode,
    diagnostics: {
      approvedCount: approvedMeals.length,
      useItUpMode,
      expiringOverlap: [...expiring.entries()].map(([mealId, grams]) => ({ mealId, grams })),
      excludedByRepeat: approvedMeals.filter((m) => !notOverExposed.includes(m)).map((m) => m.id),
      excludedByProtein: base.filter((m) => !pool.includes(m) && yesterdaysProtein !== null && m.primaryProtein === yesterdaysProtein).map((m) => m.id),
      excludedByBudget: base.filter((m) => !inPool.has(m.id) && !(yesterdaysProtein !== null && m.primaryProtein === yesterdaysProtein)).map((m) => m.id),
      finalPoolIds: pool.map((m) => m.id),
      temperature: SOFTMAX_TEMPERATURE,
      weights,
      chosenProbability: weights.find((w) => w.mealId === chosen.id)?.probability ?? null,
      chosenScoreRank: ranked ? ranked.findIndex((m) => m.id === chosen.id) + 1 : null,
      entropy: entropy !== null ? Number(entropy.toFixed(6)) : null,
    },
  };
}

/**
 * Draws `count` distinct meals, best-first, by repeated softmax sampling
 * without replacement.
 *
 * Sampling the alternatives (rather than taking the next-highest scorers)
 * matters for the same reason it matters for the primary: the runners-up are
 * what generate comparative training data, so a fixed top-3 would keep
 * asking about the same three meals and teach the model nothing about the
 * rest of the queue.
 */
function sampleDistinct(
  pool: MealRecord[],
  scores: Map<number, number> | null,
  random: () => number,
  count: number
): { meals: MealRecord[]; usedModel: boolean } {
  const remaining = [...pool];
  const chosen: MealRecord[] = [];
  let usedModel = false;

  while (chosen.length < count && remaining.length > 0) {
    const result = pick(remaining, scores, random);
    usedModel = result.usedModel;
    chosen.push(result.meal);
    remaining.splice(
      remaining.findIndex((m) => m.id === result.meal.id),
      1
    );
  }

  return { meals: chosen, usedModel };
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
