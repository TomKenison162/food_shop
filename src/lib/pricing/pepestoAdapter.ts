import {
  MatchedProduct,
  PricingAdapter,
  QuantityCost,
} from "./adapter";

/**
 * Real pricing via Pepesto (https://www.pepesto.com), a licensed grocery
 * data API — not a scraper we built. The documented rate for /products is
 * ~€0.04 PER REQUEST (confirmed against the live API on 2026-08-15: a
 * 3-item request charged 4 eurocents) — not per item — which is exactly
 * why matching is batched across the whole approved queue's unique
 * ingredient names rather than called once per dish.
 *
 * Batch size is deliberately small: empirically, a 40-name batch came back
 * with ~16% of lines missing a match (including "chicken thighs", which
 * matches fine alone) — a 3-5 name request matched everything reliably.
 * Pepesto has no documented per-request item cap; this is a conservative
 * value chosen from that observation, not a stated limit.
 */
const MAX_NAMES_PER_REQUEST = 8;

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

  /**
   * Matches each unique generic ingredient NAME (no quantity) to its best
   * SKU, batching up to MAX_NAMES_PER_REQUEST names per call. Callers
   * should pass the deduped set of ingredient names across the whole
   * approved queue, not per-dish — that's the whole cost saving.
   */
  async matchProducts(names: string[]): Promise<Map<string, MatchedProduct | null>> {
    const result = new Map<string, MatchedProduct | null>();
    if (names.length === 0) return result;

    const chunks: string[][] = [];
    for (let i = 0; i < names.length; i += MAX_NAMES_PER_REQUEST) {
      chunks.push(names.slice(i, i + MAX_NAMES_PER_REQUEST));
    }

    for (const chunk of chunks) {
      const data = await this.fetchProducts(chunk);
      for (const name of chunk) {
        const match = data.items.find((item) => matchesIngredient(item.item_name, name));
        const top = match?.products?.[0]?.product;
        result.set(
          name,
          top
            ? { skuName: top.product_name, pricePerPackGBP: top.price.price / 100, packQuantity: top.quantity }
            : null
        );
      }
    }

    return result;
  }

  private async fetchProducts(names: string[]): Promise<PepestoProductsResponse> {
    const shoppingList = names.join("\n");

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

    return res.json();
  }

  /** Pure local math — no API call. Turns a shared match into this dish's actual cost. */
  costForQuantity(match: MatchedProduct | null, requestedQuantity: string): QuantityCost {
    if (!match) {
      return { skuName: null, skuPrice: null, skuUnitSize: null, gramsPurchased: null, gramsNeeded: null };
    }

    const requested = parseRequestedQuantity(requestedQuantity);
    const packsNeeded = packsNeededFor(requested, match.packQuantity);
    const totalCost = match.pricePerPackGBP * packsNeeded;

    return {
      skuName: match.skuName,
      skuPrice: Math.round(totalCost * 100) / 100,
      skuUnitSize: describeQuantity(match.packQuantity, packsNeeded),
      gramsPurchased: match.packQuantity.grams ? match.packQuantity.grams * packsNeeded : null,
      gramsNeeded: requested.grams ?? null,
    };
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
