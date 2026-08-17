import "dotenv/config";
import { db } from "../src/lib/db/client";
import { pantryItems } from "../src/lib/db/schema";
import { getPantrySummary } from "../src/lib/pantry/pantry";
import { activeUsers } from "../src/lib/users";

/**
 * Empties the pantry.
 *
 * Needed once because leftovers used to be banked at *plan* time rather than
 * when a meal was confirmed cooked, so every declined and superseded
 * suggestion stocked it too. Staples that appear in nearly every recipe
 * (salt and pepper, olive oil, garlic) accumulated to absurd quantities and
 * were then wrongly listed as "skip these — already in".
 *
 * Safe to re-run any time you want to declare the pantry genuinely empty;
 * nothing else references these rows.
 */
async function main() {
  // Every user's pantry, since this is a maintenance script rather than
  // something acting on one person's behalf.
  const users = await activeUsers();
  const before = (await Promise.all(users.map((u) => getPantrySummary(u.id)))).flat();
  if (before.length === 0) {
    console.log("Pantry is already empty.");
  } else {
    console.log(`Clearing ${before.length} pantry entries:`);
    for (const item of before) {
      console.log(`  - ${item.genericName}: ${item.gramsRemaining}g`);
    }
    await db.delete(pantryItems);
    console.log("\nDone. The pantry now rebuilds only from meals you reply Yes to.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
