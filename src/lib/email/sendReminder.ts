import { Resend } from "resend";
import type { RotationResult } from "../rotation";
import { buildFeedbackLink } from "../feedbackLink";
import { getPantrySummary } from "../pantry/pantry";
import { WEEKLY_BUDGET_GBP } from "../budget";
import { ingredientsForMeal } from "../shoppingList";

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

function mailer(): { resend: Resend; from: string; to: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_FROM_EMAIL;
  const to = process.env.REMINDER_TO_EMAIL;
  if (!apiKey || !from || !to) return null;
  return { resend: new Resend(apiKey), from, to };
}

/**
 * The daily "cook this tonight" email — the whole product, deliberately.
 * Planning a week ahead was tried and dropped: deciding tonight's dinner
 * days in advance removes the point of a daily nudge when the shop is five
 * minutes away. So this carries everything needed to act on it right now:
 * the dish, the method, a fully priced shopping list for exactly that meal
 * (minus anything the pantry already covers), and the Yes/No links.
 */
export async function sendDinnerReminder(result: RotationResult): Promise<SendReminderResult> {
  const m = mailer();
  if (!m) {
    return {
      sent: false,
      reason: "RESEND_API_KEY / REMINDER_FROM_EMAIL / REMINDER_TO_EMAIL not fully configured yet.",
    };
  }

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const { meal, portions, cost, firstShopCost: firstShop, spentThisWeekGBP, firstShopSpentThisWeekGBP } =
    result;

  const [ingredients, pantry] = await Promise.all([ingredientsForMeal(meal.id), getPantrySummary()]);
  const pantryByName = new Map(pantry.map((p) => [p.genericName, p]));

  const toBuy = ingredients.filter((i) => !pantryByName.has(i.genericName));
  const covered = ingredients.filter((i) => pantryByName.has(i.genericName));

  const line = (i: (typeof ingredients)[number]) => {
    const price = i.skuPrice !== null ? ` — £${i.skuPrice}` : "";
    const estNote = i.isEstimated
      ? ` <em style="color:#b45309">(estimated price — no product match)</em>`
      : "";
    return `<li>${esc(i.skuName ?? i.genericName)} (${esc(i.quantity)})${price}${estNote}</li>`;
  };

  const ingredientsHtml = toBuy.length
    ? `<ul>${toBuy.map(line).join("")}</ul>`
    : "<p>Nothing to buy — your pantry covers this one.</p>";

  const coveredHtml = covered.length
    ? `<h2>Skip these — already in</h2><ul>${covered
        .map((i) => {
          const p = pantryByName.get(i.genericName)!;
          return `<li>${esc(i.genericName)} — ~${p.gramsRemaining}g on hand${
            p.daysLeft !== null && p.daysLeft <= 2 ? " <strong>(use it up)</strong>" : ""
          }</li>`;
        })
        .join("")}</ul>`
    : "";

  const instructionsHtml = `<ol>${meal.instructions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;

  const linkParams = { mealId: meal.id, date: result.planDate };
  const yesLink = buildFeedbackLink(appUrl, { ...linkParams, accepted: true });
  const noLink = buildFeedbackLink(appUrl, { ...linkParams, accepted: false });

  const notes: string[] = [];
  if (result.relaxedBudgetRule)
    notes.push("This goes over the weekly budget — every other option in your queue would have gone over further.");
  if (result.relaxedProteinRule)
    notes.push("This repeats yesterday's protein — nothing else in your queue avoided it today.");
  if (result.relaxedRepeatRule)
    notes.push("This has already been served twice in the last 60 days — the rest of your queue was too repetitive to pick from.");

  const html = `
    <h1>Tonight: ${esc(meal.name)}</h1>
    <p>${esc(meal.description)}</p>
    <p>
      <strong>${portions} portion${portions === 2 ? "s" : ""}</strong> —
      ${cost !== null ? `£${cost.toFixed(2)} of ingredients used` : "cost unavailable"}
    </p>
    ${notes.length ? `<p><em>${notes.map(esc).join(" ")}</em></p>` : ""}

    <p>
      <a href="${yesLink}" style="background:#111827;color:#fff;padding:10px 20px;text-decoration:none;border-radius:999px;margin-right:8px;">Yes, cooking this</a>
      <a href="${noLink}" style="background:#e5e7eb;color:#111827;padding:10px 20px;text-decoration:none;border-radius:999px;">No — suggest another</a>
    </p>
    <p style="color:#6b7280;font-size:13px">Tapping "No" picks you a different dinner straight away.</p>

    <h2>Method</h2>
    ${instructionsHtml}

    <h2>Shopping list${firstShop !== null ? ` — £${firstShop.toFixed(2)}` : ""}</h2>
    ${ingredientsHtml}
    ${coveredHtml}

    <h2>This week</h2>
    <p>
      £${spentThisWeekGBP.toFixed(2)} of £${WEEKLY_BUDGET_GBP.toFixed(2)} budget used (food consumed).<br>
      <span style="color:#6b7280">£${firstShopSpentThisWeekGBP.toFixed(2)} is the till total if you bought everything fresh.</span>
    </p>
  `;

  const { error } = await m.resend.emails.send({
    from: m.from,
    to: m.to,
    subject: `Tonight: ${meal.name}`,
    html,
  });

  return error ? { sent: false, reason: error.message } : { sent: true };
}


/** Alerts on a failed daily run, so a broken cron isn't silent. */
export async function sendFailureAlert(message: string): Promise<void> {
  const m = mailer();
  if (!m) return;
  try {
    await m.resend.emails.send({
      from: m.from,
      to: m.to,
      subject: "Food Shop: a scheduled job failed",
      html: `<p>The scheduled job failed:</p><pre>${esc(message)}</pre>`,
    });
  } catch {
    // Nothing more we can do — the alert channel itself is down.
  }
}
