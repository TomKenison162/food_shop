export type Tier = "budget" | "standard" | "gourmet";

/** Shape of a meal row as it comes back over JSON from the API routes. */
export interface Meal {
  id: number;
  name: string;
  description: string;
  instructions: string[];
  primaryProtein: string;
  costOnePerson: string | null;
  costTwoPerson: string | null;
  tier: Tier | null;
  isClassic: boolean;
  createdAt: string;
}
