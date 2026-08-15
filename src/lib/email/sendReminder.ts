import { Resend } from "resend";
import { db } from "../db/client";
import { eq } from "drizzle-orm";
import { mealIngredients } from "../db/schema";
import type { RotationResult } from "../rotation";
import { buildFeedbackLink } from "../feedbackLink";
import { getPantrySummary } from "../pantry/pantry";
import { WEEKLY_BUDGET_GBP, firstShopCostForPortions } from "../budget";
import { londonDateString } from "../date";

export interface SendReminderResult {
  sent: boolean;
  reason?: string;
}

/** Minimal HTML escaping for interpolated content. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Emails tonight's dinner: portions and both costs, cooking instructions,
 * the shopping list (flagging anything already in the pantry or priced by
 * estimate), Yes/No links that feed the ML model's training signal, and the
 * running weekly spend against the budget. No-ops (with a reason) if
 * RESEND_API_KEY / from / to aren't set.
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

  const { meal, portions, cost, spentThisWeekGBP } = result;

  const [ingredients, pantry] = await Promise.all([
    db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, meal.id) }),
    getPantrySummary(),
  ]);

  const resend = new Resend(apiKey);

  const pantryByName = new Map(pantry.map((p) => [p.genericName, p]));
  const coveredByPantry = new Set<string>();

  const shoppingListHtml = ingredients.length
    ? `<ul>${ingredients
        .map((i) => {
          const cached = pantryByName.get(i.genericName);
          if (cached) coveredByPantry.add(i.genericName);
          const cachedNote = cached
            ? ` <strong>— likely already have ~${cached.gramsRemaining}g, check before buying</strong>`
            : "";
          const estimatedNote = i.isEstimated
            ? ` <em style="color:#b45309">(estimated price — no product match)</em>`
            : "";
          const label = i.skuName ? esc(i.skuName) : esc(i.genericName);
          const price = i.skuPrice !== null ? `£${i.skuPrice}` : "price unavailable";
          return `<li>${label} — ${price} (${esc(i.quantity)} needed)${cachedNote}${estimatedNote}</li>`;
        })
        .join("")}</ul>`
    : "<p>No ingredient data recorded for this meal.</p>";

  const instructionsHtml = `<ol>${meal.instructions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;

  const otherPantry = pantry.filter((p) => !coveredByPantry.has(p.genericName));
  const pantryHtml = otherPantry.length
    ? `<ul>${otherPantry
        .map(
          (p) =>
            `<li>${esc(p.genericName)} — ~${p.gramsRemaining}g left (roughly ${p.estimatedPortionsRemaining} portion(s))</li>`
        )
        .join("")}</ul>`
    : "<p>Nothing else sitting unused right now.</p>";

  const linkParams = { mealId: meal.id, date: londonDateString() };
  const yesLink = buildFeedbackLink(appUrl, { ...linkParams, accepted: true });
  const noLink = buildFeedbackLink(appUrl, { ...linkParams, accepted: false });

  const firstShop = firstShopCostForPortions(meal, portions);

  const notes: string[] = [];
  if (result.relaxedBudgetRule)
    notes.push("This goes over the weekly budget — every other option in your queue would have gone over further.");
  if (result.relaxedProteinRule)
    notes.push("This repeats yesterday's protein — nothing else in your queue avoided it today.");
  if (result.relaxedRepeatRule)
    notes.push("This has already been served twice in the last 60 days — the rest of your queue was too repetitive to pick from.");

  const html = `
    <h1>Tonight's dinner: ${esc(meal.name)}</h1>
    <p>${esc(meal.description)}</p>
    <p>
      <strong>${portions} portion${portions === 2 ? "s" : ""}</strong> —
      ${cost !== null ? `£${cost.toFixed(2)} of ingredients used` : "cost unavailable"}
      ${firstShop !== null ? `<br><span style="color:#6b7280">£${firstShop.toFixed(2)} if you're buying everything fresh</span>` : ""}
    </p>
    ${notes.length ? `<p><em>${notes.map(esc).join(" ")}</em></p>` : ""}

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
    <p>£${spentThisWeekGBP.toFixed(2)} of your £${WEEKLY_BUDGET_GBP.toFixed(2)} weekly budget used (week resets Monday).</p>
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

/** Alerts on a failed daily run, so a broken cron isn't silent. */
export async function sendFailureAlert(message: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_FROM_EMAIL;
  const to = process.env.REMINDER_TO_EMAIL;
  if (!apiKey || !from || !to) return;

  try {
    await new Resend(apiKey).emails.send({
      from,
      to,
      subject: "Food Shop: tonight's dinner email failed",
      html: `<p>The daily reminder job failed:</p><pre>${esc(message)}</pre>`,
    });
  } catch {
    // Nothing more we can do — the alert channel itself is down.
  }
}
