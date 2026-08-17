import { Resend } from "resend";
import type { RotationResult } from "../rotation";
import { buildFeedbackLink } from "../feedbackLink";
import { buildPantryMissingLink } from "../pantryLink";
import { DECLINE_LABELS, DECLINE_REASONS } from "../declineReasons";
import { getPantrySummary } from "../pantry/pantry";
import { costForPortions, WEEKLY_BUDGET_GBP } from "../budget";
import { ingredientsForMeal } from "../shoppingList";
import { dishFeatures, type DishFeatures } from "../ml/dishFeatures";
import { getUser } from "../users";

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
 * REMINDER_TO_EMAIL is now only a fallback for the alert channel. Each
 * user's reminder goes to their own address, looked up per send — a single
 * global recipient is precisely the kind of shared global that would send
 * one household member another's dinner.
 */
function mailer(to?: string): { resend: Resend; from: string; to: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_FROM_EMAIL;
  const recipient = to ?? process.env.REMINDER_TO_EMAIL;
  if (!apiKey || !from || !recipient) return null;
  return { resend: new Resend(apiKey), from, to: recipient };
}


/** "~25 min · rich · with rice". The shape of the evening, at a glance. */
function dishLine(d: DishFeatures): string {
  const time = d.effortMinutes >= 90 ? `~${Math.round(d.effortMinutes / 60)} hr` : `~${d.effortMinutes} min`;
  const richness = d.richness >= 0.5 ? "rich" : d.richness >= 0.2 ? "medium" : "light";
  const carb = d.carbBase === "none" ? "no carb" : `with ${d.carbBase}`;
  return [time, richness, carb].join(" &middot; ");
}

const META = 'style="color:#6b7280;font-size:14px"';

/**
 * A bare "yes" conflates "that was excellent" with "it was fine, I was
 * hungry", and the difference is the whole thing the model should learn.
 * Five buttons cost no more taps than one at the point of use.
 */
const RATING_LABELS = ["1 poor", "2", "3 ok", "4", "5 great"];

/**
 * London wall-clock send time, stated explicitly in the email.
 *
 * Mail clients and server logs happily show UTC, and in summer 16:00 UTC is
 * 17:00 BST, which reads like the reminder went out an hour early. Saying
 * the London time outright settles it without anyone having to work out
 * whether the clocks have changed.
 */
function sentAtLondon(date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

/**
 * The daily "cook this tonight" email — the whole product, deliberately.
 * Planning a week ahead was tried and dropped: deciding tonight's dinner
 * days in advance removes the point of a daily nudge when the shop is five
 * minutes away. So this carries everything needed to act on it right now:
 * the dish, the method, a fully priced shopping list for exactly that meal
 * (minus anything the pantry already covers), and the Yes/No links.
 */
export async function sendDinnerReminder(
  userId: number,
  result: RotationResult
): Promise<SendReminderResult> {
  const user = await getUser(userId);
  if (!user) return { sent: false, reason: `No such user: ${userId}` };
  const m = mailer(user.email);
  if (!m) {
    return {
      sent: false,
      reason: "RESEND_API_KEY / REMINDER_FROM_EMAIL / REMINDER_TO_EMAIL not fully configured yet.",
    };
  }

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const { meal, portions, cost, firstShopCost: firstShop, spentThisWeekGBP, firstShopSpentThisWeekGBP } =
    result;

  const [ingredients, pantry] = await Promise.all([ingredientsForMeal(meal.id), getPantrySummary(userId)]);
  const pantryByName = new Map(pantry.map((p) => [p.genericName, p]));

  const toBuy = ingredients.filter((i) => !pantryByName.has(i.genericName));
  const covered = ingredients.filter((i) => pantryByName.has(i.genericName));

  // Total the lines actually listed. The header used to show the meal's full
  // first-shop cost above a list with pantry-covered items removed, so it
  // billed you for things it was simultaneously telling you to skip.
  const toBuyTotal = toBuy.length
    ? toBuy.reduce((sum, i) => sum + (i.skuPrice !== null ? Number(i.skuPrice) : 0), 0)
    : null;

  const dish = dishFeatures(meal.instructions, ingredients.map((i) => i.genericName));

  // Alternatives need their ingredients too, purely to describe them — the
  // shopping list is only ever built for the meal actually being suggested.
  const altIngredients = new Map<number, string[]>(
    await Promise.all(
      result.alternatives.map(
        async (alt) =>
          [alt.id, (await ingredientsForMeal(alt.id)).map((i) => i.genericName)] as [number, string[]]
      )
    )
  );

  const line = (i: (typeof ingredients)[number]) => {
    const price = i.skuPrice !== null ? ` £${i.skuPrice}` : "";
    const estNote = i.isEstimated ? ` <em style="color:#b45309">(estimated, no product match)</em>` : "";
    return `<li>${esc(i.skuName ?? i.genericName)} (${esc(i.quantity)})${price}${estNote}</li>`;
  };

  const ingredientsHtml = toBuy.length
    ? `<ul>${toBuy.map(line).join("")}</ul>`
    : "<p>Nothing to buy. Your pantry covers it.</p>";

  /**
   * Pantry stock is inferred, not counted, so each line carries a one-tap
   * correction. An over-stated pantry is the expensive kind of wrong: the
   * shopping list leaves the item out and you get home unable to cook.
   */
  const coveredHtml = covered.length
    ? `<h2>Already in</h2><ul>${covered
        .map((i) => {
          const p = pantryByName.get(i.genericName)!;
          const missing = buildPantryMissingLink(appUrl, userId, result.planDate, i.genericName);
          return `<li>${esc(i.genericName)}, ~${p.gramsRemaining}g on hand${
            p.daysLeft !== null && p.daysLeft <= 2 ? " <strong>(use it up)</strong>" : ""
          } <a href="${missing}" style="color:#9ca3af;font-size:13px">not got it</a></li>`;
        })
        .join("")}</ul>`
    : "";

  const instructionsHtml = `<ol>${meal.instructions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;

  const date = result.planDate;

  const btn = (href: string, label: string, secondary = false) =>
    `<a href="${href}" style="display:inline-block;background:${
      secondary ? "#e5e7eb" : "#111827"
    };color:${
      secondary ? "#111827" : "#fff"
    };padding:9px 16px;text-decoration:none;border-radius:999px;margin:0 6px 6px 0;font-size:14px">${esc(
      label
    )}</a>`;

  /**
   * The alternatives are the point of this email, not garnish: picking one
   * is a direct comparison between meals offered in an identical context,
   * which is worth far more to the model than a yes/no on a single dish.
   * They're shown compactly — full method and shopping list would triple the
   * length for options that mostly won't be taken.
   */
  const alternativesHtml = result.alternatives.length
    ? `<h2>Or instead</h2>${result.alternatives
        .map((alt) => {
          const altCost = costForPortions(alt, portions);
          const link = buildFeedbackLink(appUrl, { userId, mealId: alt.id, date, action: "choose" });
          return `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:10px">
            <strong>${esc(alt.name)}</strong>${
              altCost !== null ? ` <span style="color:#6b7280">£${altCost.toFixed(2)}</span>` : ""
            }
            <div style="color:#6b7280;font-size:14px;margin:4px 0 2px">${esc(alt.description)}</div>
            <div style="color:#9ca3af;font-size:13px;margin:0 0 10px">${dishLine(
              dishFeatures(alt.instructions, altIngredients.get(alt.id) ?? [])
            )}</div>
            ${btn(link, "Cook this instead")}
          </div>`;
        })
        .join("")}`
    : "";

  /**
   * Four reasons rather than one "No". A bare refusal conflates not fancying
   * a dish with being out of the house, and a model trained on the union
   * learns neither — "not home" in particular is excluded from training
   * outright rather than recorded as dislike.
   */
  const declineHtml = `<h2>None of these?</h2><p>${DECLINE_REASONS.map((reason) =>
    btn(buildFeedbackLink(appUrl, { userId, mealId: meal.id, date, action: "decline", reason }), DECLINE_LABELS[reason], true)
  ).join("")}</p>`;

  const notes: string[] = [];
  if (result.relaxedBudgetRule) notes.push("Over budget. Everything else in your queue costs more.");
  if (result.relaxedProteinRule) notes.push("Same protein as yesterday. Nothing else avoided it.");
  if (result.relaxedRepeatRule) notes.push("Third time in 60 days. The rest of your queue is more repetitive still.");

  const html = `
    <h1>Tonight: ${esc(meal.name)}</h1>
    <p>${esc(meal.description)}</p>
    <p ${META}>
      <strong style="color:#111827">${portions} portion${portions === 2 ? "s" : ""}</strong>
      ${cost !== null ? `&middot; £${cost.toFixed(2)}` : ""}
      &middot; ${dishLine(dish)}
      &middot; ${result.useItUpMode ? "use-it-up pick" : result.usedModel ? "model's pick" : "random pick"}
    </p>
    ${result.explanation ? `<p style="font-size:15px">${esc(result.explanation)}</p>` : ""}
    ${notes.length ? `<p ${META}><em>${notes.map(esc).join(" ")}</em></p>` : ""}

    <p style="margin-bottom:4px"><strong>Cooking it? Rate it after.</strong></p>
    <p>${RATING_LABELS.map((label, i) =>
      btn(buildFeedbackLink(appUrl, { userId, mealId: meal.id, date, action: "accept", rating: i + 1 }), label, i + 1 < 4)
    ).join("")}</p>

    <h2>Method</h2>
    ${instructionsHtml}

    <h2>Shopping list${toBuyTotal !== null ? ` &middot; £${toBuyTotal.toFixed(2)}` : ""}</h2>
    ${ingredientsHtml}
    ${coveredHtml}

    ${alternativesHtml}
    ${declineHtml}

    <p ${META} style="border-top:1px solid #e5e7eb;padding-top:10px;margin-top:24px">
      Sent ${sentAtLondon()} London time.
    </p>

    <h2>This week</h2>
    <p ${META}>
      £${spentThisWeekGBP.toFixed(2)} of £${WEEKLY_BUDGET_GBP.toFixed(0)} used.
      £${firstShopSpentThisWeekGBP.toFixed(2)} at the till if you bought it all fresh.
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
