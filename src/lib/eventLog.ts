import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "./db/client";
import { eventLog, mealHistory, mealIngredients, pantryItems } from "./db/schema";
import { addDaysToDateString, londonDateString } from "./date";
import { dishFeatures } from "./ml/dishFeatures";
import type { MealRecord } from "./rotationDecision";
import type { CurrentWeather } from "./weather/weather";
import { deviceFacts, recipeFacts, scoreStats, timeFacts } from "./eventFacts";
import type { SelectionDiagnostics } from "./rotationDecision";

/**
 * Wide, append-only capture of the world around each decision.
 *
 * This is deliberately separate from the model's feature set and is never
 * read by training. The two have opposite goals: the model wants a small
 * hand-chosen set of inputs because a wide one overfits on tens of rows,
 * whereas this wants everything, because context that wasn't recorded can
 * never be recovered. Weather for a past date can't be re-fetched, the
 * pantry has already moved on, and the candidate scores were never stored
 * anywhere.
 *
 * Every function here swallows its own errors. Logging is a side-benefit;
 * it must never be the reason dinner fails to arrive.
 */

/** Never let logging break the thing it's observing. */
async function write(row: typeof eventLog.$inferInsert): Promise<void> {
  try {
    await db.insert(eventLog).values(row);
  } catch {
    // Intentionally silent. A failed log is not worth a failed email.
  }
}

export interface PlanEventInput {
  userId: number;
  offerGroup: string;
  servedDate: string;
  portions: 1 | 2;
  weather: CurrentWeather;
  /** Everything the rules allowed, before selection. */
  candidates: MealRecord[];
  /** mealId -> model probability, or null when no model is trained. */
  scores: Map<number, number> | null;
  chosen: MealRecord;
  alternatives: MealRecord[];
  usedModel: boolean;
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  relaxedBudgetRule: boolean;
  spentThisWeekGBP: number;
  firstShopSpentThisWeekGBP: number;
  weeklyBudgetGBP: number;
  yesterdaysProtein: string | null;
  diagnostics: SelectionDiagnostics;
  modelInfo: unknown;
  now?: Date;
}

/**
 * Records a planning decision in full: the whole candidate pool with each
 * meal's score and character, what the pantry held, what had been eaten
 * recently, and which rules had to bend.
 *
 * Scoring every candidate (not just the winner) is the point. It's the only
 * way to ever ask counterfactual questions later: was the meal I declined
 * ranked above the one I accepted? Does the model rank differently on wet
 * days? None of that is answerable from the winner alone.
 */
export async function logPlanEvent(input: PlanEventInput): Promise<void> {
  const now = input.now ?? new Date();

  try {
    const [pantry, recent, allIngredients] = await Promise.all([
      db.select().from(pantryItems).where(eq(pantryItems.userId, input.userId)),
      db
        .select({
          servedDate: mealHistory.servedDate,
          mealId: mealHistory.mealId,
          primaryProtein: mealHistory.primaryProtein,
          accepted: mealHistory.accepted,
          declineReason: mealHistory.declineReason,
        })
        .from(mealHistory)
        .where(and(eq(mealHistory.userId, input.userId), gte(mealHistory.servedDate, addDaysToDateString(input.servedDate, -28))))
        .orderBy(desc(mealHistory.servedDate)),
      // Scoped to the candidates rather than the whole table. The daily run
      // already does real work under a timeout; a full ingredient scan just
      // to write a log entry is not worth the risk to it.
      db
        .select({ mealId: mealIngredients.mealId, genericName: mealIngredients.genericName })
        .from(mealIngredients)
        .where(inArray(mealIngredients.mealId, input.candidates.map((m) => m.id))),
    ]);

    const byMeal = new Map<number, string[]>();
    for (const row of allIngredients) {
      const list = byMeal.get(row.mealId) ?? [];
      list.push(row.genericName);
      byMeal.set(row.mealId, list);
    }

    const offeredIds = new Set([input.chosen.id, ...input.alternatives.map((a) => a.id)]);

    /**
     * Raw recipe text is kept only for the meals actually shown.
     *
     * Everything derived from that text (durations, cuisines, methods,
     * allergens, effort, richness) is kept for every candidate, so nothing
     * analysable is lost. Carrying the prose for all 77 as well pushed the
     * row past 100KB, and writing it is what made a decline exceed the 60
     * second function limit. The recipes are in the `meals` table anyway,
     * joinable by the id recorded here.
     */
    const describe = (m: MealRecord) => {
      const names = byMeal.get(m.id) ?? [];
      const offered = offeredIds.has(m.id);
      return {
        id: m.id,
        name: m.name,
        protein: m.primaryProtein,
        tier: m.tier,
        costMarginalTwoPerson: m.costMarginalTwoPerson,
        costFirstShopTwoPerson: m.costFirstShopTwoPerson,
        isClassic: m.isClassic,
        instructionCount: m.instructions.length,
        ingredientCount: names.length,
        dish: dishFeatures(m.instructions, names),
        recipe: recipeFacts(m.instructions, m.description, names),
        score: input.scores?.get(m.id) ?? null,
        selectionProbability: input.diagnostics.weights.find((w) => w.mealId === m.id)?.probability ?? null,
        wasChosen: m.id === input.chosen.id,
        wasOffered: offered,
        ...(offered ? { ingredients: names, instructions: m.instructions, description: m.description } : {}),
      };
    };

    await write({
      userId: input.userId,
      kind: "plan",
      offerGroup: input.offerGroup,
      servedDate: input.servedDate,
      mealId: input.chosen.id,
      payload: {
        version: 1,
        time: timeFacts(now),
        weather: input.weather,
        portions: input.portions,
        selection: {
          usedModel: input.usedModel,
          poolSize: input.candidates.length,
          diagnostics: input.diagnostics,
          scoreStats: scoreStats([...(input.scores?.values() ?? [])]),
          model: input.modelInfo,
          relaxedProteinRule: input.relaxedProteinRule,
          relaxedRepeatRule: input.relaxedRepeatRule,
          relaxedBudgetRule: input.relaxedBudgetRule,
          yesterdaysProtein: input.yesterdaysProtein,
          chosenId: input.chosen.id,
          alternativeIds: input.alternatives.map((a) => a.id),
        },
        budget: {
          weeklyBudgetGBP: input.weeklyBudgetGBP,
          spentThisWeekGBP: input.spentThisWeekGBP,
          firstShopSpentThisWeekGBP: input.firstShopSpentThisWeekGBP,
        },
        // The full pool, scored. Enables counterfactuals the winner alone can't.
        candidates: input.candidates.map(describe),
        pantry: pantry.map((p) => ({
          genericName: p.genericName,
          gramsRemaining: p.gramsRemaining,
          expiresOn: p.expiresOn,
        })),
        recentHistory: recent,
      },
    });
  } catch {
    // As above: never break planning to record it.
  }
}

export interface FeedbackEventInput {
  userId: number;
  offerGroup: string | null;
  servedDate: string;
  mealId: number;
  action: string;
  reason: string | null;
  /** When the reminder went out, so reply latency can be measured. */
  emailedAt: Date | null;
  userAgent: string | null;
  /** 0 = the meal led with, 1+ = an alternative. */
  offeredPosition: number | null;
  offeredCount: number | null;
  chosenScore: number | null;
  now?: Date;
}

/**
 * Records a reply, including how long it took.
 *
 * Latency is worth keeping even though nothing uses it yet: a reply two
 * minutes after the email and one at 11pm plausibly mean different things,
 * and it can't be reconstructed after the fact.
 */
export async function logFeedbackEvent(input: FeedbackEventInput): Promise<void> {
  const now = input.now ?? new Date();
  const latencySeconds =
    input.emailedAt !== null ? Math.round((now.getTime() - input.emailedAt.getTime()) / 1000) : null;

  await write({
    userId: input.userId,
    kind: "feedback",
    offerGroup: input.offerGroup,
    servedDate: input.servedDate,
    mealId: input.mealId,
    payload: {
      version: 1,
      time: timeFacts(now),
      action: input.action,
      reason: input.reason,
      emailedAt: input.emailedAt?.toISOString() ?? null,
      latencySeconds,
      device: deviceFacts(input.userAgent),
      offeredPosition: input.offeredPosition,
      offeredCount: input.offeredCount,
      chosenScore: input.chosenScore,
    },
  });
}

/** Counts by kind, for the cron response so the log is visibly alive. */
export async function eventLogSummary(userId: number): Promise<{ plan: number; feedback: number }> {
  try {
    const [plans, feedback] = await Promise.all([
      db.select({ id: eventLog.id }).from(eventLog).where(and(eq(eventLog.userId, userId), eq(eventLog.kind, "plan"))),
      db.select({ id: eventLog.id }).from(eventLog).where(and(eq(eventLog.userId, userId), eq(eventLog.kind, "feedback"))),
    ]);
    return { plan: plans.length, feedback: feedback.length };
  } catch {
    return { plan: 0, feedback: 0 };
  }
}
