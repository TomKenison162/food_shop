import "dotenv/config";
import { readFileSync } from "fs";
import postgres from "postgres";

/**
 * Loads a `npm run db:export` dump into the database in DATABASE_URL —
 * the other half of moving to production without re-swiping or re-paying
 * for pricing lookups.
 *
 * Original ids are preserved so the foreign keys between meals,
 * ingredients, approvals and history stay intact; sequences are then reset
 * past the highest id so new inserts don't collide.
 *
 * Refuses to run against a database that already has meals unless
 * --force is passed, since it would otherwise duplicate everything.
 *
 * Usage:
 *   DATABASE_URL="<supabase url>" npm run db:import
 *   DATABASE_URL="<supabase url>" npm run db:import -- food-shop-export.json --force
 */
const args = process.argv.slice(2);
const force = args.includes("--force");
const IN_FILE = args.find((a) => !a.startsWith("--")) ?? "food-shop-export.json";

type Row = Record<string, unknown>;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  const data = JSON.parse(readFileSync(IN_FILE, "utf8"));
  console.log(`Loading ${IN_FILE} (exported ${data.exportedAt}) into ${redact(process.env.DATABASE_URL)}`);

  const [{ count }] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM meals`;
  if (count > 0 && !force) {
    throw new Error(
      `Target already has ${count} meals — importing would duplicate them. ` +
        `Re-run with --force if you're sure (this deletes the existing rows first).`
    );
  }

  await sql.begin(async (tx) => {
    if (count > 0) {
      console.log("  --force: clearing existing rows…");
      // meals cascades to ingredients/approvals/history.
      await tx`DELETE FROM pantry_items`;
      await tx`DELETE FROM meals`;
      await tx`DELETE FROM user_settings`;
    }

    await insertAll(tx, "meals", data.meals);
    await insertAll(tx, "meal_ingredients", data.mealIngredients);
    await insertAll(tx, "approved_queue", data.approvedQueue);
    await insertAll(tx, "meal_history", data.mealHistory);
    await insertAll(tx, "pantry_items", data.pantryItems);
    await insertAll(tx, "user_settings", data.userSettings);

    // Ids were preserved above, so each sequence still points at 1 and the
    // next insert would collide — fast-forward past the highest id.
    for (const table of [
      "meals",
      "meal_ingredients",
      "approved_queue",
      "meal_history",
      "pantry_items",
      "user_settings",
    ]) {
      await tx.unsafe(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
      );
    }
  });

  console.log("Import complete.");
  await sql.end();
  process.exit(0);
}

async function insertAll(tx: postgres.TransactionSql, table: string, rows: Row[] | undefined) {
  if (!rows || rows.length === 0) {
    console.log(`  ${table}: nothing to import`);
    return;
  }
  // Chunked to stay well under parameter limits on wide tables.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await tx`INSERT INTO ${tx(table)} ${tx(chunk as never[])}`;
  }
  console.log(`  ${table}: imported ${rows.length} rows`);
}

function redact(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:****@");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
