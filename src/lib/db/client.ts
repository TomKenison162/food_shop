import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. For local dev, run `npm run db:local-server` in another " +
      "terminal (a local PGlite Postgres server) and set DATABASE_URL to " +
      "postgres://postgres:postgres@127.0.0.1:5433/postgres. For production, point it at Supabase."
  );
}

function createDb() {
  // One connection, no prepared statements — plays nicely with both
  // Supabase's pooler (pgbouncer) in production and PGlite's socket server
  // (single-connection) in local dev.
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  return drizzle(client, { schema });
}

// Next.js dev mode recompiles each route as its own module graph, which
// would otherwise construct a fresh postgres() connection per route on
// first request. Caching on globalThis (standard Next.js dev pattern, same
// one Prisma's docs recommend) keeps it to one real connection — load-
// bearing here since our local dev DB (PGlite's socket server) only
// reliably supports a single connection.
declare global {
  // eslint-disable-next-line no-var
  var __db: ReturnType<typeof createDb> | undefined;
}

export const db = globalThis.__db ?? (globalThis.__db = createDb());
