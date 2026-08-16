import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { meals, mealIngredients } from "../src/lib/db/schema";
import { cachedMatchesFor } from "../src/lib/pricing/priceCache";
import { computeQuantityCost } from "../src/lib/pricing/pepestoAdapter";
import { recomputeMealCosts } from "../src/lib/pricing/priceApproved";

/**
 * Repairs ingredient lines that fell back to a hand-written estimate.
 *
 * Estimates were terminal: a line with an estimate still has a sku_price, so
 * the pricing pipeline treated it as done and never asked about it again.
 * The result was 15 meals priced entirely from guesses while the very same
 * ingredients were correctly matched on other dishes (garlic had 23 real
 * matches and 7 estimates at once).
 *
 * Two passes, cheapest first:
 *  1. REUSE  - the name has a real SKU on another meal, so re-derive this
 *              line from that pack locally. No API call, no spend.
 *  2. CLEAR  - genuinely unknown names are nulled out so the pricing
 *              pipeline re-quotes them properly on its next run.
 *
 * Report-only by default. Pass --fix to apply.
 */
const FIX = process.argv.includes("--fix");

async function main() {
  const estimated = await db
    .select({ ing: mealIngredients, mealName: meals.name })
    .from(mealIngredients)
    .innerJoin(meals, eq(mealIngredients.mealId, meals.id))
    .where(eq(mealIngredients.isEstimated, true));

  if (estimated.length === 0) {
    console.log("No estimated lines. Nothing to do.");
    process.exit(0);
  }

  const names = [...new Set(estimated.map((r) => r.ing.genericName))];
  // trustEstimates:false is the whole point here - we are specifically
  // revisiting names a previous run gave up on.
  const { matches } = await cachedMatchesFor(names, { trustEstimates: false });

  const reusable = estimated.filter((r) => matches.has(r.ing.genericName));
  const unknown = estimated.filter((r) => !matches.has(r.ing.genericName));
  const unknownNames = [...new Set(unknown.map((r) => r.ing.genericName))];

  console.log(`${estimated.length} estimated lines across ${names.length} distinct ingredients.\n`);
  console.log(`=== ${reusable.length} fixable FREE from a match on another meal ===`);
  let saved = 0;
  for (const { ing, mealName } of reusable.slice(0, 25)) {
    const m = matches.get(ing.genericName)!;
    const c = computeQuantityCost(m, ing.quantity, ing.genericName);
    const was = Number(ing.skuPrice);
    if (c.firstShopPrice !== null) saved += was - c.firstShopPrice;
    console.log(
      `  £${was.toFixed(2)} -> £${(c.firstShopPrice ?? 0).toFixed(2)} | ${ing.genericName} (${ing.quantity}) -> ${m.skuName} | ${mealName}`
    );
  }
  if (reusable.length > 25) console.log(`  ... and ${reusable.length - 25} more`);

  console.log(`\n=== ${unknown.length} lines on ${unknownNames.length} names with no match anywhere ===`);
  console.log(`  ${unknownNames.join(", ")}`);
  console.log(`\nEstimate guesses replaced by real prices would move totals by roughly £${saved.toFixed(2)} on the sample above.`);

  if (!FIX) {
    console.log("\nReport only. Re-run with --fix to apply.");
    process.exit(0);
  }

  const touched = new Set<number>();

  for (const { ing } of reusable) {
    const m = matches.get(ing.genericName)!;
    const c = computeQuantityCost(m, ing.quantity, ing.genericName);
    if (c.firstShopPrice === null) continue;
    await db
      .update(mealIngredients)
      .set({
        skuName: c.skuName,
        skuPrice: String(c.firstShopPrice),
        marginalPrice: c.marginalPrice !== null ? String(c.marginalPrice) : null,
        skuUnitSize: c.skuUnitSize,
        packPrice: c.packPrice !== null ? String(c.packPrice) : null,
        packGrams: c.packGrams !== null ? String(c.packGrams) : null,
        gramsPurchased: c.gramsPurchased !== null ? String(c.gramsPurchased) : null,
        gramsNeeded: c.gramsNeeded !== null ? String(c.gramsNeeded) : null,
        isEstimated: false,
      })
      .where(eq(mealIngredients.id, ing.id));
    touched.add(ing.mealId);
  }

  for (const { ing } of unknown) {
    await db
      .update(mealIngredients)
      .set({
        skuName: null, skuPrice: null, marginalPrice: null, skuUnitSize: null,
        packPrice: null, packGrams: null, gramsPurchased: null, gramsNeeded: null,
        isEstimated: false,
      })
      .where(eq(mealIngredients.id, ing.id));
    touched.add(ing.mealId);
  }

  // A meal with a cleared line must lose its tier, or the pricing pipeline
  // skips it as already priced and the hole is never filled.
  for (const mealId of touched) {
    const lines = await db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, mealId) });
    if (lines.some((l) => l.skuPrice === null)) {
      await db.update(meals).set({ tier: null }).where(eq(meals.id, mealId));
    } else {
      await recomputeMealCosts(mealId, lines);
    }
  }

  console.log(`\nApplied. ${reusable.length} lines repaired free, ${unknown.length} cleared for re-quoting across ${touched.size} meals.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
