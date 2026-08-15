import { Resend } from "resend";
import { db } from "../db/client";
import { eq } from "drizzle-orm";
import { mealIngredients } from "../db/schema";
import type { MealRecord } from "../rotation";

export interface SendReminderResult {
  sent: boolean;
  reason?: string;
}

/**
 * Emails tonight's dinner: cooking instructions and the grocery shopping
 * list (SKU + price where priced) as two clearly separate sections.
 * No-ops (with a reason) if RESEND_API_KEY / from / to aren't configured yet.
 */
export async function sendDinnerReminder(meal: MealRecord): Promise<SendReminderResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_FROM_EMAIL;
  const to = process.env.REMINDER_TO_EMAIL;

  if (!apiKey || !from || !to) {
    return {
      sent: false,
      reason: "RESEND_API_KEY / REMINDER_FROM_EMAIL / REMINDER_TO_EMAIL not fully configured yet.",
    };
  }

  const ingredients = await db.query.mealIngredients.findMany({
    where: eq(mealIngredients.mealId, meal.id),
  });

  const resend = new Resend(apiKey);

  const shoppingListHtml = ingredients.length
    ? `<ul>${ingredients
        .map((i) =>
          i.skuName && i.skuPrice
            ? `<li>${i.skuName} — £${i.skuPrice} (${i.quantity} needed) [SKU: ${i.skuName}]</li>`
            : `<li>${i.genericName} — ${i.quantity} <em>(pricing not available yet)</em></li>`
        )
        .join("")}</ul>`
    : "<p>No ingredient data recorded for this meal.</p>";

  const instructionsHtml = `<ol>${meal.instructions.map((step) => `<li>${step}</li>`).join("")}</ol>`;

  const html = `
    <h1>Tonight's dinner: ${meal.name}</h1>
    <p>${meal.description}</p>
    <h2>Cooking instructions</h2>
    ${instructionsHtml}
    <h2>Shopping list</h2>
    ${shoppingListHtml}
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
