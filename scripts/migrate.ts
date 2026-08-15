import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Applies committed SQL migrations from ./drizzle.
 *
 * Preferred over `drizzle-kit push` for anything that matters: push diffs
 * the live schema and improvises DDL (and against the local PGlite dev
 * server it emits invalid constraint drops that fail outright), whereas
 * migrations are reviewable, ordered, and identical everywhere they run.
 *
 * Generate a new migration after editing src/lib/db/schema.ts with:
 *   npm run db:generate
 */
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }

  // max: 1 — migrations must run sequentially on a single connection.
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
