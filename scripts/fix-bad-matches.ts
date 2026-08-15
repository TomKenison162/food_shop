import "dotenv/config";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { mealIngredients } from "../src/lib/db/schema";
import { isPlausibleProduct } from "../src/lib/pricing/matching";
import { estimateIngredientPriceGBP } from "../src/lib/pricing/estimates";
import { parseQuantityToGrams } from "../src/lib/pricing/quantity";

/**
 * Finds already-stored ingredient lines whose matched SKU doesn't plausibly
 * correspond to the ingredient, and replaces them with flagged estimates.
 *
 * Costs nothing: it re-judges data already in the database rather than
 * re-querying the pricing API. A wrong match ("scallops" priced as a whole
 * chicken) is worse than an admitted estimate, because it looks authoritative
 * in the shopping list and silently distorts the weekly budget.
 *
 * Pass --apply to write changes; runs as a dry run otherwise.
 */
const APPLY = process.argv.includes("--apply");
const ASSUMED_PACK_GRAMS = 400;

async function main() {
  const rows = await db.select().from(mealIngredients).where(isNotNull(mealIngredients.skuName));

  const bad = rows.filter((r) => r.skuName && !isPlausibleProduct(r.skuName, r.genericName));

  console.log(`${bad.length} implausible match(es) out of ${rows.length} priced lines\n`);
  for (const r of bad.slice(0, 25)) {
    console.log(`  ${r.genericName.padEnd(26)} -> ${r.skuName}`);
  }
  if (bad.length > 25) console.log(`  … and ${bad.length - 25} more`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to convert these to flagged estimates.");
    process.exit(0);
  }

  for (const r of bad) {
    const packPrice = estimateIngredientPriceGBP(r.genericName);
    const gramsNeeded =
      parseQuantityToGrams(r.quantity, r.genericName).grams ?? ASSUMED_PACK_GRAMS * 0.1;
    const fraction = Math.min(1, gramsNeeded / ASSUMED_PACK_GRAMS);

    await db
      .update(mealIngredients)
      .set({
        skuName: null,
        skuPrice: String(packPrice),
        marginalPrice: String(Math.round(packPrice * fraction * 100) / 100),
        skuUnitSize: "estimated, not from Sainsbury's",
        packPrice: String(packPrice),
        packGrams: String(ASSUMED_PACK_GRAMS),
        gramsNeeded: String(Math.round(gramsNeeded * 10) / 10),
        gramsPurchased: String(ASSUMED_PACK_GRAMS),
        isEstimated: true,
      })
      .where(eq(mealIngredients.id, r.id));
  }

  console.log(`\nConverted ${bad.length} line(s) to flagged estimates.`);
  console.log("Run `npm run db:recompute` next to refresh meal totals.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
