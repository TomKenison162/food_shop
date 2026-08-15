import { EMPTY_COST, MatchedProduct, PricingAdapter, QuantityCost } from "./adapter";
import { parseQuantityToGrams } from "./quantity";
import { isPlausibleProduct, matchesIngredient } from "./matching";

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

/** See the clamp in computeQuantityCost — guards against quantity misparses. */
const MAX_PACKS_PER_LINE = 8;

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
        // Take the first candidate that actually looks like the ingredient,
        // not just the first one returned — see matching.ts for why.
        const top = match?.products?.find((p) => isPlausibleProduct(p.product.product_name, name))
          ?.product;
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

  /** Pure local math — no API call. Turns a shared match into this dish's costs. */
  costForQuantity(
    match: MatchedProduct | null,
    requestedQuantity: string,
    ingredientName?: string
  ): QuantityCost {
    return computeQuantityCost(match, requestedQuantity, ingredientName);
  }
}

/**
 * Shared costing maths, exported so backfills and tests can reuse it
 * without constructing a live API client.
 */
export function computeQuantityCost(
  match: MatchedProduct | null,
  requestedQuantity: string,
  ingredientName?: string
): QuantityCost {
  if (!match) return { ...EMPTY_COST };

  const parsed = parseQuantityToGrams(requestedQuantity, ingredientName);
  const packGrams = match.packQuantity.grams ?? null;
  const packPrice = match.pricePerPackGBP;

  // Pieces-based pack (e.g. "1 garlic bulb") with a piece-counted recipe line.
  if (packGrams === null) {
    const packPieces = match.packQuantity.pieces ?? 1;
    const neededPieces = parsed.pieces ?? 1;
    const packs = Math.max(1, Math.ceil(neededPieces / packPieces));
    const fraction = Math.min(1, neededPieces / (packPieces * packs));
    return {
      skuName: match.skuName,
      firstShopPrice: round2(packPrice * packs),
      marginalPrice: round2(packPrice * packs * fraction),
      skuUnitSize: `${packs} x ${packPieces}-piece pack`,
      packPrice: round2(packPrice),
      packGrams: null,
      gramsPurchased: null,
      gramsNeeded: null,
    };
  }

  // Unparseable quantity against a weighed pack: assume one pack, and treat
  // the line as consuming a small share of it rather than the whole thing —
  // these are overwhelmingly staples ("a splash of oil", "seasoning").
  const gramsNeeded = parsed.grams ?? packGrams * 0.1;

  // Safety net against quantity-parse failures. A home recipe line needing
  // more than a handful of packs is nearly always a misparse rather than a
  // real requirement, and an unclamped one poisons the meal's total and the
  // weekly budget with it (a stray "2 bay leaves" once produced £88).
  const packs = Math.min(MAX_PACKS_PER_LINE, Math.max(1, Math.ceil(gramsNeeded / packGrams)));
  const gramsPurchased = packGrams * packs;
  const fraction = Math.min(1, gramsNeeded / gramsPurchased);

  return {
    skuName: match.skuName,
    firstShopPrice: round2(packPrice * packs),
    marginalPrice: round2(packPrice * packs * fraction),
    skuUnitSize: `${packs} x ${packGrams}g pack`,
    packPrice: round2(packPrice),
    packGrams,
    gramsPurchased,
    gramsNeeded: round1(gramsNeeded),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
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

