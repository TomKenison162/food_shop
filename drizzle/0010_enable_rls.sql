-- Enables Row-Level Security on every table in the public schema.
--
-- Supabase flagged all 11 tables as "publicly accessible" because RLS was
-- off. That matters because Supabase auto-exposes every public-schema table
-- through its REST API (PostgREST) at https://<project>.supabase.co/rest/v1/,
-- authenticated by the anon key — a key meant to be embeddable in client-side
-- code, i.e. effectively public. With RLS off, that key could read, edit, or
-- delete every row in every table directly, completely bypassing this app's
-- password gate and per-user scoping (the middleware only guards the Next.js
-- routes; it has no relationship to Supabase's own REST endpoint).
--
-- Enabling RLS with zero policies makes every table default-deny for any
-- role without BYPASSRLS. The app's own connection uses the `postgres` role,
-- which carries BYPASSRLS by default in Supabase — confirmed directly
-- against this project before writing this migration — so the app is
-- unaffected. The `anon` / `authenticated` roles PostgREST uses do not have
-- it, so the REST API now returns nothing for every table, closing the hole
-- with no policies required (the app was never meant to be reachable that
-- way to begin with).
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meal_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approved_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meal_rejections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meal_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meal_offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pantry_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ml_model" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;
