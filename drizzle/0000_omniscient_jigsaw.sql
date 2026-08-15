DO $$ BEGIN
 CREATE TYPE "public"."tier" AS ENUM('budget', 'standard', 'gourmet');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approved_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"meal_id" integer NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"meal_id" integer NOT NULL,
	"primary_protein" varchar(100) NOT NULL,
	"served_date" varchar(10) NOT NULL,
	"portions" integer DEFAULT 2 NOT NULL,
	"cost_incurred" numeric(8, 2),
	"day_of_week" integer,
	"is_weekend" boolean,
	"temperature_c" numeric(5, 1),
	"pantry_overlap_grams" numeric(8, 1),
	"days_since_last_served" integer,
	"protein_days_since_last_served" integer,
	"ingredients_count" integer,
	"accepted" boolean,
	"responded_at" timestamp with time zone,
	CONSTRAINT "meal_history_served_date_unique" UNIQUE("served_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meal_ingredients" (
	"id" serial PRIMARY KEY NOT NULL,
	"meal_id" integer NOT NULL,
	"generic_name" varchar(200) NOT NULL,
	"quantity" varchar(100) NOT NULL,
	"sku_name" varchar(300),
	"sku_price" numeric(8, 2),
	"marginal_price" numeric(8, 2),
	"sku_unit_size" varchar(100),
	"pack_price" numeric(8, 2),
	"pack_grams" numeric(8, 1),
	"grams_purchased" numeric(8, 1),
	"grams_needed" numeric(8, 1),
	"is_estimated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meals" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"instructions" text[] NOT NULL,
	"primary_protein" varchar(100) NOT NULL,
	"cost_first_shop_one_person" numeric(8, 2),
	"cost_first_shop_two_person" numeric(8, 2),
	"cost_marginal_one_person" numeric(8, 2),
	"cost_marginal_two_person" numeric(8, 2),
	"tier" "tier",
	"is_classic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ml_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"feature_names" text[] NOT NULL,
	"model_data_base64" text NOT NULL,
	"sample_count" integer NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pantry_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"generic_name" varchar(200) NOT NULL,
	"grams_remaining" numeric(8, 1) NOT NULL,
	"source_meal_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pantry_items_generic_name_unique" UNIQUE("generic_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"portions" integer DEFAULT 2 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approved_queue" ADD CONSTRAINT "approved_queue_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_history" ADD CONSTRAINT "meal_history_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "meal_ingredients" ADD CONSTRAINT "meal_ingredients_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pantry_items" ADD CONSTRAINT "pantry_items_source_meal_id_meals_id_fk" FOREIGN KEY ("source_meal_id") REFERENCES "public"."meals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
