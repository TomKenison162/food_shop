import { and, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { mealIngredients } from "../db/schema";
import type { MatchedProduct } from "./adapter";

export interface CacheLookup {
  /** Names already resolved to a real SKU — reusable at zero API cost. */
  matches: Map<string, MatchedProduct>;
  /** Names the API has already failed to match; asking again costs money to fail again. */
  unmatchable: Set<string>;
}

/** "3 x 4-piece pack" -> 4. Written by computeQuantityCost, so the shape is ours. */
function piecesFromUnitSize(unitSize: string | null): number | null {
  const m = unitSize?.match(/(\d+)-piece/);
  return m ? Number(m[1]) : null;
}

/**
 * Looks up generic ingredient names that some *other* meal has already
 * priced, so they never go to the paid API twice.
 *
 * This is the cache that makes on-demand pricing affordable. Pepesto bills
 * per request, and the ingredients meals share are exactly the common ones —
 * garlic, onions, olive oil, chicken thighs. Once any meal has resolved
 * "garlic" to a SKU, every later meal reuses that pack price and re-derives
 * its own line cost locally from its own quantity (a dish needing 40g and one
 * needing 200g share a pack price but not a cost, so the stored per-line
 * total is deliberately NOT copied).
 *
 * Previously-estimated names are returned separately rather than as matches:
 * the API had no product for them last time, so they go straight back to an
 * estimate instead of burning a request to rediscover that.
 */
export async function cachedMatchesFor(names: string[]): Promise<CacheLookup> {
  const matches = new Map<string, MatchedProduct>();
  const unmatchable = new Set<string>();
  if (names.length === 0) return { matches, unmatchable };

  const rows = await db
    .select()
    .from(mealIngredients)
    .where(and(inArray(mealIngredients.genericName, names), isNotNull(mealIngredients.skuPrice)));

  for (const row of rows) {
    if (row.isEstimated) {
      unmatchable.add(row.genericName);
      continue;
    }
    // A usable match needs a pack price; without one there's nothing to
    // re-derive another meal's quantity from.
    if (row.skuName === null || row.packPrice === null) continue;
    if (matches.has(row.genericName)) continue;

    const grams = row.packGrams !== null ? Number(row.packGrams) : null;
    const pieces = grams === null ? piecesFromUnitSize(row.skuUnitSize) ?? 1 : undefined;

    matches.set(row.genericName, {
      skuName: row.skuName,
      pricePerPackGBP: Number(row.packPrice),
      packQuantity: grams !== null ? { grams } : { pieces },
    });
  }

  // A real match anywhere beats an estimate somewhere else.
  for (const name of matches.keys()) unmatchable.delete(name);

  return { matches, unmatchable };
}
