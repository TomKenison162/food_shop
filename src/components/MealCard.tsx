import { Meal } from "@/lib/types";

const TIER_STYLES: Record<string, string> = {
  budget: "bg-tier-budget/20 text-tier-budget border-tier-budget/40",
  standard: "bg-tier-standard/20 text-tier-standard border-tier-standard/40",
  gourmet: "bg-tier-gourmet/20 text-tier-gourmet border-tier-gourmet/40",
};

interface Props {
  meal: Meal;
  portions: 1 | 2;
}

export default function MealCard({ meal, portions }: Props) {
  // Headline number is the marginal cost — what cooking it actually uses.
  // First-shop cost is shown underneath, since it's only what you pay the
  // first time, before you have staples in.
  const cost = portions === 1 ? meal.costMarginalOnePerson : meal.costMarginalTwoPerson;
  const firstShop = portions === 1 ? meal.costFirstShopOnePerson : meal.costFirstShopTwoPerson;
  const tierLabel = meal.tier ? meal.tier[0].toUpperCase() + meal.tier.slice(1) : "Pricing pending";
  const tierClass = meal.tier ? TIER_STYLES[meal.tier] : "bg-gray-700/40 text-gray-300 border-gray-600";

  return (
    <div className="w-full h-full rounded-3xl bg-gray-900 border border-gray-800 shadow-2xl flex flex-col p-6 select-none">
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold px-3 py-1 rounded-full border ${tierClass}`}>
          {tierLabel}
        </span>
        <span className="text-sm text-gray-400">{meal.primaryProtein}</span>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3">
        <h2 className="text-2xl font-bold leading-tight">{meal.name}</h2>
        <p className="text-gray-400 text-sm">{meal.description}</p>
      </div>

      <div className="flex items-end justify-between">
        <span className="text-xs text-gray-500">
          {portions} {portions === 1 ? "portion" : "portions"}
        </span>
        <div className="text-right">
          <div className="text-3xl font-bold">{cost ? `£${cost}` : "—"}</div>
          {firstShop && (
            <div className="text-xs text-gray-500">£{firstShop} first shop</div>
          )}
        </div>
      </div>
    </div>
  );
}
