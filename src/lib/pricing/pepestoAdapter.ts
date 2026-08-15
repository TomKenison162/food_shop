import { GenericIngredient, PricedIngredient, PricingAdapter } from "./adapter";

/**
 * Real pricing via Pepesto (https://www.pepesto.com), a licensed grocery
 * data API — not a scraper we built. Costs real money per call: the
 * documented rate for /products is roughly €0.04/request regardless of
 * shopping-list length, confirmed against the live API on 2026-08-15.
 *
 * Quantity matching is best-effort: Pepesto returns the single best-matched
 * product per ingredient line (not exact-quantity packs), so we parse the
 * recipe's requested quantity into grams/pieces where we can and round up
 * to however many packs of the matched product are needed. Ingredients
 * whose units we can't parse (tbsp, tsp, ml, "to taste", ...) are priced as
 * a single pack of the matched product — an approximation, not exact.
 */
export class PepestoPricingAdapter implements PricingAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly supermarketDomain: string;

  constructor() {
    const apiKey = process.env.PEPESTO_API_KEY;
    if (!apiKey) {
      throw new Error("PEPESTO_API_KEY is not set.");
    }
    this.apiKey = apiKey;
    this.baseUrl = process.env.PEPESTO_BASE_URL || "https://s.pepesto.com/api";
    this.supermarketDomain = process.env.PEPESTO_SUPERMARKET_DOMAIN || "sainsburys.co.uk";
  }

  async price(ingredients: GenericIngredient[]): Promise<PricedIngredient[]> {
    if (ingredients.length === 0) return [];

    const shoppingList = ingredients.map((i) => `${i.quantity} ${i.name}`).join("\n");

    const res = await fetch(`${this.baseUrl}/products`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manual_shopping_list: shoppingList,
        supermarket_domain: this.supermarketDomain,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Pepesto /products failed (${res.status}): ${body}`);
    }

    const data: PepestoProductsResponse = await res.json();

    // Pepesto returns one entry per matched line, in the same order as the
    // input list, but match by item_name to be safe rather than assume order.
    return ingredients.map((ing) => {
      const match = data.items.find((item) => matchesIngredient(item.item_name, ing.name));
      const top = match?.products?.[0]?.product;
      if (!top) {
        return {
          ...ing,
          skuName: null,
          skuPrice: null,
          skuUnitSize: null,
          gramsPurchased: null,
          gramsNeeded: null,
        };
      }

      const requested = parseRequestedQuantity(ing.quantity);
      const packsNeeded = packsNeededFor(requested, top.quantity);
      const totalPence = top.price.price * packsNeeded;

      return {
        ...ing,
        skuName: top.product_name,
        skuPrice: Math.round(totalPence) / 100,
        skuUnitSize: describeQuantity(top.quantity, packsNeeded),
        gramsPurchased: top.quantity.grams ? top.quantity.grams * packsNeeded : null,
        gramsNeeded: requested.grams ?? null,
      };
    });
  }
}

interface PepestoProductsResponse {
  items: {
    item_name: string;
    products: {
      product: {
        product_name: string;
        quantity: { grams?: number; pieces?: number };
        price: { price: number };
      };
    }[];
  }[];
  currency?: string;
}

function matchesIngredient(itemName: string, ingredientName: string): boolean {
  const a = itemName.toLowerCase().trim();
  const b = ingredientName.toLowerCase().trim();
  return a === b || a.includes(b) || b.includes(a);
}

/** Best-effort parse of "400g", "1kg", "2 cloves", "3 pieces" into grams/pieces. */
function parseRequestedQuantity(qty: string): { grams?: number; pieces?: number } {
  const kg = qty.match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (kg) return { grams: parseFloat(kg[1]) * 1000 };

  const g = qty.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (g) return { grams: parseFloat(g[1]) };

  const pieces = qty.match(/(\d+(?:\.\d+)?)\s*(clove|cloves|piece|pieces|whole)/i);
  if (pieces) return { pieces: parseFloat(pieces[1]) };

  return {};
}

function packsNeededFor(
  requested: { grams?: number; pieces?: number },
  productQty: { grams?: number; pieces?: number }
): number {
  if (requested.grams && productQty.grams) {
    return Math.max(1, Math.ceil(requested.grams / productQty.grams));
  }
  if (requested.pieces && productQty.pieces) {
    return Math.max(1, Math.ceil(requested.pieces / productQty.pieces));
  }
  // Unparseable unit (tbsp, tsp, ml, "to taste", ...) — approximate as one pack.
  return 1;
}

function describeQuantity(productQty: { grams?: number; pieces?: number }, packs: number): string {
  if (productQty.grams) return `${packs} x ${productQty.grams}g pack`;
  if (productQty.pieces) return `${packs} x ${productQty.pieces}-piece pack`;
  return `${packs} pack(s)`;
}
