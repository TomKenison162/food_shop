/**
 * Why a suggestion was turned down.
 *
 * Pure data, no DB import, so both the email builder and the model can use
 * it. The set is deliberately tiny: every extra button costs a tap on a
 * phone, and four reasons already separate the cases that matter.
 */
export const DECLINE_REASONS = [
  "not_in_mood",
  "too_pricey",
  "too_much_effort",
  "have_leftovers",
  "not_home",
] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];

export function isDeclineReason(v: string): v is DeclineReason {
  return (DECLINE_REASONS as readonly string[]).includes(v);
}

/** Button copy for the daily email. */
export const DECLINE_LABELS: Record<DeclineReason, string> = {
  not_in_mood: "Not in the mood",
  too_pricey: "Too pricey",
  too_much_effort: "Too much effort",
  have_leftovers: "Got leftovers",
  not_home: "Not home tonight",
};

/**
 * Whether a decline says anything about the *meal*.
 *
 * "Not home" is a fact about the evening, not a judgement of the food:
 * training on it teaches the model to dislike whatever it happened to
 * suggest while you were out, which is how a week away used to poison the
 * whole model. "Got leftovers" is the same shape of non-signal, and is in
 * fact usually a sign the *previous* meal went well. Both are recorded,
 * because when you have leftovers is a real pattern, but neither ever
 * becomes a training label about the meal being turned down.
 */
export function isPreferenceSignal(reason: DeclineReason | null): boolean {
  return reason !== "not_home" && reason !== "have_leftovers";
}

/**
 * Reasons where suggesting a replacement is pointless: dinner is already
 * settled, just not by us. Offering another dish to someone who is out, or
 * who is about to eat yesterday's chilli, is noise.
 */
export function wantsReplacement(reason: DeclineReason): boolean {
  return reason !== "not_home" && reason !== "have_leftovers";
}
