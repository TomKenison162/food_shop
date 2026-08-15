import "dotenv/config";
import postgres from "postgres";
import { parseQuantityToGrams } from "../src/lib/pricing/quantity";
import { tierForCost } from "../src/lib/tiering";

/**
 * One-off, idempotent upgrade for a database created BEFORE migrations
 * existed (i.e. the local dev DB, built with `drizzle-kit push`). It adds
 * the new columns, then backfills the split cost model from data already
 * stored — no pricing-API calls.
 *
 * A fresh database (production) does not need this: drizzle/0000 creates
 * the current schema directly. Safe to re-run.
 */
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  console.log("1. Adding columns…");
  await sql`ALTER TABLE meals ADD COLUMN IF NOT EXISTS cost_first_shop_one_person numeric(8,2)`;
  await sql`ALTER TABLE meals ADD COLUMN IF NOT EXISTS cost_first_shop_two_person numeric(8,2)`;
  await sql`ALTER TABLE meals ADD COLUMN IF NOT EXISTS cost_marginal_one_person numeric(8,2)`;
  await sql`ALTER TABLE meals ADD COLUMN IF NOT EXISTS cost_marginal_two_person numeric(8,2)`;
  await sql`ALTER TABLE meals ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone`;

  await sql`ALTER TABLE meal_ingredients ADD COLUMN IF NOT EXISTS marginal_price numeric(8,2)`;
  await sql`ALTER TABLE meal_ingredients ADD COLUMN IF NOT EXISTS pack_price numeric(8,2)`;
  await sql`ALTER TABLE meal_ingredients ADD COLUMN IF NOT EXISTS pack_grams numeric(8,1)`;

  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS day_of_week integer`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS is_weekend boolean`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS temperature_c numeric(5,1)`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS pantry_overlap_grams numeric(8,1)`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS days_since_last_served integer`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS protein_days_since_last_served integer`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS ingredients_count integer`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS accepted boolean`;
  await sql`ALTER TABLE meal_history ADD COLUMN IF NOT EXISTS responded_at timestamp with time zone`;

  console.log("2. Migrating any daily_feedback labels onto meal_history…");
  const hasDailyFeedback = await sql`
    select 1 from information_schema.tables where table_schema='public' and table_name='daily_feedback'`;
  if (hasDailyFeedback.length > 0) {
    await sql`
      UPDATE meal_history mh
      SET accepted = df.accepted, responded_at = df.created_at
      FROM daily_feedback df
      WHERE df.meal_id = mh.meal_id AND df.date = mh.served_date AND mh.accepted IS NULL`;
    await sql`DROP TABLE daily_feedback`;
    console.log("   migrated and dropped daily_feedback");
  }

  console.log("3. Backfilling pack price/size from stored sku_unit_size…");
  const ingredients = await sql<
    { id: number; quantity: string; sku_price: string | null; sku_unit_size: string | null; is_estimated: boolean }[]
  >`SELECT id, quantity, sku_price, sku_unit_size, is_estimated FROM meal_ingredients WHERE sku_price IS NOT NULL`;

  let backfilled = 0;
  for (const ing of ingredients) {
    const lineTotal = Number(ing.sku_price);
    // sku_unit_size looks like "2 x 500g pack" for real matches; estimates
    // carry a sentinel string and have no pack structure to recover.
    const m = ing.sku_unit_size?.match(/^(\d+)\s*x\s*(\d+(?:\.\d+)?)g/);
    const packs = m ? Number(m[1]) : 1;
    const packGrams = m ? Number(m[2]) : ing.is_estimated ? 400 : null;
    const packPrice = lineTotal / packs;

    const gramsNeeded = parseQuantityToGrams(ing.quantity).grams ?? (packGrams !== null ? packGrams * 0.1 : null);
    const gramsPurchased = packGrams !== null ? packGrams * packs : null;

    const marginal =
      gramsNeeded !== null && gramsPurchased !== null
        ? Math.round(lineTotal * Math.min(1, gramsNeeded / gramsPurchased) * 100) / 100
        : lineTotal;

    await sql`
      UPDATE meal_ingredients SET
        pack_price = ${packPrice.toFixed(2)},
        pack_grams = ${packGrams !== null ? packGrams.toFixed(1) : null},
        grams_needed = ${gramsNeeded !== null ? gramsNeeded.toFixed(1) : null},
        grams_purchased = ${gramsPurchased !== null ? gramsPurchased.toFixed(1) : null},
        marginal_price = ${marginal.toFixed(2)}
      WHERE id = ${ing.id}`;
    backfilled++;
  }
  console.log(`   backfilled ${backfilled} ingredient lines`);

  console.log("4. Recomputing meal totals and tiers…");
  const totals = await sql<{ meal_id: number; first_shop: string; marginal: string }[]>`
    SELECT meal_id,
           COALESCE(SUM(sku_price), 0)::text      AS first_shop,
           COALESCE(SUM(marginal_price), 0)::text AS marginal
    FROM meal_ingredients
    WHERE sku_price IS NOT NULL
    GROUP BY meal_id`;

  let repriced = 0;
  for (const t of totals) {
    const firstShop = Math.round(Number(t.first_shop) * 100) / 100;
    const marginal = Math.round(Number(t.marginal) * 100) / 100;
    const tier = tierForCost(marginal);
    await sql`
      UPDATE meals SET
        cost_first_shop_one_person = ${firstShop.toFixed(2)},
        cost_first_shop_two_person = ${firstShop.toFixed(2)},
        cost_marginal_one_person   = ${(Math.round((marginal / 2) * 100) / 100).toFixed(2)},
        cost_marginal_two_person   = ${marginal.toFixed(2)},
        tier = ${tier}
      WHERE id = ${t.meal_id}`;
    repriced++;
  }
  console.log(`   recomputed ${repriced} meals`);

  console.log("5. Dropping superseded cost columns…");
  await sql`ALTER TABLE meals DROP COLUMN IF EXISTS cost_one_person`;
  await sql`ALTER TABLE meals DROP COLUMN IF EXISTS cost_two_person`;

  await sql.end();
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
