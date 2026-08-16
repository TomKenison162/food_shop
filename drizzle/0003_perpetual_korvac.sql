CREATE TABLE IF NOT EXISTS "meal_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"meal_id" integer NOT NULL,
	"served_date" varchar(10) NOT NULL,
	"offer_group" varchar(40) NOT NULL,
	"was_chosen" boolean DEFAULT false NOT NULL,
	"was_primary" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"day_of_week" integer,
	"is_weekend" boolean,
	"temperature_c" numeric(5, 1),
	"pantry_overlap_grams" numeric(8, 1),
	"days_since_last_served" integer,
	"protein_days_since_last_served" integer,
	"ingredients_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meal_history" ADD COLUMN "decline_reason" varchar(30);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_offers" ADD CONSTRAINT "meal_offers_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_offers_group_idx" ON "meal_offers" USING btree ("offer_group");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_offers_served_date_idx" ON "meal_offers" USING btree ("served_date");