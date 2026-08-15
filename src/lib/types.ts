export type Tier = "budget" | "standard" | "gourmet";

/** Shape of a meal row as it comes back over JSON from the API routes. */
export interface Meal {
  id: number;
  name: string;
  description: string;
  instructions: string[];
  primaryProtein: string;
  /** What a first shop costs (whole packs). Doesn't halve for one person. */
  costFirstShopOnePerson: string | null;
  costFirstShopTwoPerson: string | null;
  /** Prorated cost of what the dish actually consumes — drives tier and budget. */
  costMarginalOnePerson: string | null;
  costMarginalTwoPerson: string | null;
  tier: Tier | null;
  isClassic: boolean;
  createdAt: string;
  deletedAt: string | null;
}
