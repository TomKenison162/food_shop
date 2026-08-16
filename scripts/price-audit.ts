import "dotenv/config";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { meals, mealIngredients } from "../src/lib/db/schema";
import { isPlausibleProduct } from "../src/lib/pricing/matching";
import { computeQuantityCost } from "../src/lib/pricing/pepestoAdapter";
import { recomputeMealCosts } from "../src/lib/pricing/priceApproved";

/**
 * Audits every priced ingredient line against the current matching and
 * quantity rules, and splits what it finds into two kinds of problem:
 *
 *  - BAD MATCH: the stored SKU is no longer plausible for the ingredient
 *    (limes priced as lime leaves, red wine as Sauvignon Blanc, sirloin as
 *    diced stewing beef). Only a fresh API lookup can fix these, so --fix
 *    clears the line and leaves it for the pricing pipeline to redo.
 *
 *  - BAD QUANTITY: the SKU is right but the amount was wrong, almost always
 *    a piece-weight that fell through to the generic default (four spring
 *    onions costed as 600g). These are recomputed locally from the stored
 *    pack price and pack size — no API call, no spend.
 *
 * Report-only by default. Pass --fix to apply.
 */
const FIX = process.argv.includes("--fix");
/** Only report a quantity change if it actually moves the money. */
const MATERIAL_GBP = 0.5;

async function main() {
  const rows = await db
    .select({ ing: mealIngredients, mealName: meals.name })
    .from(mealIngredients)
    .innerJoin(meals, eq(mealIngredients.mealId, meals.id))
    .where(isNotNull(mealIngredients.skuPrice));

  const badMatches: typeof rows = [];
  const badQuantities: { row: (typeof rows)[number]; was: number; now: number }[] = [];

  for (const row of rows) {
    const { ing } = row;
    if (ing.isEstimated) continue;

    if (ing.skuName !== null && !isPlausibleProduct(ing.skuName, ing.genericName)) {
      badMatches.push(row);
      continue;
    }

    // Re-derive the line from the pack data we already hold. Any difference
    // is purely down to the quantity rules having changed.
    if (ing.packPrice === null) continue;
    const grams = ing.packGrams !== null ? Number(ing.packGrams) : null;
    const recomputed = computeQuantityCost(
      {
        skuName: ing.skuName ?? ing.genericName,
        pricePerPackGBP: Number(ing.packPrice),
        packQuantity: grams !== null ? { grams } : { pieces: 1 },
      },
      ing.quantity,
      ing.genericName
    );
    const was = Number(ing.skuPrice);
    const now = recomputed.firstShopPrice;
    if (now !== null && Math.abs(now - was) >= MATERIAL_GBP) {
      badQuantities.push({ row, was, now });
    }
  }

  console.log(`Audited ${rows.length} priced ingredient lines.\n`);

  console.log(`=== ${badMatches.length} IMPLAUSIBLE MATCHES (need a fresh API lookup) ===`);
  let matchWaste = 0;
  for (const { ing, mealName } of badMatches.sort((a, b) => Number(b.ing.skuPrice) - Number(a.ing.skuPrice))) {
    matchWaste += Number(ing.skuPrice);
    console.log(`  £${String(ing.skuPrice).padStart(6)} | ${ing.genericName} (${ing.quantity}) -> ${ing.skuName} | ${mealName}`);
  }

  console.log(`\n=== ${badQuantities.length} WRONG QUANTITIES (fixable locally, free) ===`);
  let qtySaving = 0;
  for (const { row, was, now } of badQuantities.sort((a, b) => b.was - b.now - (a.was - a.now))) {
    qtySaving += was - now;
    console.log(`  £${was.toFixed(2)} -> £${now.toFixed(2)} | ${row.ing.genericName} (${row.ing.quantity}) -> ${row.ing.skuName} | ${row.mealName}`);
  }

  console.log(`\nOverstated by £${qtySaving.toFixed(2)} on quantities; £${matchWaste.toFixed(2)} sits on matches that need redoing.`);

  if (!FIX) {
    console.log("\nReport only. Re-run with --fix to apply.");
    process.exit(0);
  }

  const touchedMeals = new Set<number>();

  for (const { ing } of badMatches) {
    // Null the line out entirely so priceApprovedMeals treats it as unpriced
    // and asks the API again — now under the corrected matching rules.
    await db
      .update(mealIngredients)
      .set({
        skuName: null, skuPrice: null, marginalPrice: null, skuUnitSize: null,
        packPrice: null, packGrams: null, gramsPurchased: null, gramsNeeded: null,
        isEstimated: false,
      })
      .where(eq(mealIngredients.id, ing.id));
    touchedMeals.add(ing.mealId);
  }

  for (const { row } of badQuantities) {
    const { ing } = row;
    const grams = ing.packGrams !== null ? Number(ing.packGrams) : null;
    const c = computeQuantityCost(
      {
        skuName: ing.skuName ?? ing.genericName,
        pricePerPackGBP: Number(ing.packPrice),
        packQuantity: grams !== null ? { grams } : { pieces: 1 },
      },
      ing.quantity,
      ing.genericName
    );
    await db
      .update(mealIngredients)
      .set({
        skuPrice: c.firstShopPrice !== null ? String(c.firstShopPrice) : null,
        marginalPrice: c.marginalPrice !== null ? String(c.marginalPrice) : null,
        skuUnitSize: c.skuUnitSize,
        gramsPurchased: c.gramsPurchased !== null ? String(c.gramsPurchased) : null,
        gramsNeeded: c.gramsNeeded !== null ? String(c.gramsNeeded) : null,
      })
      .where(eq(mealIngredients.id, ing.id));
    touchedMeals.add(ing.mealId);
  }

  // Any meal with a cleared line must lose its tier too, or the pricing
  // pipeline will skip it as "already priced" and the hole never gets filled.
  for (const mealId of touchedMeals) {
    const lines = await db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, mealId) });
    if (lines.some((l) => l.skuPrice === null)) {
      await db.update(meals).set({ tier: null }).where(eq(meals.id, mealId));
    } else {
      await recomputeMealCosts(mealId, lines);
    }
  }

  console.log(`\nApplied. ${touchedMeals.size} meals updated; cleared lines will be re-priced on the next pricing run.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
