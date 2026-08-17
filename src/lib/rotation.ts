import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "./db/client";
import { approvedQueue, meals, mealHistory, mealIngredients, mealOffers, mlModel, pantryItems } from "./db/schema";
import { addDaysToDateString, dayOfWeekForDateString, londonDateString } from "./date";
import { expiringOverlapByMeal, pantryOverlapGrams } from "./pantry/pantry";
import { explainPick } from "./explainPick";
import { dishFeatures } from "./ml/dishFeatures";
import { getCurrentWeather } from "./weather/weather";
import { scoreMealsForTonight } from "./ml/model";
import { getPortionsSetting } from "./settings";
import { requireUserId } from "./userGuard";
import { getPantrySummary } from "./pantry/pantry";
import { spentInWeek } from "./budgetSpend";
import { costForPortions, firstShopCostForPortions, WEEKLY_BUDGET_GBP } from "./budget";
import { decideTonightsDinner, REPEAT_WINDOW_DAYS, type MealRecord } from "./rotationDecision";
import type { FeatureContext } from "./ml/features";
import { logPlanEvent } from "./eventLog";

export type { MealRecord };

export type PlannedMeal = typeof mealHistory.$inferSelect;

export interface RotationResult {
  meal: MealRecord;
  /** One-line plain-English reason for the pick, shown in the email. */
  explanation: string;
  /** True when selection was overridden to clear expiring stock. */
  useItUpMode: boolean;
  /** Runners-up offered in the same email; clicking one is a preference label. */
  alternatives: MealRecord[];
  /** Ties this email's options together so preference pairs stay within one offer. */
  offerGroup: string;
  /** The date this plan is for (YYYY-MM-DD, Europe/London). */
  planDate: string;
  portions: 1 | 2;
  cost: number | null;
  firstShopCost: number | null;
  context: FeatureContext;
  alreadySelectedToday: boolean;
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  relaxedBudgetRule: boolean;
  usedModel: boolean;
  spentThisWeekGBP: number;
  firstShopSpentThisWeekGBP: number;
}

/** The live (non-superseded) plan row for a date, if one exists. */
export async function getPlannedMeal(userId: number, date: string): Promise<PlannedMeal | undefined> {
  requireUserId(userId, "getPlannedMeal");
  return db.query.mealHistory.findFirst({
    where: and(
      eq(mealHistory.userId, userId),
      eq(mealHistory.servedDate, date),
      isNull(mealHistory.supersededAt)
    ),
  });
}

/**
 * Ensures a meal is chosen and persisted for `date`, returning it either
 * way. Idempotent: if a live plan row already exists it's returned
 * unchanged (`alreadySelectedToday: true`) rather than re-rolled.
 *
 * `excludeMealIds` lets a declined suggestion be replaced without the
 * engine handing back the same dish.
 */
export async function planMealForDate(
  userId: number,
  date: string,
  opts: { excludeMealIds?: number[]; now?: Date; useItUp?: boolean } = {}
): Promise<RotationResult | null> {
  requireUserId(userId, "planMealForDate");
  const { excludeMealIds = [], now = new Date(), useItUp = false } = opts;
  const portions = await getPortionsSetting(userId);

  const existing = await getPlannedMeal(userId, date);
  if (existing) {
    const meal = await db.query.meals.findFirst({ where: eq(meals.id, existing.mealId) });
    if (meal) {
      const [spent, firstShopSpent] = await spendTotals(userId, date);
      const prior = await latestOfferForDate(userId, date);
      return {
        meal,
        explanation: "",
        useItUpMode: false,
        alternatives: prior.alternatives,
        offerGroup: prior.offerGroup,
        planDate: date,
        portions: existing.portions === 1 ? 1 : 2,
        cost: existing.costIncurred !== null ? Number(existing.costIncurred) : null,
        firstShopCost: existing.firstShopCost !== null ? Number(existing.firstShopCost) : null,
        context: {
          dayOfWeek: existing.dayOfWeek ?? dayOfWeekForDateString(date),
          isWeekend: existing.isWeekend ?? false,
          temperatureC: existing.temperatureC !== null ? Number(existing.temperatureC) : null,
          apparentTemperatureC: existing.apparentTemperatureC !== null ? Number(existing.apparentTemperatureC) : null,
          precipitationMm: existing.precipitationMm !== null ? Number(existing.precipitationMm) : null,
        },
        alreadySelectedToday: true,
        relaxedProteinRule: false,
        relaxedRepeatRule: false,
        relaxedBudgetRule: false,
        usedModel: false,
        spentThisWeekGBP: spent,
        firstShopSpentThisWeekGBP: firstShopSpent,
      };
    }
  }

  const dow = dayOfWeekForDateString(date);
  // Weather is only meaningful for today; a plan built days ahead can't know
  // it, and guessing would poison the training snapshot.
  const weather =
    date === londonDateString(now)
      ? await getCurrentWeather()
      : { temperatureC: null, apparentTemperatureC: null, precipitationMm: null, raw: null };
  const context: FeatureContext = {
    dayOfWeek: dow,
    isWeekend: dow === 0 || dow === 6,
    temperatureC: weather.temperatureC,
    apparentTemperatureC: weather.apparentTemperatureC,
    precipitationMm: weather.precipitationMm,
  };

  const approvedMeals = (await approvedMealRecords(userId)).filter((m) => !excludeMealIds.includes(m.id));
  if (approvedMeals.length === 0) return null;

  const windowStart = addDaysToDateString(date, -REPEAT_WINDOW_DAYS);
  const recentServes = await db
    .select({ mealId: mealHistory.mealId, count: sql<number>`count(*)`.as("count") })
    .from(mealHistory)
    .where(and(eq(mealHistory.userId, userId), gte(mealHistory.servedDate, windowStart), isNull(mealHistory.supersededAt)))
    .groupBy(mealHistory.mealId);
  const servesInWindow = new Map(recentServes.map((r) => [r.mealId, Number(r.count)]));

  const yesterday = await getPlannedMeal(userId, addDaysToDateString(date, -1));
  const [spentThisWeek, firstShopSpentThisWeek] = await spendTotals(userId, date);
  const expiring = await expiringOverlapByMeal(userId, date);

  const scoreList = await scoreMealsForTonight(userId, approvedMeals, context);
  const scores = scoreList ? new Map(approvedMeals.map((m, i) => [m.id, scoreList[i]])) : null;

  const decision = decideTonightsDinner({
    portions,
    approvedMeals,
    servesInWindow,
    yesterdaysProtein: yesterday?.primaryProtein ?? null,
    spentThisWeek,
    weeklyBudget: WEEKLY_BUDGET_GBP,
    scores,
    expiringOverlap: new Map([...expiring].map(([id, v]) => [id, v.grams])),
    useItUp,
  });
  if (!decision) return null;

  const chosen = decision.meal;
  const cost = costForPortions(chosen, portions);
  const firstShop = firstShopCostForPortions(chosen, portions);

  // Snapshot feature values as they are right now — weather can't be
  // re-fetched for a past date, and pantry/recency drift, so a training
  // example has to record the world as it was when the call was made.
  //
  // Taken for the whole offered slate in one go: the chosen meal's snapshot
  // was previously computed here and then again inside recordOffer, and each
  // meal cost four separate round trips.
  const snapshots = await snapshotMeals(userId, [chosen, ...decision.alternatives], date);
  const chosenSnap = snapshots.get(chosen.id)!;
  const overlap = chosenSnap.pantryOverlapGrams;
  const ingredientCount = chosenSnap.ingredientsCount;
  const lastServed = chosenSnap.daysSinceLastServed;
  const proteinLastServed = chosenSnap.proteinDaysSinceLastServed;

  await db.insert(mealHistory).values({
    userId,
    mealId: chosen.id,
    primaryProtein: chosen.primaryProtein,
    servedDate: date,
    portions,
    costIncurred: cost !== null ? String(cost) : null,
    firstShopCost: firstShop !== null ? String(firstShop) : null,
    dayOfWeek: context.dayOfWeek,
    isWeekend: context.isWeekend,
    temperatureC: context.temperatureC !== null ? String(context.temperatureC) : null,
    apparentTemperatureC: context.apparentTemperatureC != null ? String(context.apparentTemperatureC) : null,
    precipitationMm: context.precipitationMm != null ? String(context.precipitationMm) : null,
    pantryOverlapGrams: String(overlap),
    daysSinceLastServed: lastServed,
    proteinDaysSinceLastServed: proteinLastServed,
    ingredientsCount: ingredientCount,
    usedModel: decision.usedModel,
  });

  // No pantry side effects here on purpose. Planning a meal only *proposes*
  // it — the pantry must not move until a "Yes" reply confirms it was
  // actually bought and cooked (see recordMealCooked). The snapshot above is
  // still taken pre-cook, which is exactly the state the suggestion was made in.

  // Every meal shown tonight is recorded with its own feature snapshot, not
  // just the one led with. Whichever gets clicked turns the whole group into
  // labelled comparisons; if none does, the group stays unresolved and
  // trains nothing.
  const offerGroup = `${date}:${Date.now().toString(36)}`;
  await recordOffer(userId, offerGroup, date, context, chosen, decision.alternatives, decision.usedModel, snapshots);

  // Wide capture, separate from the model's inputs and never trained on.
  // Deliberately not awaited: it reads the pantry, recent history and every
  // candidate's ingredients, and none of that is worth adding to the time
  // someone spends staring at a loading spinner after clicking a button.
  void logPlanEvent({
    userId,
    offerGroup,
    servedDate: date,
    portions,
    weather,
    candidates: approvedMeals,
    scores,
    chosen,
    alternatives: decision.alternatives,
    usedModel: decision.usedModel,
    relaxedProteinRule: decision.relaxedProteinRule,
    relaxedRepeatRule: decision.relaxedRepeatRule,
    relaxedBudgetRule: decision.relaxedBudgetRule,
    spentThisWeekGBP: spentThisWeek + (cost ?? 0),
    firstShopSpentThisWeekGBP: firstShopSpentThisWeek + (firstShop ?? 0),
    weeklyBudgetGBP: WEEKLY_BUDGET_GBP,
    yesterdaysProtein: yesterday?.primaryProtein ?? null,
    diagnostics: decision.diagnostics,
    modelInfo: await currentModelInfo(),
    now,
  });

  // Both lists come from the snapshot already taken above, so the
  // explanation costs nothing extra.
  const chosenNames = chosenSnap.ingredientNames;

  const explanation = explainPick({
    mealName: chosen.name,
    protein: chosen.primaryProtein,
    dish: dishFeatures(chosen.instructions, chosenNames),
    temperatureC: context.apparentTemperatureC ?? context.temperatureC,
    precipitationMm: context.precipitationMm ?? null,
    isWeekend: context.isWeekend,
    dayName: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][context.dayOfWeek],
    daysSinceLastServed: lastServed,
    proteinDaysSinceLastServed: proteinLastServed,
    expiringUsed: expiring.get(chosen.id)?.names ?? [],
    pantryUsed: chosenSnap.pantryUsedNames,
    usedModel: decision.usedModel,
    scoreRank: decision.diagnostics.chosenScoreRank,
    poolSize: decision.diagnostics.finalPoolIds.length,
    relaxedProteinRule: decision.relaxedProteinRule,
    relaxedRepeatRule: decision.relaxedRepeatRule,
    relaxedBudgetRule: decision.relaxedBudgetRule,
    useItUpMode: decision.useItUpMode,
  });

  return {
    meal: chosen,
    explanation,
    useItUpMode: decision.useItUpMode,
    alternatives: decision.alternatives,
    offerGroup,
    planDate: date,
    portions,
    cost,
    firstShopCost: firstShop,
    context,
    alreadySelectedToday: false,
    relaxedProteinRule: decision.relaxedProteinRule,
    relaxedRepeatRule: decision.relaxedRepeatRule,
    relaxedBudgetRule: decision.relaxedBudgetRule,
    usedModel: decision.usedModel,
    spentThisWeekGBP: spentThisWeek + (cost ?? 0),
    firstShopSpentThisWeekGBP: firstShopSpentThisWeek + (firstShop ?? 0),
  };
}

/**
 * Makes `mealId` the live plan for `date` — used when an alternative from
 * the email is picked, where the engine must defer to an explicit choice
 * rather than re-running selection.
 *
 * The superseded row keeps whatever label it had: it was genuinely offered
 * and genuinely passed over, which is exactly the comparison the preference
 * model learns from.
 */
export async function setPlanForDate(userId: number, date: string, mealId: number): Promise<RotationResult | null> {
  requireUserId(userId, "setPlanForDate");
  const meal = await db.query.meals.findFirst({ where: eq(meals.id, mealId) });
  if (!meal || meal.deletedAt !== null) return null;

  await db
    .update(mealHistory)
    .set({ supersededAt: new Date() })
    .where(and(eq(mealHistory.userId, userId), eq(mealHistory.servedDate, date), isNull(mealHistory.supersededAt)));

  const portions = await getPortionsSetting(userId);
  const dow = dayOfWeekForDateString(date);
  const context: FeatureContext = {
    dayOfWeek: dow,
    isWeekend: dow === 0 || dow === 6,
    ...(date === londonDateString()
      ? await getCurrentWeather()
      : { temperatureC: null, apparentTemperatureC: null, precipitationMm: null, raw: null }),
  };

  const cost = costForPortions(meal, portions);
  const firstShop = firstShopCostForPortions(meal, portions);
  // Same batched snapshot as the planner uses, rather than four separate
  // round trips. This path runs while someone waits on a click too.
  const snap = (await snapshotMeals(userId, [meal], date)).get(meal.id)!;
  const overlap = snap.pantryOverlapGrams;
  const ingredientCount = snap.ingredientsCount;
  const lastServed = snap.daysSinceLastServed;
  const proteinLastServed = snap.proteinDaysSinceLastServed;

  await db.insert(mealHistory).values({
    userId,
    mealId: meal.id,
    primaryProtein: meal.primaryProtein,
    servedDate: date,
    portions,
    costIncurred: cost !== null ? String(cost) : null,
    firstShopCost: firstShop !== null ? String(firstShop) : null,
    dayOfWeek: context.dayOfWeek,
    isWeekend: context.isWeekend,
    temperatureC: context.temperatureC !== null ? String(context.temperatureC) : null,
    apparentTemperatureC: context.apparentTemperatureC != null ? String(context.apparentTemperatureC) : null,
    precipitationMm: context.precipitationMm != null ? String(context.precipitationMm) : null,
    pantryOverlapGrams: String(overlap),
    daysSinceLastServed: lastServed,
    proteinDaysSinceLastServed: proteinLastServed,
    ingredientsCount: ingredientCount,
    // An explicitly chosen alternative is your decision, not a prediction.
    usedModel: false,
  });

  const [spentThisWeek, firstShopSpentThisWeek] = await spendTotals(userId, date);
  const prior = await latestOfferForDate(userId, date);

  return {
    meal,
    explanation: "You picked this one.",
    useItUpMode: false,
    alternatives: prior.alternatives.filter((m) => m.id !== meal.id),
    offerGroup: prior.offerGroup,
    planDate: date,
    portions,
    cost,
    firstShopCost: firstShop,
    context,
    alreadySelectedToday: false,
    relaxedProteinRule: false,
    relaxedRepeatRule: false,
    relaxedBudgetRule: false,
    usedModel: false,
    spentThisWeekGBP: spentThisWeek + (cost ?? 0),
    firstShopSpentThisWeekGBP: firstShopSpentThisWeek + (firstShop ?? 0),
  };
}

/**
 * Writes one row per meal shown in an email, each with its own feature
 * snapshot taken now — a non-chosen meal has to be judged on the state it
 * was actually offered under, and pantry, recency and weather all drift.
 */
interface MealSnapshot {
  pantryOverlapGrams: number;
  ingredientsCount: number;
  daysSinceLastServed: number | null;
  proteinDaysSinceLastServed: number | null;
  /** Carried so the explanation needs no further queries of its own. */
  ingredientNames: string[];
  pantryUsedNames: string[];
}

/**
 * Feature snapshots for several meals in three set-based queries.
 *
 * Replaces four queries per meal. With a primary plus two alternatives that
 * was sixteen sequential round trips (the chosen meal's snapshot was also
 * computed twice), which is what pushed the decline path past Vercel's 60
 * second ceiling: clicking "not in the mood" runs a full re-plan while
 * someone waits on the response.
 */
async function snapshotMeals(
  userId: number,
  mealsToSnapshot: MealRecord[],
  date: string
): Promise<Map<number, MealSnapshot>> {
  const ids = mealsToSnapshot.map((m) => m.id);
  const out = new Map<number, MealSnapshot>();
  if (ids.length === 0) return out;

  const [pantry, ingredientRows, historyRows] = await Promise.all([
    db.select().from(pantryItems).where(and(eq(pantryItems.userId, userId), gt(pantryItems.gramsRemaining, "0"))),
    db
      .select({ mealId: mealIngredients.mealId, genericName: mealIngredients.genericName })
      .from(mealIngredients)
      .where(inArray(mealIngredients.mealId, ids)),
    db
      .select({
        mealId: mealHistory.mealId,
        primaryProtein: mealHistory.primaryProtein,
        servedDate: mealHistory.servedDate,
      })
      .from(mealHistory)
      .where(and(eq(mealHistory.userId, userId), sql`${mealHistory.servedDate} < ${date}`, isNull(mealHistory.supersededAt))),
  ]);

  const pantryByName = new Map(pantry.map((p) => [p.genericName, Number(p.gramsRemaining)]));
  const namesByMeal = new Map<number, string[]>();
  for (const row of ingredientRows) {
    const list = namesByMeal.get(row.mealId) ?? [];
    list.push(row.genericName);
    namesByMeal.set(row.mealId, list);
  }

  const lastByMeal = new Map<number, string>();
  const lastByProtein = new Map<string, string>();
  for (const h of historyRows) {
    const m = lastByMeal.get(h.mealId);
    if (!m || h.servedDate > m) lastByMeal.set(h.mealId, h.servedDate);
    const p = lastByProtein.get(h.primaryProtein);
    if (!p || h.servedDate > p) lastByProtein.set(h.primaryProtein, h.servedDate);
  }
  const gap = (from: string | undefined): number | null =>
    from === undefined ? null : Math.round((Date.parse(date) - Date.parse(from)) / 86_400_000);

  for (const meal of mealsToSnapshot) {
    const names = namesByMeal.get(meal.id) ?? [];
    out.set(meal.id, {
      pantryOverlapGrams: names.reduce((sum, n) => sum + (pantryByName.get(n) ?? 0), 0),
      ingredientsCount: names.length,
      daysSinceLastServed: gap(lastByMeal.get(meal.id)),
      proteinDaysSinceLastServed: gap(lastByProtein.get(meal.primaryProtein)),
      ingredientNames: names,
      pantryUsedNames: names.filter((n) => pantryByName.has(n)),
    });
  }
  return out;
}

/**
 * Writes one row per meal shown in an email, each with its own feature
 * snapshot taken now — a non-chosen meal has to be judged on the state it
 * was actually offered under, and pantry, recency and weather all drift.
 */
async function recordOffer(
  userId: number,
  offerGroup: string,
  date: string,
  context: FeatureContext,
  primary: MealRecord,
  alternatives: MealRecord[],
  usedModel: boolean,
  snapshots: Map<number, MealSnapshot>
): Promise<void> {
  const offered = [primary, ...alternatives];
  const rows = offered.map((meal, i) => {
    const snap = snapshots.get(meal.id);
    return {
      userId,
      mealId: meal.id,
      servedDate: date,
      offerGroup,
      wasPrimary: i === 0,
      wasChosen: false,
      dayOfWeek: context.dayOfWeek,
      isWeekend: context.isWeekend,
      temperatureC: context.temperatureC !== null ? String(context.temperatureC) : null,
      apparentTemperatureC: context.apparentTemperatureC != null ? String(context.apparentTemperatureC) : null,
      precipitationMm: context.precipitationMm != null ? String(context.precipitationMm) : null,
      pantryOverlapGrams: String(snap?.pantryOverlapGrams ?? 0),
      daysSinceLastServed: snap?.daysSinceLastServed ?? null,
      proteinDaysSinceLastServed: snap?.proteinDaysSinceLastServed ?? null,
      ingredientsCount: snap?.ingredientsCount ?? 0,
      usedModel,
    };
  });
  await db.insert(mealOffers).values(rows);
}

/**
 * Marks which meal won an offer group, turning it into training data.
 *
 * Resolving the whole group (not just the winner) is what makes the losers
 * usable: an unresolved group means nobody replied, and inferring dislike
 * from silence would be exactly the confounded label this replaced.
 */
export async function resolveOffer(userId: number, offerGroup: string, chosenMealId: number): Promise<void> {
  requireUserId(userId, "resolveOffer");
  const now = new Date();
  await db
    .update(mealOffers)
    .set({ resolvedAt: now, wasChosen: false })
    .where(and(eq(mealOffers.userId, userId), eq(mealOffers.offerGroup, offerGroup)));
  await db
    .update(mealOffers)
    .set({ resolvedAt: now, wasChosen: true })
    .where(and(eq(mealOffers.userId, userId), eq(mealOffers.offerGroup, offerGroup), eq(mealOffers.mealId, chosenMealId)));
}

/**
 * Marks an offer group as answered with nobody winning — a decline of the
 * whole slate. The losers are real negatives; there just isn't a positive.
 */
export async function resolveOfferAsDeclined(userId: number, offerGroup: string): Promise<void> {
  requireUserId(userId, "resolveOfferAsDeclined");
  await db
    .update(mealOffers)
    .set({ resolvedAt: new Date() })
    .where(and(eq(mealOffers.userId, userId), eq(mealOffers.offerGroup, offerGroup)));
}

/** The most recent offer group for a date, with its non-primary meals. */
async function latestOfferForDate(
  userId: number,
  date: string
): Promise<{ offerGroup: string; alternatives: MealRecord[] }> {
  const rows = await db
    .select()
    .from(mealOffers)
    .where(and(eq(mealOffers.userId, userId), eq(mealOffers.servedDate, date)))
    .orderBy(desc(mealOffers.createdAt));

  if (rows.length === 0) return { offerGroup: `${date}:none`, alternatives: [] };

  const offerGroup = rows[0].offerGroup;
  const altIds = rows.filter((r) => r.offerGroup === offerGroup && !r.wasPrimary).map((r) => r.mealId);
  if (altIds.length === 0) return { offerGroup, alternatives: [] };

  const alternatives = await db.select().from(meals).where(inArray(meals.id, altIds));
  return { offerGroup, alternatives };
}

/** Where a meal sat in the slate it was offered in, and how big that slate was. */
export async function offerContext(
  userId: number,
  offerGroup: string,
  mealId: number
): Promise<{ position: number; count: number } | null> {
  const rows = await db
    .select({ mealId: mealOffers.mealId, wasPrimary: mealOffers.wasPrimary })
    .from(mealOffers)
    .where(and(eq(mealOffers.userId, userId), eq(mealOffers.offerGroup, offerGroup)));
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) => Number(b.wasPrimary) - Number(a.wasPrimary));
  const position = ordered.findIndex((r) => r.mealId === mealId);
  return { position, count: rows.length };
}

/** Which model produced tonight's scores, for the log. Null when untrained. */
async function currentModelInfo(): Promise<unknown> {
  try {
    const row = await db.query.mlModel.findFirst({ orderBy: desc(mlModel.trainedAt) });
    if (!row) return null;
    return {
      trainedAt: row.trainedAt,
      sampleCount: row.sampleCount,
      accuracy: row.accuracy,
      baselineAccuracy: row.baselineAccuracy,
      featureNames: row.featureNames,
    };
  } catch {
    return null;
  }
}

/** The offer group a given meal was part of on a date, if any. */
export async function offerGroupFor(userId: number, date: string, mealId: number): Promise<string | null> {
  requireUserId(userId, "offerGroupFor");
  const row = await db
    .select({ offerGroup: mealOffers.offerGroup })
    .from(mealOffers)
    .where(and(eq(mealOffers.userId, userId), eq(mealOffers.servedDate, date), eq(mealOffers.mealId, mealId)))
    .orderBy(desc(mealOffers.createdAt))
    .limit(1);
  return row[0]?.offerGroup ?? null;
}

/** Today's dinner (Europe/London). */
export function selectTonightsDinner(
  userId: number,
  opts: { now?: Date; useItUp?: boolean } = {}
): Promise<RotationResult | null> {
  requireUserId(userId, "selectTonightsDinner");
  const now = opts.now ?? new Date();
  return planMealForDate(userId, londonDateString(now), { now, useItUp: opts.useItUp });
}

/**
 * Marks the current plan for `date` as superseded and picks a replacement,
 * excluding everything already rejected for that date. The superseded row
 * is kept — it carries a real "declined in this context" training label.
 */
export async function replacePlanForDate(userId: number, date: string): Promise<RotationResult | null> {
  requireUserId(userId, "replacePlanForDate");
  const rejected = await db
    .select({ mealId: mealHistory.mealId })
    .from(mealHistory)
    .where(and(eq(mealHistory.userId, userId), eq(mealHistory.servedDate, date)));

  await db
    .update(mealHistory)
    .set({ supersededAt: new Date() })
    .where(and(eq(mealHistory.userId, userId), eq(mealHistory.servedDate, date), isNull(mealHistory.supersededAt)));

  return planMealForDate(userId, date, { excludeMealIds: rejected.map((r) => r.mealId) });
}


/** [marginal, firstShop] spend so far this calendar week, excluding `today`. */
async function spendTotals(userId: number, today: string): Promise<[number, number]> {
  return Promise.all([spentInWeek(userId, today), spentInWeek(userId, today, "firstShop")]);
}

async function approvedMealRecords(userId: number): Promise<MealRecord[]> {
  const rows = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .where(and(eq(approvedQueue.userId, userId), isNull(meals.deletedAt)));
  const seen = new Map<number, MealRecord>();
  for (const r of rows) seen.set(r.meal.id, r.meal);
  return [...seen.values()];
}

async function countIngredients(mealId: number): Promise<number> {
  const rows = await db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, mealId) });
  return rows.length;
}

export async function daysSinceLastServed(userId: number, mealId: number, asOfDate: string): Promise<number | null> {
  const rows = await db
    .select({ servedDate: mealHistory.servedDate })
    .from(mealHistory)
    .where(
      and(
        eq(mealHistory.mealId, mealId),
        sql`${mealHistory.servedDate} < ${asOfDate}`,
        isNull(mealHistory.supersededAt)
      )
    );
  return mostRecentGap(rows.map((r) => r.servedDate), asOfDate);
}

export async function proteinDaysSinceLastServed(
  protein: string,
  asOfDate: string
): Promise<number | null> {
  const rows = await db
    .select({ servedDate: mealHistory.servedDate })
    .from(mealHistory)
    .where(
      and(
        eq(mealHistory.primaryProtein, protein),
        sql`${mealHistory.servedDate} < ${asOfDate}`,
        isNull(mealHistory.supersededAt)
      )
    );
  return mostRecentGap(rows.map((r) => r.servedDate), asOfDate);
}

function mostRecentGap(dates: string[], asOfDate: string): number | null {
  if (dates.length === 0) return null;
  const mostRecent = dates.reduce((a, b) => (a > b ? a : b));
  return Math.round((Date.parse(asOfDate) - Date.parse(mostRecent)) / (1000 * 60 * 60 * 24));
}
