import { and, eq, gt, gte, inArray, lt, or, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { pantryItems, mealIngredients } from "../db/schema";
import { parseQuantityToGrams } from "../pricing/quantity";
import { shelfLifeDays } from "./shelfLife";
import { addDaysToDateString, londonDateString } from "../date";

const MIN_LEFTOVER_GRAMS = 20; // ignore trivial scraps

/** Only stock that hasn't passed its expiry date counts as available. */
function notExpired(today: string) {
  return or(isNull(pantryItems.expiresOn), gte(pantryItems.expiresOn, today));
}

/**
 * Records leftover stock for a meal actually cooked — e.g. a recipe needs
 * 400g chicken thighs but the matched pack was 500g: 100g leftover. Reads
 * gramsPurchased/gramsNeeded persisted on mealIngredients at pricing time.
 *
 * Only ever reached via recordMealCooked, i.e. after a "Yes" reply. It is
 * deliberately NOT called when a meal is merely *suggested*: an earlier
 * version ran this at plan time, so every declined and superseded suggestion
 * stocked the pantry too. Since nearly every dish lists salt, pepper, oil and
 * garlic, those entries were topped up (and their expiry reset) on each
 * suggestion — one real pantry had accumulated ~1.5kg of "salt and pepper"
 * from packs that were never bought.
 *
 * Each entry gets an expiry from its ingredient's shelf life, and topping up
 * an existing entry resets the clock (you just opened a fresh pack).
 */
export async function recordPurchaseLeftoversForMeal(mealId: number): Promise<void> {
  const ingredients = await db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, mealId) });
  const today = londonDateString();

  for (const ing of ingredients) {
    if (ing.gramsPurchased === null || ing.gramsNeeded === null) continue;
    const leftover = Number(ing.gramsPurchased) - Number(ing.gramsNeeded);
    if (leftover < MIN_LEFTOVER_GRAMS) continue;

    const expiresOn = addDaysToDateString(today, shelfLifeDays(ing.genericName));
    const existing = await db.query.pantryItems.findFirst({
      where: eq(pantryItems.genericName, ing.genericName),
    });

    if (existing) {
      // If the old stock had already expired, this is a fresh pack, not a top-up.
      const stale = existing.expiresOn !== null && existing.expiresOn < today;
      const carried = stale ? 0 : Number(existing.gramsRemaining);
      await db
        .update(pantryItems)
        .set({
          gramsRemaining: String(carried + leftover),
          sourceMealId: mealId,
          updatedAt: new Date(),
          expiresOn,
        })
        .where(eq(pantryItems.id, existing.id));
    } else {
      await db.insert(pantryItems).values({
        genericName: ing.genericName,
        gramsRemaining: String(leftover),
        sourceMealId: mealId,
        expiresOn,
      });
    }
  }
}

/**
 * Deducts pantry stock consumed by a meal actually cooked, so leftovers run
 * down as they get used up rather than being counted forever. Deducts the
 * amount the recipe actually calls for (from the stored gramsNeeded, else
 * parsed from the quantity string) — a flat per-item guess would drain a jar
 * of spices as fast as a pack of chicken.
 */
export async function consumePantryForMeal(mealId: number): Promise<void> {
  const ingredients = await db.query.mealIngredients.findMany({
    where: eq(mealIngredients.mealId, mealId),
  });

  for (const ing of ingredients) {
    const existing = await db.query.pantryItems.findFirst({
      where: eq(pantryItems.genericName, ing.genericName),
    });
    if (!existing) continue;

    const used =
      ing.gramsNeeded !== null
        ? Number(ing.gramsNeeded)
        : parseQuantityToGrams(ing.quantity, ing.genericName).grams ?? 0;

    const remaining = Math.max(0, Number(existing.gramsRemaining) - used);
    await db
      .update(pantryItems)
      .set({ gramsRemaining: String(remaining), updatedAt: new Date() })
      .where(eq(pantryItems.id, existing.id));
  }
}

/**
 * The pantry effect of actually cooking a meal: the packs you had to buy
 * leave leftovers, and the meal eats into whatever stock you already had.
 *
 * Called from the "Yes" reply only. Confirming you cooked something is the
 * one moment the app knows real food changed hands — a suggestion you never
 * answered, or declined, tells us nothing was bought.
 *
 * Order matters: leftovers are banked before consumption, so a meal that
 * both opens a new pack and draws on existing stock nets out correctly.
 */
export async function recordMealCooked(mealId: number): Promise<void> {
  await recordPurchaseLeftoversForMeal(mealId);
  await consumePantryForMeal(mealId);
}

/** Clears out expired and empty entries. Safe to call often. */
export async function purgeStalePantryItems(today = londonDateString()): Promise<number> {
  const removed = await db
    .delete(pantryItems)
    .where(or(lt(pantryItems.expiresOn, today), lt(pantryItems.gramsRemaining, "1")))
    .returning({ id: pantryItems.id });
  return removed.length;
}

export interface PantrySummaryItem {
  genericName: string;
  gramsRemaining: number;
  /** Rough "how many more portions" estimate, assuming ~150g protein/portion. */
  estimatedPortionsRemaining: number;
  expiresOn: string | null;
  /** Days until expiry; negative would mean expired, but expired rows are filtered out. */
  daysLeft: number | null;
}

export async function getPantrySummary(today = londonDateString()): Promise<PantrySummaryItem[]> {
  const rows = await db
    .select()
    .from(pantryItems)
    .where(and(gt(pantryItems.gramsRemaining, "0"), notExpired(today)));

  return rows.map((r) => ({
    genericName: r.genericName,
    gramsRemaining: Number(r.gramsRemaining),
    estimatedPortionsRemaining: Math.floor(Number(r.gramsRemaining) / 150),
    expiresOn: r.expiresOn,
    daysLeft:
      r.expiresOn !== null
        ? Math.round((Date.parse(r.expiresOn) - Date.parse(today)) / (1000 * 60 * 60 * 24))
        : null,
  }));
}

/** Stock is "expiring" once it's this close to its date. */
export const EXPIRING_SOON_DAYS = 3;

/**
 * For each meal, the pantry stock it would use that is about to expire, and
 * the names involved.
 *
 * One query for every meal rather than one per meal: this runs inside the
 * daily job, which already has real work to do under a timeout.
 */
export async function expiringOverlapByMeal(
  today = londonDateString()
): Promise<Map<number, { grams: number; names: string[] }>> {
  const cutoff = addDaysToDateString(today, EXPIRING_SOON_DAYS);
  const stock = await db
    .select()
    .from(pantryItems)
    .where(and(gt(pantryItems.gramsRemaining, "0"), notExpired(today)));

  const soon = stock.filter((s) => s.expiresOn !== null && s.expiresOn <= cutoff);
  const out = new Map<number, { grams: number; names: string[] }>();
  if (soon.length === 0) return out;

  const byName = new Map(soon.map((s) => [s.genericName, Number(s.gramsRemaining)]));
  const lines = await db
    .select({ mealId: mealIngredients.mealId, genericName: mealIngredients.genericName })
    .from(mealIngredients)
    .where(inArray(mealIngredients.genericName, [...byName.keys()]));

  for (const line of lines) {
    const grams = byName.get(line.genericName);
    if (grams === undefined) continue;
    const entry = out.get(line.mealId) ?? { grams: 0, names: [] };
    if (!entry.names.includes(line.genericName)) {
      entry.names.push(line.genericName);
      entry.grams += grams;
    }
    out.set(line.mealId, entry);
  }
  return out;
}

/**
 * How many grams of unexpired pantry stock a candidate meal would use up,
 * matched by generic ingredient name. Used to bias meal selection toward
 * using up what was already bought instead of buying something new.
 */
export async function pantryOverlapGrams(mealId: number, today = londonDateString()): Promise<number> {
  const ingredients = await db.query.mealIngredients.findMany({
    where: eq(mealIngredients.mealId, mealId),
  });
  if (ingredients.length === 0) return 0;

  const names = ingredients.map((i) => i.genericName);
  const rows = await db
    .select()
    .from(pantryItems)
    .where(
      and(inArray(pantryItems.genericName, names), gt(pantryItems.gramsRemaining, "0"), notExpired(today))
    );

  return rows.reduce((sum, r) => sum + Number(r.gramsRemaining), 0);
}
