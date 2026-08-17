-- Multi-user migration.
--
-- Hand-written rather than left as generated: drizzle emits plain
-- `ADD COLUMN ... NOT NULL`, which fails outright on tables that already
-- have rows. The order below adds each column with a temporary default so
-- existing data backfills to user 1, and then DROPS that default, because a
-- lingering default is exactly what would let a query that forgot its user
-- silently write into user 1's data.

CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"email" varchar(200) NOT NULL,
	"portions" integer DEFAULT 2 NOT NULL,
	"paused_until" varchar(10),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint

-- User 1 is whoever the app already belonged to. The placeholder email is
-- replaced by scripts/setup-users.ts, which reads REMINDER_TO_EMAIL.
INSERT INTO "users" ("id", "name", "email")
SELECT 1, 'Owner', 'owner@placeholder.invalid'
WHERE NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = 1);
--> statement-breakpoint

-- Carry the old singleton settings across before they are orphaned.
UPDATE "users" SET
	"portions" = COALESCE((SELECT "portions" FROM "user_settings" WHERE "id" = 1), 2),
	"paused_until" = (SELECT "paused_until" FROM "user_settings" WHERE "id" = 1)
WHERE "id" = 1;
--> statement-breakpoint

SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM "users"), 1));
--> statement-breakpoint

ALTER TABLE "approved_queue" ADD COLUMN IF NOT EXISTS "user_id" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "event_log" ADD COLUMN IF NOT EXISTS "user_id" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "meal_history" ADD COLUMN IF NOT EXISTS "user_id" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "meal_offers" ADD COLUMN IF NOT EXISTS "user_id" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "ml_model" ADD COLUMN IF NOT EXISTS "user_id" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "pantry_items" ADD COLUMN IF NOT EXISTS "user_id" integer NOT NULL DEFAULT 1;--> statement-breakpoint

-- The backfill is done; from here a missing user is a database error.
ALTER TABLE "approved_queue" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "event_log" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "meal_history" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "meal_offers" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ml_model" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pantry_items" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "approved_queue" ADD CONSTRAINT "approved_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_log" ADD CONSTRAINT "event_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_history" ADD CONSTRAINT "meal_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_offers" ADD CONSTRAINT "meal_offers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ml_model" ADD CONSTRAINT "ml_model_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pantry_items" ADD CONSTRAINT "pantry_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- Pantry stock is per person: two users must not share one jar of cumin.
ALTER TABLE "pantry_items" DROP CONSTRAINT IF EXISTS "pantry_items_generic_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pantry_user_ingredient_idx" ON "pantry_items" USING btree ("user_id","generic_name");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "meal_history_user_date_idx" ON "meal_history" USING btree ("user_id","served_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_offers_user_date_idx" ON "meal_offers" USING btree ("user_id","served_date");
