import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { approvedQueue, meals, mealIngredients } from "../db/schema";
import { tierForCost } from "../tiering";
import { getPricingAdapter, type MatchedProduct, type PricingAdapter } from "./adapter";
import { estimateIngredientPriceGBP } from "./estimates";
import { cachedMatchesFor } from "./priceCache";
import { parseQuantityToGrams } from "./quantity";

export interface PriceApprovedResult {
  pricedMealIds: number[];
  estimatedIngredientCount: number;
  /** Unique names actually sent to the paid API (cache hits excluded). */
  uniqueIngredientsRequested: number;
  /** Unique names served from already-priced rows, costing nothing. */
  reusedFromCache: number;
}

type IngredientRow = typeof mealIngredients.$inferSelect;

/**
 * Resolves the names on `ingredients` that still need pricing, reusing
 * anything already priced elsewhere and sending only the genuine unknowns to
 * the paid adapter.
 */
async function resolveMatches(
  ingredients: IngredientRow[],
  adapter: PricingAdapter
): Promise<{ matches: Map<string, MatchedProduct | null>; requested: number; reused: number }> {
  const needed = new Set<string>();
  for (const ing of ingredients) {
    if (ing.skuPrice === null) needed.add(ing.genericName);
  }

  // trustEstimates:false on purpose. Treating a past estimate as proof that
  // no product exists made estimates self-perpetuating: "pork shoulder" was
  // guessed once, so it was never asked about again, even though the API
  // offers a Pork Shoulder Joint at £6.30. Pricing runs are rare enough that
  // re-asking is worth the handful of requests.
  const { matches: cached, unmatchable } = await cachedMatchesFor([...needed], { trustEstimates: false });

  // Only names with no prior verdict at all are worth paying for.
  const toQuery = [...needed].filter((n) => !cached.has(n) && !unmatchable.has(n));
  const fresh = toQuery.length > 0 ? await adapter.matchProducts(toQuery) : new Map();

  const matches = new Map<string, MatchedProduct | null>(fresh);
  for (const [name, match] of cached) matches.set(name, match);

  return { matches, requested: toQuery.length, reused: cached.size + unmatchable.size };
}

/**
 * Prices a single ingredient line in place: writes it to the DB and updates
 * the in-memory row so the caller's cost rollup sees it. Returns true when
 * the line fell back to an estimate.
 */
async function priceLine(
  ing: IngredientRow,
  match: MatchedProduct | null,
  adapter: PricingAdapter
): Promise<boolean> {
  const cost = adapter.costForQuantity(match, ing.quantity, ing.genericName);

  if (cost.firstShopPrice !== null) {
    await db
      .update(mealIngredients)
      .set({
        skuName: cost.skuName,
        skuPrice: String(cost.firstShopPrice),
        marginalPrice: cost.marginalPrice !== null ? String(cost.marginalPrice) : null,
        skuUnitSize: cost.skuUnitSize,
        packPrice: cost.packPrice !== null ? String(cost.packPrice) : null,
        packGrams: cost.packGrams !== null ? String(cost.packGrams) : null,
        gramsPurchased: cost.gramsPurchased !== null ? String(cost.gramsPurchased) : null,
        gramsNeeded: cost.gramsNeeded !== null ? String(cost.gramsNeeded) : null,
        isEstimated: false,
      })
      .where(eq(mealIngredients.id, ing.id));
    ing.skuPrice = String(cost.firstShopPrice);
    ing.marginalPrice = cost.marginalPrice !== null ? String(cost.marginalPrice) : null;
    return false;
  }

  // No product match at all — fall back to a flagged estimate rather than
  // leaving this meal's total incomplete. Estimates are pack prices, so
  // prorate them the same way a real match would be.
  const packPrice = estimateIngredientPriceGBP(ing.genericName);
  const parsed = parseQuantityToGrams(ing.quantity, ing.genericName);
  const assumedPackGrams = 400;
  const gramsNeeded = parsed.grams ?? assumedPackGrams * 0.1;
  const fraction = Math.min(1, gramsNeeded / assumedPackGrams);
  const marginal = Math.round(packPrice * fraction * 100) / 100;

  await db
    .update(mealIngredients)
    .set({
      skuName: null,
      skuPrice: String(packPrice),
      marginalPrice: String(marginal),
      skuUnitSize: "estimated, not from Sainsbury's",
      packPrice: String(packPrice),
      isEstimated: true,
    })
    .where(eq(mealIngredients.id, ing.id));
  ing.skuPrice = String(packPrice);
  ing.marginalPrice = String(marginal);
  return true;
}

export interface PriceMealResult {
  priced: boolean;
  reason?: string;
  estimatedIngredientCount: number;
  uniqueIngredientsRequested: number;
  reusedFromCache: number;
}

/**
 * Prices one meal, but only if it still needs it — the entry point for
 * pricing on demand rather than in a batch.
 *
 * Safe to call speculatively: an already-priced meal returns immediately
 * without touching the API, and a meal whose ingredients are all known from
 * other dishes is priced entirely from cache for free. Cost is therefore
 * bounded by how *novel* a meal's ingredients are, not by how often this runs.
 */
export async function priceMealIfNeeded(mealId: number): Promise<PriceMealResult> {
  const idle = { estimatedIngredientCount: 0, uniqueIngredientsRequested: 0, reusedFromCache: 0 };

  const meal = await db.query.meals.findFirst({ where: eq(meals.id, mealId) });
  if (!meal) return { priced: false, reason: "No such meal.", ...idle };
  if (meal.tier !== null) return { priced: false, reason: "Already priced.", ...idle };

  const ingredients = await db.query.mealIngredients.findMany({
    where: eq(mealIngredients.mealId, mealId),
  });
  if (ingredients.length === 0) return { priced: false, reason: "No ingredients.", ...idle };

  const adapter = getPricingAdapter();
  const { matches, requested, reused } = await resolveMatches(ingredients, adapter);

  let estimated = 0;
  for (const ing of ingredients) {
    if (ing.skuPrice !== null) continue;
    if (await priceLine(ing, matches.get(ing.genericName) ?? null, adapter)) estimated++;
  }

  await recomputeMealCosts(mealId, ingredients);

  return {
    priced: true,
    estimatedIngredientCount: estimated,
    uniqueIngredientsRequested: requested,
    reusedFromCache: reused,
  };
}

/**
 * Prices every approved-but-not-yet-priced meal in one batch.
 *
 * Only ingredient NAMES with no existing verdict anywhere are sent to the
 * adapter — ones another meal already resolved are reused straight from the
 * DB at zero cost (see cachedMatchesFor). Anything the API still can't match
 * gets a hand-judged estimate (src/lib/pricing/estimates.ts) instead of being
 * left unpriced, so every meal gets a real total — those lines are flagged
 * (isEstimated) and called out explicitly in the shopping-list email.
 *
 * Use priceMealIfNeeded for a single meal on demand; this batch form is worth
 * it when several meals are unpriced at once, since it dedupes names across
 * all of them before spending anything.
 */
export async function priceApprovedMeals(): Promise<PriceApprovedResult> {
  const adapter = getPricingAdapter();

  const unpriced = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .where(and(isNull(meals.tier), isNull(meals.deletedAt)));

  if (unpriced.length === 0) {
    return {
      pricedMealIds: [],
      estimatedIngredientCount: 0,
      uniqueIngredientsRequested: 0,
      reusedFromCache: 0,
    };
  }

  const ingredientsByMeal = new Map<number, IngredientRow[]>();
  const allIngredients: IngredientRow[] = [];

  for (const { meal } of unpriced) {
    const ingredients = await db.query.mealIngredients.findMany({
      where: eq(mealIngredients.mealId, meal.id),
    });
    ingredientsByMeal.set(meal.id, ingredients);
    allIngredients.push(...ingredients);
  }

  // Deliberately resolved across the whole batch at once: names shared by
  // several unpriced meals are then matched a single time, and the adapter
  // bills per request rather than per name.
  const { matches, requested, reused } = await resolveMatches(allIngredients, adapter);

  const pricedMealIds: number[] = [];
  let estimatedIngredientCount = 0;

  for (const { meal } of unpriced) {
    const ingredients = ingredientsByMeal.get(meal.id) ?? [];
    if (ingredients.length === 0) continue;

    // gramsPurchased/gramsNeeded are persisted (not acted on here) so pantry
    // leftovers can be recorded later, once a Yes reply confirms the meal was
    // actually cooked — see recordMealCooked. Pricing the approved queue
    // isn't dozens of real shopping trips; cooking is.
    for (const ing of ingredients) {
      if (ing.skuPrice !== null) continue; // already priced from a prior run
      if (await priceLine(ing, matches.get(ing.genericName) ?? null, adapter)) {
        estimatedIngredientCount++;
      }
    }

    await recomputeMealCosts(meal.id, ingredients);
    pricedMealIds.push(meal.id);
  }

  return {
    pricedMealIds,
    estimatedIngredientCount,
    uniqueIngredientsRequested: requested,
    reusedFromCache: reused,
  };
}

/**
 * Rolls a meal's ingredient lines up into its two cost totals + tier.
 * Exported so a backfill can re-derive costs from stored pack data without
 * spending anything at the pricing API.
 */
export async function recomputeMealCosts(
  mealId: number,
  ingredients: (typeof mealIngredients.$inferSelect)[]
): Promise<void> {
  const firstShopTwoPerson = sum(ingredients.map((i) => numOrZero(i.skuPrice)));
  const marginalTwoPerson = sum(ingredients.map((i) => numOrZero(i.marginalPrice)));

  await db
    .update(meals)
    .set({
      // Packs don't shrink for one person, so the first shop costs the same.
      costFirstShopOnePerson: String(round2(firstShopTwoPerson)),
      costFirstShopTwoPerson: String(round2(firstShopTwoPerson)),
      // Half the food actually gets consumed, so marginal cost does halve.
      costMarginalOnePerson: String(round2(marginalTwoPerson / 2)),
      costMarginalTwoPerson: String(round2(marginalTwoPerson)),
      tier: tierForCost(round2(marginalTwoPerson)) ?? undefined,
    })
    .where(eq(meals.id, mealId));
}

function numOrZero(v: string | null): number {
  return v !== null ? Number(v) : 0;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
