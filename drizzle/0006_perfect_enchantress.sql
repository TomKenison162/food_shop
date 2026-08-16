CREATE TABLE IF NOT EXISTS "event_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(20) NOT NULL,
	"offer_group" varchar(40),
	"served_date" varchar(10),
	"meal_id" integer,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_log_group_idx" ON "event_log" USING btree ("offer_group");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_log_kind_idx" ON "event_log" USING btree ("kind");