/**
 * Why a suggestion was turned down.
 *
 * Pure data, no DB import, so both the email builder and the model can use
 * it. The set is deliberately tiny: every extra button costs a tap on a
 * phone, and four reasons already separate the cases that matter.
 */
export const DECLINE_REASONS = ["not_in_mood", "too_pricey", "too_much_effort", "not_home"] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];

export function isDeclineReason(v: string): v is DeclineReason {
  return (DECLINE_REASONS as readonly string[]).includes(v);
}

/** Button copy for the daily email. */
export const DECLINE_LABELS: Record<DeclineReason, string> = {
  not_in_mood: "Not in the mood",
  too_pricey: "Too pricey",
  too_much_effort: "Too much effort",
  not_home: "Not home tonight",
};

/**
 * Whether a decline says anything about the *meal*.
 *
 * "Not home" is a fact about the evening, not a judgement of the food —
 * training on it teaches the model to dislike whatever it happened to
 * suggest while you were out, which is how a week away used to poison the
 * whole model. It's recorded (it's still useful for spotting patterns in
 * when you're away) but never becomes a training label.
 */
export function isPreferenceSignal(reason: DeclineReason | null): boolean {
  return reason !== "not_home";
}
