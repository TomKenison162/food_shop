/**
 * Pricing adapter interface. Split into two concerns so ingredients shared
 * across dishes (garlic, onion, chicken thighs, ...) only get looked up
 * once — not once per dish — minimizing paid API calls:
 *
 *  1. matchProducts(names): the expensive part (a real API call). Takes
 *     UNIQUE generic ingredient names with no quantity attached, and
 *     returns the best-matched SKU + price-per-pack + pack size for each.
 *     Callers should dedupe names across the *entire* approved queue
 *     before calling this once (or a few batched times), not per meal.
 *  2. costForQuantity(match, requestedQuantity): pure local math — turns a
 *     shared match + a specific dish's requested quantity ("400g") into
 *     that dish's actual cost (packs needed x price-per-pack). No API call.
 *
 * Swap NullPricingAdapter for a real implementation once a licensed UK
 * grocery pricing API is available — see README.md "Wiring in real pricing".
 *
 * Do NOT implement this by scraping a retailer's website or reverse-
 * engineering its internal (non-public) frontend API — see README for why.
 */
export interface MatchedProduct {
  skuName: string;
  pricePerPackGBP: number;
  packQuantity: { grams?: number; pieces?: number };
}

export interface QuantityCost {
  skuName: string | null;
  skuPrice: number | null; // GBP, for the requested quantity (may span multiple packs)
  skuUnitSize: string | null;
  gramsPurchased: number | null;
  gramsNeeded: number | null;
}

export interface PricingAdapter {
  matchProducts(names: string[]): Promise<Map<string, MatchedProduct | null>>;
  costForQuantity(match: MatchedProduct | null, requestedQuantity: string): QuantityCost;
}

/** Default adapter: matches nothing, so downstream tiering leaves meals unpriced ("NULL"). */
export class NullPricingAdapter implements PricingAdapter {
  async matchProducts(names: string[]): Promise<Map<string, MatchedProduct | null>> {
    return new Map(names.map((n) => [n, null]));
  }

  costForQuantity(): QuantityCost {
    return { skuName: null, skuPrice: null, skuUnitSize: null, gramsPurchased: null, gramsNeeded: null };
  }
}

export function getPricingAdapter(): PricingAdapter {
  if (process.env.PEPESTO_API_KEY) {
    // Deferred import: keeps NullPricingAdapter usable with zero config,
    // and avoids constructing PepestoPricingAdapter (which throws without
    // a key) when no key is set.
    const { PepestoPricingAdapter } = require("./pepestoAdapter") as typeof import("./pepestoAdapter");
    return new PepestoPricingAdapter();
  }
  return new NullPricingAdapter();
}
