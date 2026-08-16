ALTER TABLE "meal_history" ADD COLUMN "rating" integer;--> statement-breakpoint
ALTER TABLE "meal_history" ADD COLUMN "ate_leftovers" boolean DEFAULT false NOT NULL;