/**
 * Pricing adapter interface. The recipe pipeline calls this to turn generic
 * ingredient names into priced SKUs. Swap NullPricingAdapter for a real
 * implementation once a licensed UK grocery pricing API is available — see
 * README.md "Wiring in real pricing" for the exact steps.
 *
 * Do NOT implement this by scraping a retailer's website or reverse-
 * engineering its internal (non-public) frontend API — see README for why.
 */
export interface GenericIngredient {
  name: string;
  quantity: string;
}

export interface PricedIngredient extends GenericIngredient {
  skuName: string | null;
  skuPrice: number | null; // GBP
  skuUnitSize: string | null;
  /** Total grams actually purchased (packs bought x pack size), when known. */
  gramsPurchased: number | null;
  /** Grams the recipe actually calls for, when parseable from `quantity`. */
  gramsNeeded: number | null;
}

export interface PricingAdapter {
  price(ingredients: GenericIngredient[]): Promise<PricedIngredient[]>;
}

/**
 * Default adapter: prices nothing. Every ingredient comes back with null
 * sku/price fields, so downstream tiering leaves the meal's cost and tier
 * as NULL ("unpriced") rather than fabricating numbers.
 */
export class NullPricingAdapter implements PricingAdapter {
  async price(ingredients: GenericIngredient[]): Promise<PricedIngredient[]> {
    return ingredients.map((ing) => ({
      ...ing,
      skuName: null,
      skuPrice: null,
      skuUnitSize: null,
      gramsPurchased: null,
      gramsNeeded: null,
    }));
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
