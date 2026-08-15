import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  varchar,
  pgEnum,
  jsonb,
} from "drizzle-orm/pg-core";

export const tierEnum = pgEnum("tier", ["budget", "standard", "gourmet"]);

/**
 * A recipe. cost_1_person / cost_2_person / tier stay NULL until the pricing
 * pipeline has priced every ingredient — see src/lib/pricing/adapter.ts.
 * Unpriced meals are excluded from the live swipe deck's tier filter.
 */
export const meals = pgTable("meals", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description").notNull(),
  instructions: text("instructions").array().notNull(),
  primaryProtein: varchar("primary_protein", { length: 100 }).notNull(),
  costOnePerson: numeric("cost_one_person", { precision: 8, scale: 2 }),
  costTwoPerson: numeric("cost_two_person", { precision: 8, scale: 2 }),
  tier: tierEnum("tier"),
  isClassic: boolean("is_classic").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per ingredient line on a meal. skuName/skuPrice/skuUnitSize stay
 * NULL until a pricing adapter other than NullPricingAdapter has run.
 */
export const mealIngredients = pgTable("meal_ingredients", {
  id: serial("id").primaryKey(),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  genericName: varchar("generic_name", { length: 200 }).notNull(),
  quantity: varchar("quantity", { length: 100 }).notNull(),
  skuName: varchar("sku_name", { length: 300 }),
  skuPrice: numeric("sku_price", { precision: 8, scale: 2 }),
  skuUnitSize: varchar("sku_unit_size", { length: 100 }),
});

/** The single user's swiped-right queue. */
export const approvedQueue = pgTable("approved_queue", {
  id: serial("id").primaryKey(),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Swiped-left meals, so the deck doesn't keep re-showing them. */
export const rejectedMeals = pgTable("rejected_meals", {
  id: serial("id").primaryKey(),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per day a dinner was actually served, used by the rotation engine
 * for both the 60-day anti-repetition rule and the previous-day protein rule.
 */
export const mealHistory = pgTable("meal_history", {
  id: serial("id").primaryKey(),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  primaryProtein: varchar("primary_protein", { length: 100 }).notNull(),
  servedDate: varchar("served_date", { length: 10 }).notNull().unique(), // YYYY-MM-DD, Europe/London
});

/**
 * Contextual yes/no training signal for the ranking model — distinct from
 * approvedQueue (general "would I ever cook this" preference). Each row is
 * "given this context, did tonight's suggestion land." Feature values are
 * snapshotted at decision time since weather can't be reliably re-fetched
 * for a past date later.
 */
export const dailyFeedback = pgTable("daily_feedback", {
  id: serial("id").primaryKey(),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD, Europe/London
  dayOfWeek: integer("day_of_week").notNull(), // 0=Sunday .. 6=Saturday
  isWeekend: boolean("is_weekend").notNull(),
  temperatureC: numeric("temperature_c", { precision: 5, scale: 1 }),
  accepted: boolean("accepted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Leftover stock from ingredient packs bought for a priced meal (e.g. a
 * recipe needs 400g chicken thighs but the matched SKU is a 500g pack —
 * 100g left over). Future meal selection prioritizes using this up in a
 * *different* dish before it's suggested again.
 */
export const pantryItems = pgTable("pantry_items", {
  id: serial("id").primaryKey(),
  genericName: varchar("generic_name", { length: 200 }).notNull().unique(),
  gramsRemaining: numeric("grams_remaining", { precision: 8, scale: 1 }).notNull(),
  sourceMealId: integer("source_meal_id").references(() => meals.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Latest trained logistic regression weights for ranking rotation
 * candidates. A single row (id=1), overwritten on each retrain — see
 * src/lib/ml/model.ts. Not an LLM: plain gradient-descent logistic
 * regression over contextual + meal features.
 */
export const mlModel = pgTable("ml_model", {
  id: serial("id").primaryKey(),
  featureNames: text("feature_names").array().notNull(),
  weights: jsonb("weights").notNull().$type<number[]>(),
  bias: numeric("bias", { precision: 12, scale: 8 }).notNull(),
  sampleCount: integer("sample_count").notNull(),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
});
