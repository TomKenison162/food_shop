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
  index,
} from "drizzle-orm/pg-core";

export const tierEnum = pgEnum("tier", ["budget", "standard", "gourmet"]);

/**
 * A recipe. All four cost columns and `tier` stay NULL until the pricing
 * pipeline has run — see src/lib/pricing/priceApproved.ts.
 *
 * Two distinct costs are tracked because they answer different questions:
 *  - costFirstShop*: what you'd pay buying every ingredient fresh, whole
 *    packs included (a 340g jar of honey for a 2 tbsp recipe line). This is
 *    the real shopping-list total the first time you cook something.
 *  - costMarginal*: the prorated value of what the dish actually consumes
 *    (2 tbsp of that jar, not the jar). This is the honest ongoing cost of
 *    cooking it once you keep staples in, and it's what tiering and the
 *    weekly budget use — otherwise every dish looks like a £15 blowout
 *    because it "bought" oil, salt and spices from scratch each time.
 *
 * First-shop cost doesn't halve for one person (packs don't shrink), so
 * costFirstShopOnePerson == costFirstShopTwoPerson by design; marginal cost
 * does halve, since you genuinely use half the food.
 */
export const meals = pgTable("meals", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description").notNull(),
  instructions: text("instructions").array().notNull(),
  primaryProtein: varchar("primary_protein", { length: 100 }).notNull(),
  costFirstShopOnePerson: numeric("cost_first_shop_one_person", { precision: 8, scale: 2 }),
  costFirstShopTwoPerson: numeric("cost_first_shop_two_person", { precision: 8, scale: 2 }),
  costMarginalOnePerson: numeric("cost_marginal_one_person", { precision: 8, scale: 2 }),
  costMarginalTwoPerson: numeric("cost_marginal_two_person", { precision: 8, scale: 2 }),
  tier: tierEnum("tier"),
  isClassic: boolean("is_classic").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete — set when swiped left. Rows are never hard-deleted, so a misswipe is undoable. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * One row per ingredient line on a meal. Pricing columns stay NULL until a
 * pricing adapter other than NullPricingAdapter has run.
 *
 * packPrice/packGrams are stored (not just the computed totals) so costs can
 * be recomputed locally — e.g. when the prorating rules change — without
 * re-hitting the paid pricing API.
 */
export const mealIngredients = pgTable("meal_ingredients", {
  id: serial("id").primaryKey(),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  genericName: varchar("generic_name", { length: 200 }).notNull(),
  quantity: varchar("quantity", { length: 100 }).notNull(),
  skuName: varchar("sku_name", { length: 300 }),
  /** Whole-pack cost for this line: packsNeeded x packPrice. */
  skuPrice: numeric("sku_price", { precision: 8, scale: 2 }),
  /** Prorated cost of just what the recipe consumes. */
  marginalPrice: numeric("marginal_price", { precision: 8, scale: 2 }),
  skuUnitSize: varchar("sku_unit_size", { length: 100 }),
  packPrice: numeric("pack_price", { precision: 8, scale: 2 }),
  packGrams: numeric("pack_grams", { precision: 8, scale: 1 }),
  // Persisted from pricing so pantry leftovers can be recorded later, at
  // serve time (see rotation.ts) — not at pricing time, since pricing the
  // whole approved queue isn't 51 real shopping trips.
  gramsPurchased: numeric("grams_purchased", { precision: 8, scale: 1 }),
  gramsNeeded: numeric("grams_needed", { precision: 8, scale: 1 }),
  // true when pricing is a hand-estimated guess (the pricing API had no
  // match), not a real Sainsbury's price — surfaced in the email so guesses
  // are never presented as real data. See src/lib/pricing/estimates.ts.
  isEstimated: boolean("is_estimated").notNull().default(false),
});

/** The single user's swiped-right queue. */
export const approvedQueue = pgTable("approved_queue", {
  id: serial("id").primaryKey(),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id, { onDelete: "cascade" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per day a dinner was served. Serves three jobs at once:
 *  1. the rotation engine's 60-day anti-repetition + previous-day protein rules
 *  2. the weekly budget check (portions + costIncurred)
 *  3. the ML model's training set
 *
 * Every value here is snapshotted at serve time on purpose. Prices, the
 * portions setting, the pantry and the weather all drift, and weather in
 * particular can't be re-fetched for a past date — so a training example
 * must record the world as it was when the suggestion was made, not as it
 * looks whenever the model is next retrained.
 *
 * `accepted` is NULL until the Yes/No link in that day's email is clicked;
 * rows with a non-NULL value are exactly the model's labelled examples.
 */
export const mealHistory = pgTable(
  "meal_history",
  {
    id: serial("id").primaryKey(),
    mealId: integer("meal_id")
      .notNull()
      .references(() => meals.id, { onDelete: "cascade" }),
    primaryProtein: varchar("primary_protein", { length: 100 }).notNull(),
    servedDate: varchar("served_date", { length: 10 }).notNull(), // YYYY-MM-DD, Europe/London
    portions: integer("portions").notNull().default(2),
    costIncurred: numeric("cost_incurred", { precision: 8, scale: 2 }),
    /** First-shop cost of the same meal, so the email can show what the till actually charges. */
    firstShopCost: numeric("first_shop_cost", { precision: 8, scale: 2 }),
    // --- context snapshot, used as ML features ---
    dayOfWeek: integer("day_of_week"), // 0=Sunday .. 6=Saturday
    isWeekend: boolean("is_weekend"),
    temperatureC: numeric("temperature_c", { precision: 5, scale: 1 }),
    pantryOverlapGrams: numeric("pantry_overlap_grams", { precision: 8, scale: 1 }),
    daysSinceLastServed: integer("days_since_last_served"),
    proteinDaysSinceLastServed: integer("protein_days_since_last_served"),
    ingredientsCount: integer("ingredients_count"),
    // --- label ---
    accepted: boolean("accepted"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    /** Set once the reminder for this date has gone out, so hourly polling can't re-send. */
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    /**
     * Set when the suggestion was declined and replaced. The superseded row
     * keeps its `accepted: false` label (it's a real training example) while
     * a fresh row becomes the live plan for that date — which is why
     * servedDate is indexed rather than unique. "The meal for date D" always
     * means the row where supersededAt IS NULL.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    servedDateIdx: index("meal_history_served_date_idx").on(t.servedDate),
  })
);

/**
 * Singleton (id=1) row of user-level preferences. Just `portions` for now —
 * the daily 5pm email needs to know 1 or 2 without anyone being prompted,
 * so it's a persisted setting (updated from the swipe-deck toggle) rather
 * than client-only UI state.
 */
export const userSettings = pgTable("user_settings", {
  id: serial("id").primaryKey(),
  portions: integer("portions").notNull().default(2),
  /**
   * Inclusive YYYY-MM-DD through which reminders are suspended (holidays).
   * Without this, a week away produces a run of "No" replies that mean "I'm
   * not home" — which the model would learn as "dislikes these meals".
   */
  pausedUntil: varchar("paused_until", { length: 10 }),
});

/**
 * Leftover stock from ingredient packs bought for a served meal (e.g. a
 * recipe needs 400g chicken thighs but the matched SKU is a 500g pack —
 * 100g left over). Future meal selection prioritizes using this up in a
 * *different* dish before it's suggested again.
 *
 * Everything here expires: real food goes off, and stock that never ages
 * out would have the app confidently telling you not to buy chicken
 * because of a pack opened three weeks ago. See SHELF_LIFE_DAYS in
 * src/lib/pantry/shelfLife.ts.
 */
export const pantryItems = pgTable("pantry_items", {
  id: serial("id").primaryKey(),
  genericName: varchar("generic_name", { length: 200 }).notNull().unique(),
  gramsRemaining: numeric("grams_remaining", { precision: 8, scale: 1 }).notNull(),
  sourceMealId: integer("source_meal_id").references(() => meals.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** YYYY-MM-DD after which this stock is treated as gone. */
  expiresOn: varchar("expires_on", { length: 10 }),
});

/**
 * Latest trained XGBoost model (gradient-boosted trees, @wlearn/xgboost —
 * WASM, not an LLM) for ranking rotation candidates. A single row,
 * replaced wholesale on each retrain — see src/lib/ml/model.ts. Serialized
 * model bytes are stored base64-encoded (Postgres numeric/jsonb aren't a
 * good fit for an opaque binary blob).
 */
export const mlModel = pgTable("ml_model", {
  id: serial("id").primaryKey(),
  featureNames: text("feature_names").array().notNull(),
  modelDataBase64: text("model_data_base64").notNull(),
  sampleCount: integer("sample_count").notNull(),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  /** Leave-one-out accuracy, and the majority-class rate it had to beat. */
  accuracy: numeric("accuracy", { precision: 5, scale: 4 }),
  baselineAccuracy: numeric("baseline_accuracy", { precision: 5, scale: 4 }),
});
