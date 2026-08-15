ALTER TABLE "meal_history" DROP CONSTRAINT IF EXISTS "meal_history_served_date_unique";--> statement-breakpoint
ALTER TABLE "meal_history" ADD COLUMN "first_shop_cost" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "meal_history" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meal_history" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pantry_items" ADD COLUMN "expires_on" varchar(10);--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "paused_until" varchar(10);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_history_served_date_idx" ON "meal_history" USING btree ("served_date");