import type { MealRecord } from "../rotationDecision";
import { CARB_BASES, type DishFeatures } from "./dishFeatures";

const PROTEIN_BUCKETS = ["beef", "chicken", "pork", "lamb", "fish", "other"] as const;

export interface FeatureContext {
  dayOfWeek: number; // 0=Sunday .. 6=Saturday
  isWeekend: boolean;
  temperatureC: number | null;
  /**
   * "Feels like" temperature. Falls back to temperatureC for rows recorded
   * before this was captured, so historical examples stay usable.
   */
  apparentTemperatureC?: number | null;
  /** Precipitation, mm. Null means unknown, which is not the same as dry. */
  precipitationMm?: number | null;
}

export interface MealFeatureExtras {
  pantryOverlapGrams: number;
  /** Recency of this exact meal. null = never served before. */
  daysSinceLastServed: number | null;
  /** Recency of *any* meal sharing this protein — broader than daysSinceLastServed, supports protein-variety reasoning beyond the hard yesterday-exclusion rule. null = never served. */
  proteinDaysSinceLastServed: number | null;
  ingredientsCount: number;
  /** Recipe-level character; see src/lib/ml/dishFeatures.ts. Omitted when ingredients aren't to hand. */
  dish?: DishFeatures;
}

export const FEATURE_NAMES: string[] = [
  "dayOfWeekSin",
  "dayOfWeekCos",
  "isWeekend",
  "feelsLike",
  "temperatureMissing",
  "isWet",
  "costTwoPerson",
  "tier",
  ...PROTEIN_BUCKETS.map((p) => `protein_${p}`),
  "pantryOverlap",
  "daysSinceLastServed",
  "proteinDaysSinceLastServed",
  "instructionsCount",
  "ingredientsCount",
  "isClassic",
  "effortMinutes",
  "richness",
  ...CARB_BASES.map((c) => `carb_${c}`),
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

  // Prefer the feels-like reading, falling back to air temperature so rows
  // snapshotted before apparent temperature was captured still contribute.
  const feels = ctx.apparentTemperatureC ?? ctx.temperatureC;
  const dish = extras.dish;

  return [
    Math.sin(angle),
    Math.cos(angle),
    ctx.isWeekend ? 1 : 0,
    feels !== null && feels !== undefined ? feels / 20 : 0,
    feels === null || feels === undefined ? 1 : 0,
    // Unknown precipitation is encoded as 0 alongside genuinely dry, because
    // a third state would cost another column for very little: rain is only
    // missing when the whole weather call failed, which also nulls the
    // temperature and is already flagged by temperatureMissing.
    ctx.precipitationMm !== null && ctx.precipitationMm !== undefined && ctx.precipitationMm > 0 ? 1 : 0,
    meal.costMarginalTwoPerson !== null ? Number(meal.costMarginalTwoPerson) / 10 : 0.5,
    tierOrdinal(meal.tier),
    ...PROTEIN_BUCKETS.map((p) => (p === bucket ? 1 : 0)),
    Math.min(extras.pantryOverlapGrams / 500, 1),
    extras.daysSinceLastServed === null ? 1 : Math.min(extras.daysSinceLastServed / 60, 1),
    extras.proteinDaysSinceLastServed === null
      ? 1
      : Math.min(extras.proteinDaysSinceLastServed / 14, 1),
    Math.min(meal.instructions.length / 10, 1),
    Math.min(extras.ingredientsCount / 10, 1),
    meal.isClassic ? 1 : 0,
    // Scaled by 3 hours: a stir-fry sits near 0, a long braise near 1.
    dish ? Math.min(dish.effortMinutes / 180, 1) : 0.3,
    dish ? dish.richness : 0.5,
    ...CARB_BASES.map((c) => (dish?.carbBase === c ? 1 : 0)),
  ];
}
