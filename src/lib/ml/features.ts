import type { MealRecord } from "../rotation";

const PROTEIN_BUCKETS = ["beef", "chicken", "pork", "lamb", "fish", "other"] as const;

export interface FeatureContext {
  dayOfWeek: number; // 0=Sunday .. 6=Saturday
  isWeekend: boolean;
  temperatureC: number | null;
}

export interface MealFeatureExtras {
  pantryOverlapGrams: number;
  daysSinceLastServed: number | null; // null = never served before
}

export const FEATURE_NAMES: string[] = [
  "dayOfWeekSin",
  "dayOfWeekCos",
  "isWeekend",
  "temperature",
  "temperatureMissing",
  "costTwoPerson",
  "tier",
  ...PROTEIN_BUCKETS.map((p) => `protein_${p}`),
  "pantryOverlap",
  "daysSinceLastServed",
];

function proteinBucket(primaryProtein: string): (typeof PROTEIN_BUCKETS)[number] {
  const p = primaryProtein.toLowerCase();
  return (PROTEIN_BUCKETS as readonly string[]).includes(p)
    ? (p as (typeof PROTEIN_BUCKETS)[number])
    : "other";
}

function tierOrdinal(tier: string | null): number {
  if (tier === "budget") return 0;
  if (tier === "standard") return 0.5;
  if (tier === "gourmet") return 1;
  return 0.5; // unpriced: assume mid
}

export function buildFeatureVector(
  ctx: FeatureContext,
  meal: MealRecord,
  extras: MealFeatureExtras
): number[] {
  const angle = (ctx.dayOfWeek / 7) * 2 * Math.PI;
  const bucket = proteinBucket(meal.primaryProtein);

  const features = [
    Math.sin(angle),
    Math.cos(angle),
    ctx.isWeekend ? 1 : 0,
    ctx.temperatureC !== null ? ctx.temperatureC / 20 : 0,
    ctx.temperatureC === null ? 1 : 0,
    meal.costTwoPerson !== null ? Number(meal.costTwoPerson) / 10 : 0.5,
    tierOrdinal(meal.tier),
    ...PROTEIN_BUCKETS.map((p) => (p === bucket ? 1 : 0)),
    Math.min(extras.pantryOverlapGrams / 500, 1),
    extras.daysSinceLastServed === null ? 1 : Math.min(extras.daysSinceLastServed / 60, 1),
  ];

  return features;
}
