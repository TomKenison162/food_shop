import type { DishFeatures } from "./ml/dishFeatures";

/**
 * A plain-English sentence saying why tonight's meal was chosen.
 *
 * Every input is already computed for the decision, so this adds nothing but
 * wording. The point is that it makes the reasoning *falsifiable*: a black
 * box that quietly drifts is invisible, whereas "you haven't had lamb in
 * three weeks" is something you can immediately recognise as wrong.
 *
 * Pure and dependency-free so it can be tested without a database.
 */

export interface ExplainInput {
  mealName: string;
  protein: string;
  dish: DishFeatures;
  /** Feels-like temperature, °C. */
  temperatureC: number | null;
  precipitationMm: number | null;
  isWeekend: boolean;
  dayName: string;
  /** Days since this exact meal was last served; null if never. */
  daysSinceLastServed: number | null;
  /** Days since anything with this protein; null if never. */
  proteinDaysSinceLastServed: number | null;
  /** Pantry items this meal would use that expire within a few days. */
  expiringUsed: string[];
  /** Pantry names this meal uses at all. */
  pantryUsed: string[];
  usedModel: boolean;
  /** Where this meal ranked among the pool by model score, 1 = top. */
  scoreRank: number | null;
  poolSize: number;
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  relaxedBudgetRule: boolean;
  /** True when selection was overridden to clear expiring stock. */
  useItUpMode: boolean;
}

function list(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Builds the sentence, strongest reason first.
 *
 * Reasons are gathered then trimmed to the best three: a paragraph of
 * justification reads as defensive, and past three clauses nobody is
 * reading anyway.
 */
export function explainPick(input: ExplainInput): string {
  const reasons: string[] = [];

  // A forced hand is the most important thing to say, so it leads.
  if (input.useItUpMode && input.expiringUsed.length > 0) {
    return `Use-it-up night: this clears ${list(input.expiringUsed)} before ${
      input.expiringUsed.length === 1 ? "it goes" : "they go"
    } off.`;
  }

  if (input.expiringUsed.length > 0) {
    reasons.push(`it uses up ${list(input.expiringUsed)} before ${input.expiringUsed.length === 1 ? "it turns" : "they turn"}`);
  } else if (input.pantryUsed.length > 0) {
    reasons.push(`you already have ${list(input.pantryUsed.slice(0, 3))} in`);
  }

  const temp = input.temperatureC;
  const wet = (input.precipitationMm ?? 0) > 0;
  if (temp !== null && temp <= 8 && input.dish.richness >= 0.3) {
    reasons.push(wet ? `it's ${Math.round(temp)}° and wet` : `it's only ${Math.round(temp)}° out`);
  } else if (temp !== null && temp >= 20 && input.dish.richness < 0.3) {
    reasons.push(`it's ${Math.round(temp)}° and this one's light`);
  } else if (wet) {
    reasons.push("it's wet out and this needs nothing you haven't got");
  }

  // Protein variety reads better in weeks once it's been a while.
  const pd = input.proteinDaysSinceLastServed;
  if (pd !== null && pd >= 14) {
    reasons.push(`you haven't had ${input.protein} in ${Math.floor(pd / 7)} weeks`);
  } else if (pd !== null && pd >= 7) {
    reasons.push(`you haven't had ${input.protein} in over a week`);
  }

  if (input.daysSinceLastServed === null) {
    reasons.push("you've never actually cooked it");
  } else if (input.daysSinceLastServed >= 60) {
    reasons.push(`you last had it ${Math.floor(input.daysSinceLastServed / 30)} months ago`);
  }

  if (!input.isWeekend && input.dish.effortMinutes <= 25) {
    reasons.push(`it's a ${input.dayName} and this is ~${input.dish.effortMinutes} minutes`);
  } else if (input.isWeekend && input.dish.effortMinutes >= 90) {
    reasons.push("it's the weekend and there's time for something slow");
  }

  if (input.usedModel && input.scoreRank !== null && input.scoreRank <= 3 && input.poolSize > 5) {
    reasons.push(`the model ranks it ${input.scoreRank === 1 ? "top" : `#${input.scoreRank}`} of ${input.poolSize}`);
  }

  const caveats: string[] = [];
  if (input.relaxedBudgetRule) caveats.push("it's over budget, but everything else was worse");
  if (input.relaxedProteinRule) caveats.push("it repeats yesterday's protein because nothing else avoided it");
  if (input.relaxedRepeatRule) caveats.push("your queue is getting repetitive");

  if (reasons.length === 0 && caveats.length === 0) {
    return input.usedModel
      ? "No strong reason: the model rates it about as well as everything else tonight."
      : "Picked at random from what tonight's rules allow.";
  }

  const head = reasons.length > 0 ? `Picked because ${list(reasons.slice(0, 3))}.` : "";
  const tail = caveats.length > 0 ? ` Worth knowing: ${list(caveats)}.` : "";
  return `${head}${tail}`.trim();
}
