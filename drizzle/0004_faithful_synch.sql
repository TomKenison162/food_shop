ALTER TABLE "meal_history" ADD COLUMN "apparent_temperature_c" numeric(5, 1);--> statement-breakpoint
ALTER TABLE "meal_history" ADD COLUMN "precipitation_mm" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "meal_offers" ADD COLUMN "apparent_temperature_c" numeric(5, 1);--> statement-breakpoint
ALTER TABLE "meal_offers" ADD COLUMN "precipitation_mm" numeric(5, 2);