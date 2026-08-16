import { EMPTY_COST, MatchedProduct, PricingAdapter, QuantityCost } from "./adapter";
import { parseQuantityToGrams } from "./quantity";
import { isPlausibleProduct, matchesIngredient, scoreProductMatch } from "./matching";

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

/** Transient 200-with-garbage responses are common enough to need retries. */
const FETCH_ATTEMPTS = 3;

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

    const missing: string[] = [];

    for (const chunk of chunks) {
      const data = await this.fetchProducts(chunk);
      const items = data.items ?? [];
      for (const name of chunk) {
        const item = items.find((i) => matchesIngredient(i.item_name, name));
        if (!item) {
          // The API answered, but said nothing at all about this name. That
          // is not the same as "no product exists" — batches silently drop
          // names, which is how whole meals ended up priced entirely from
          // guesses. Retry these one at a time before giving up on them.
          missing.push(name);
          continue;
        }
        const top = pickBestProduct(item.products ?? [], name);
        result.set(
          name,
          top
            ? { skuName: top.product_name, pricePerPackGBP: top.price.price / 100, packQuantity: top.quantity }
            : null
        );
      }
    }

    for (const name of missing) {
      const data = await this.fetchProducts([name]);
      const item = (data.items ?? []).find((i) => matchesIngredient(i.item_name, name));
      const top = item ? pickBestProduct(item.products ?? [], name) : null;
      result.set(
        name,
        top
          ? { skuName: top.product_name, pricePerPackGBP: top.price.price / 100, packQuantity: top.quantity }
          : null
      );
    }

    return result;
  }

  /**
   * One /products call, retried on transient failure.
   *
   * The API intermittently answers 200 with a non-JSON body (an internal
   * path fragment rather than a payload). Left unhandled that threw
   * mid-pipeline and abandoned a run with lines already cleared, so a single
   * blip could leave dozens of meals unpriced. Retried with backoff instead;
   * a genuine, repeated failure still throws rather than being swallowed,
   * because silently returning "no match" would turn an outage into a
   * shopping list full of guesses.
   */
  private async fetchProducts(names: string[]): Promise<PepestoProductsResponse> {
    const shoppingList = names.join("\n");
    let lastError = "";

    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/products`, {
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
      } catch (err) {
        lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }

      const body = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
        // 4xx other than rate limiting won't fix itself.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        continue;
      }

      try {
        return JSON.parse(body) as PepestoProductsResponse;
      } catch {
        lastError = `200 but body was not JSON: ${body.slice(0, 120)}`;
      }
    }

    throw new Error(`Pepesto /products failed after ${FETCH_ATTEMPTS} attempts (${lastError})`);
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
 * How much dearer than the cheapest plausible option a better-named match is
 * allowed to be. Name quality should win ties, but not at any price: without
 * a ceiling, "beef sirloin" happily took a £8.00 organic pack over a £5.00
 * standard one for a wording difference.
 */
const MAX_PRICE_MULTIPLE_OVER_CHEAPEST = 1.6;

interface ProductCandidate {
  product: { product_name: string; price: { price: number }; quantity: { grams?: number; pieces?: number } };
}

/**
 * Chooses among the plausible products for an ingredient.
 *
 * Previously this took the first plausible candidate the API returned, which
 * is the single biggest source of over-pricing in this pipeline: ordering is
 * the API's business, not a judgement about value, so premium and prepared
 * lines won constantly. Now every candidate is checked for plausibility,
 * ranked by how well it answers the ingredient, and then held to a price
 * ceiling relative to the cheapest plausible option.
 */
export function pickBestProduct<T extends ProductCandidate>(
  candidates: T[],
  ingredientName: string
): T["product"] | null {
  const plausible = candidates.filter((c) => isPlausibleProduct(c.product.product_name, ingredientName));
  if (plausible.length === 0) return null;

  const cheapest = Math.min(...plausible.map((c) => c.product.price.price));
  const ceiling = cheapest * MAX_PRICE_MULTIPLE_OVER_CHEAPEST;

  const affordable = plausible.filter((c) => c.product.price.price <= ceiling);
  const pool = affordable.length > 0 ? affordable : plausible;

  let best = pool[0];
  let bestScore = scoreProductMatch(best.product.product_name, ingredientName);
  for (const c of pool.slice(1)) {
    const score = scoreProductMatch(c.product.product_name, ingredientName);
    // Ties go to the cheaper product rather than to whatever came first.
    if (score > bestScore || (score === bestScore && c.product.price.price < best.product.price.price)) {
      best = c;
      bestScore = score;
    }
  }
  return best.product;
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
  /** Absent on some responses, so never dereference it directly. */
  items?: {
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

