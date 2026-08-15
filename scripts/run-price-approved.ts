import "dotenv/config";
import { priceApprovedMeals } from "../src/lib/pricing/priceApproved";

// This is the only place that spends real Pepesto API credits. Run it
// deliberately, after you've swiped and built your approved queue — not
// automatically from generation or the swipe deck.
priceApprovedMeals()
  .then((result) => {
    console.log(`Priced ${result.pricedMealIds.length} approved meal(s): ${result.pricedMealIds.join(", ")}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
