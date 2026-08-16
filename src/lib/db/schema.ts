import {
  jsonb,
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
    /** Feels-like reading, and rain in mm. Snapshotted because weather cannot be re-fetched for a past date. */
    apparentTemperatureC: numeric("apparent_temperature_c", { precision: 5, scale: 1 }),
    precipitationMm: numeric("precipitation_mm", { precision: 5, scale: 2 }),
    pantryOverlapGrams: numeric("pantry_overlap_grams", { precision: 8, scale: 1 }),
    daysSinceLastServed: integer("days_since_last_served"),
    proteinDaysSinceLastServed: integer("protein_days_since_last_served"),
    ingredientsCount: integer("ingredients_count"),
    /**
     * Whether the trained model actually ranked this pick, or it was a
     * random choice among the meals the rules allowed. Without it there is
     * no way to tell afterwards which suggestions the model was responsible
     * for, so no way to judge whether it is earning its place.
     */
    usedModel: boolean("used_model").notNull().default(false),
    // --- label ---
    accepted: boolean("accepted"),
    /**
     * Why a suggestion was declined. A bare "no" conflates genuinely
     * different things — not fancying a dish, it being too expensive, it
     * being too much effort on a Tuesday, and simply not being home — and a
     * model trained on the union of those learns none of them. Crucially
     * "not_home" is not a preference at all and is excluded from training
     * entirely; see buildTrainingSet in src/lib/ml/model.ts.
     */
    declineReason: varchar("decline_reason", { length: 30 }),
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
 * One row per meal *offered* on a given date — the preference training set.
 *
 * The daily email presents a primary pick plus alternatives, and whichever
 * one gets clicked is a genuine comparative judgement: "this, over those,
 * tonight". That is far denser signal than the old accept/decline bit. One
 * evening produces a positive and two negatives that share a context
 * exactly, so the model learns what distinguishes meals rather than what
 * distinguishes Tuesdays — and it arrives whether or not the reply is a
 * refusal, so engagement produces data every time.
 *
 * The per-meal feature snapshot is duplicated here rather than recomputed at
 * train time for the same reason meal_history snapshots it: pantry state,
 * recency and weather all drift, and weather can't be re-fetched for a past
 * date. A non-chosen meal's features must be the ones it was rejected under.
 */
export const mealOffers = pgTable(
  "meal_offers",
  {
    id: serial("id").primaryKey(),
    mealId: integer("meal_id")
      .notNull()
      .references(() => meals.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD (Europe/London) the offer was made for. */
    servedDate: varchar("served_date", { length: 10 }).notNull(),
    /** Groups the meals shown together, so pairs are only drawn within one email. */
    offerGroup: varchar("offer_group", { length: 40 }).notNull(),
    /** True for the one that was clicked. NULL-free: unclicked offers are real negatives. */
    wasChosen: boolean("was_chosen").notNull().default(false),
    /** True for the meal the engine led with, so lead-bias can be measured. */
    wasPrimary: boolean("was_primary").notNull().default(false),
    /** Set once any option in the group is clicked; unanswered groups train nothing. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // --- context snapshot, identical shape to meal_history's ---
    dayOfWeek: integer("day_of_week"),
    isWeekend: boolean("is_weekend"),
    temperatureC: numeric("temperature_c", { precision: 5, scale: 1 }),
    /** Feels-like reading, and rain in mm. Snapshotted because weather cannot be re-fetched for a past date. */
    apparentTemperatureC: numeric("apparent_temperature_c", { precision: 5, scale: 1 }),
    precipitationMm: numeric("precipitation_mm", { precision: 5, scale: 2 }),
    pantryOverlapGrams: numeric("pantry_overlap_grams", { precision: 8, scale: 1 }),
    daysSinceLastServed: integer("days_since_last_served"),
    proteinDaysSinceLastServed: integer("protein_days_since_last_served"),
    ingredientsCount: integer("ingredients_count"),
    /** Whether the model ranked this offer group, or it was a random pick among rule survivors. */
    usedModel: boolean("used_model").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    offerGroupIdx: index("meal_offers_group_idx").on(t.offerGroup),
    offerDateIdx: index("meal_offers_served_date_idx").on(t.servedDate),
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
 * Append-only record of everything known at the moment a decision was made,
 * and everything known when it was answered.
 *
 * Deliberately NOT a feature store and deliberately NOT read by
 * buildTrainingSet. The model uses a small, hand-chosen feature set because
 * a wide one overfits on tens of rows. This table exists for the opposite
 * reason: context that isn't captured is gone forever, and the cost of
 * keeping it is a few kilobytes a day. When there are hundreds of labelled
 * evenings and a real question to ask ("does humidity matter?", "am I
 * slower to reply when I decline?"), the history will already be here.
 *
 * `payload` is jsonb precisely so new things can be logged without a
 * migration. Nothing reads its shape, so nothing breaks when it changes.
 */
export const eventLog = pgTable(
  "event_log",
  {
    id: serial("id").primaryKey(),
    /** "plan" when a dinner was chosen, "feedback" when one was answered. */
    kind: varchar("kind", { length: 20 }).notNull(),
    /** Ties a feedback event back to the plan that produced it. */
    offerGroup: varchar("offer_group", { length: 40 }),
    servedDate: varchar("served_date", { length: 10 }),
    mealId: integer("meal_id"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventGroupIdx: index("event_log_group_idx").on(t.offerGroup),
    eventKindIdx: index("event_log_kind_idx").on(t.kind),
  })
);

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
