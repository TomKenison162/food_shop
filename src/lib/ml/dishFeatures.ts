/**
 * Properties of a *recipe* — how much work it is, how rich it is, what it's
 * served on — derived from the instructions and ingredient list that already
 * exist. No hand-labelling of 137 dishes, and no API.
 *
 * These exist because the model previously couldn't tell dishes apart. Its
 * only recipe-level inputs were protein, cost, tier and two counts, so a Thai
 * laksa and a roast dinner looked nearly identical: "chicken, £8, 4 steps".
 * Denser preference labels can't help a model whose inputs can't distinguish
 * the things being preferred.
 *
 * Deliberately kept to four signals rather than the dozen that were on the
 * table. Every feature is a chance to fit noise when there are only tens of
 * training rows, so cuisine (which alone wanted ~10 one-hot columns) was left
 * out in favour of the ones with an obvious behavioural story.
 */

export type CarbBase = "rice" | "pasta" | "potato" | "bread" | "none";

export const CARB_BASES: CarbBase[] = ["rice", "pasta", "potato", "bread"];

const CARB_MARKERS: { base: CarbBase; re: RegExp }[] = [
  { base: "rice", re: /\brice\b|risotto|basmati|paella/ },
  { base: "pasta", re: /pasta|spaghetti|tagliatelle|penne|rigatoni|linguine|macaroni|pappardelle|lasagne|noodles?\b/ },
  { base: "potato", re: /potato|potatoes|chips|mash\b|gnocchi/ },
  { base: "bread", re: /bread|buns?\b|rolls?\b|tortilla|flatbread|pitta|naan|wraps?\b|baguette|taco shell/ },
];

/** Fat-heavy ingredients, weighted by how much they change the character of a dish. */
const RICHNESS_MARKERS: { re: RegExp; weight: number }[] = [
  { re: /double cream|soured cream|creme fraiche/, weight: 3 },
  { re: /\bbutter\b/, weight: 2 },
  { re: /cheese|parmesan|mozzarella|cheddar|halloumi|paneer/, weight: 2 },
  { re: /coconut milk/, weight: 2 },
  { re: /bacon|lardons|chorizo|pancetta|duck fat/, weight: 2 },
  { re: /\bcream\b|\bmilk\b/, weight: 1 },
  { re: /olive oil|vegetable oil|sesame oil/, weight: 0.5 },
];

/** Explicit durations in an instruction line, in minutes. */
function statedMinutes(text: string): number[] {
  const out: number[] = [];
  const hours = text.matchAll(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi);
  for (const m of hours) out.push(Number(m[1]) * 60);
  const mins = text.matchAll(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/gi);
  for (const m of mins) out.push(Number(m[1]));
  return out;
}

/**
 * Rough hands-on-plus-waiting time for a dish, in minutes.
 *
 * Takes the *longest* stated duration rather than the sum, because recipe
 * steps overlap ("simmer 25 minutes" happens while the pasta boils), then
 * adds a small allowance per step for the work with no time attached. It is
 * a proxy, not a promise — what matters is that a 3-hour braise and a 15
 * minute stir-fry end up far apart.
 *
 * This is the feature that makes the "too much effort" decline reason
 * learnable; without it that reply is recorded and then unexplainable.
 */
export function effortMinutes(instructions: string[]): number {
  const all = instructions.join(" ");
  const stated = statedMinutes(all);
  const longest = stated.length > 0 ? Math.max(...stated) : 0;
  const perStep = 6 * instructions.length;
  return Math.round(Math.max(longest + perStep * 0.5, perStep));
}

/** 0 = lean, 1 = as rich as dishes here get. */
export function richnessScore(ingredientNames: string[]): number {
  const joined = ingredientNames.join(" ").toLowerCase();
  let score = 0;
  for (const { re, weight } of RICHNESS_MARKERS) {
    if (re.test(joined)) score += weight;
  }
  return Math.min(score / 8, 1);
}

/** What the dish is served on. "none" for salads, curries eaten alone, etc. */
export function carbBase(ingredientNames: string[]): CarbBase {
  const joined = ingredientNames.join(" ").toLowerCase();
  for (const { base, re } of CARB_MARKERS) {
    if (re.test(joined)) return base;
  }
  return "none";
}

export interface DishFeatures {
  effortMinutes: number;
  richness: number;
  carbBase: CarbBase;
}

export function dishFeatures(instructions: string[], ingredientNames: string[]): DishFeatures {
  return {
    effortMinutes: effortMinutes(instructions),
    richness: richnessScore(ingredientNames),
    carbBase: carbBase(ingredientNames),
  };
}
