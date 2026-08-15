import "dotenv/config";
import { writeFileSync } from "fs";
import postgres from "postgres";

/**
 * Dumps everything worth keeping from one database to a JSON file, so a
 * move to production doesn't mean re-swiping 51 meals or re-paying the
 * pricing API for matches that are already resolved.
 *
 * Usage:
 *   npm run db:export                       # from the DATABASE_URL in .env
 *   DATABASE_URL="postgres://…" npm run db:export
 *
 * Then import into the target with `npm run db:import`.
 */
const OUT_FILE = process.argv[2] ?? "food-shop-export.json";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  const [meals, mealIngredients, approvedQueue, mealHistory, pantryItems, userSettings] =
    await Promise.all([
      sql`SELECT * FROM meals ORDER BY id`,
      sql`SELECT * FROM meal_ingredients ORDER BY id`,
      sql`SELECT * FROM approved_queue ORDER BY id`,
      sql`SELECT * FROM meal_history ORDER BY id`,
      sql`SELECT * FROM pantry_items ORDER BY id`,
      sql`SELECT * FROM user_settings ORDER BY id`,
    ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    // The trained ML model is deliberately NOT exported: it's cheap to
    // rebuild from meal_history (which is exported) and the serialized
    // blob is tied to the exact feature layout at training time.
    meals,
    mealIngredients,
    approvedQueue,
    mealHistory,
    pantryItems,
    userSettings,
  };

  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(
    `Exported to ${OUT_FILE}: ${meals.length} meals, ${mealIngredients.length} ingredient lines, ` +
      `${approvedQueue.length} approvals, ${mealHistory.length} history rows, ${pantryItems.length} pantry items.`
  );

  await sql.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
