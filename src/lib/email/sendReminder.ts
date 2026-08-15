import { Resend } from "resend";
import { db } from "../db/client";
import { eq } from "drizzle-orm";
import { mealIngredients } from "../db/schema";
import type { RotationResult } from "../rotation";
import { buildFeedbackLink } from "../feedbackLink";
import { getPantrySummary } from "../pantry/pantry";
import { WEEKLY_BUDGET_GBP } from "../budget";
import { londonDateString } from "../date";

export interface SendReminderResult {
  sent: boolean;
  reason?: string;
}

/**
 * Emails tonight's dinner: portions + price, cooking instructions and the
 * grocery shopping list as separate sections, Yes/No links that feed the
 * ML model's real training signal, what's already sitting in the pantry
 * from previous over-buys, and the running weekly spend against the £100
 * cap. No-ops (with a reason) if RESEND_API_KEY / from / to aren't set.
 */
export async function sendDinnerReminder(result: RotationResult): Promise<SendReminderResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_FROM_EMAIL;
  const to = process.env.REMINDER_TO_EMAIL;
  const appUrl = process.env.APP_URL || "http://localhost:3000";

  if (!apiKey || !from || !to) {
    return {
      sent: false,
      reason: "RESEND_API_KEY / REMINDER_FROM_EMAIL / REMINDER_TO_EMAIL not fully configured yet.",
    };
  }

  const { meal, portions, cost, context, spentThisWeekGBP } = result;

  const [ingredients, pantry] = await Promise.all([
    db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, meal.id) }),
    getPantrySummary(),
  ]);

  const resend = new Resend(apiKey);

  const pantryByName = new Map(pantry.map((p) => [p.genericName, p]));
  const usedInTonightsShop = new Set<string>();

  const shoppingListHtml = ingredients.length
    ? `<ul>${ingredients
        .map((i) => {
          const cached = pantryByName.get(i.genericName);
          const cachedNote = cached
            ? ` <strong>— likely already have ~${cached.gramsRemaining}g in your pantry, check before buying</strong>`
            : "";
          if (cached) usedInTonightsShop.add(i.genericName);
          return i.skuName && i.skuPrice
            ? `<li>${i.skuName} — £${i.skuPrice} (${i.quantity} needed)${cachedNote}</li>`
            : `<li>${i.genericName} — ${i.quantity} <em>(pricing not available yet)</em>${cachedNote}</li>`;
        })
        .join("")}</ul>`
    : "<p>No ingredient data recorded for this meal.</p>";

  const instructionsHtml = `<ol>${meal.instructions.map((step) => `<li>${step}</li>`).join("")}</ol>`;

  const otherPantryItems = pantry.filter((p) => !usedInTonightsShop.has(p.genericName));
  const pantryHtml = otherPantryItems.length
    ? `<ul>${otherPantryItems
        .map(
          (p) =>
            `<li>${p.genericName} — ~${p.gramsRemaining}g left (roughly ${p.estimatedPortionsRemaining} portion(s)), from a previous over-buy</li>`
        )
        .join("")}</ul>`
    : "<p>Nothing else sitting unused right now.</p>";

  const linkParams = {
    mealId: meal.id,
    date: londonDateString(),
    dayOfWeek: context.dayOfWeek,
    isWeekend: context.isWeekend,
    temperatureC: context.temperatureC,
  };
  const yesLink = buildFeedbackLink(appUrl, { ...linkParams, accepted: true });
  const noLink = buildFeedbackLink(appUrl, { ...linkParams, accepted: false });

  const notes: string[] = [];
  if (result.relaxedBudgetRule) notes.push("This went over the usual weekly budget cap — every other option in your queue would have gone over further.");
  if (result.relaxedProteinRule) notes.push("This repeats yesterday's protein — nothing else in your queue avoided it today.");
  if (result.relaxedRepeatRule) notes.push("This meal has already been served twice in the last 60 days — the rest of your queue was too repetitive to pick from.");

  const html = `
    <h1>Tonight's dinner: ${meal.name}</h1>
    <p>${meal.description}</p>
    <p><strong>${portions} portion${portions === 2 ? "s" : ""}</strong> — ${cost !== null ? `£${cost.toFixed(2)}` : "price not available yet"}</p>
    ${notes.length ? `<p><em>${notes.join(" ")}</em></p>` : ""}

    <p>
      <a href="${yesLink}" style="background:#111827;color:#fff;padding:10px 20px;text-decoration:none;border-radius:999px;margin-right:8px;">Yes, cooking this</a>
      <a href="${noLink}" style="background:#e5e7eb;color:#111827;padding:10px 20px;text-decoration:none;border-radius:999px;">No, not tonight</a>
    </p>

    <h2>Cooking instructions</h2>
    ${instructionsHtml}

    <h2>Shopping list</h2>
    ${shoppingListHtml}

    <h2>Other pantry leftovers</h2>
    ${pantryHtml}

    <h2>This week</h2>
    <p>£${spentThisWeekGBP.toFixed(2)} of your £${WEEKLY_BUDGET_GBP.toFixed(2)} weekly budget spent so far (trailing 7 days).</p>
  `;

  const { error } = await resend.emails.send({
    from,
    to,
    subject: `Tonight's dinner: ${meal.name}`,
    html,
  });

  if (error) {
    return { sent: false, reason: error.message };
  }
  return { sent: true };
}
