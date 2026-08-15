import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";
import { LOCAL_PGLITE_PATH } from "./localPath";

// Both drivers implement the same Postgres dialect query builder; we only
// ever use the standard drizzle API (never driver-specific extras), so it's
// safe to give `db` one static type and pick the concrete driver at runtime.
function createDb(): PostgresJsDatabase<typeof schema> {
  if (process.env.DATABASE_URL) {
    // One connection per lambda invocation, low max, to play nicely with
    // Supabase's pooler (pgbouncer) under Vercel's serverless model.
    const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    return drizzlePg(client, { schema });
  }

  // No DATABASE_URL: fall back to PGlite, a WASM Postgres that persists to a
  // local directory with zero external services — lets the app run fully
  // offline on a laptop. Not for production; set DATABASE_URL before deploying.
  console.warn(
    `[db] DATABASE_URL not set — using local PGlite database at ${LOCAL_PGLITE_PATH}.`
  );
  const client = new PGlite(LOCAL_PGLITE_PATH);
  return drizzlePglite(client, { schema }) as unknown as PostgresJsDatabase<typeof schema>;
}

export const db = createDb();
