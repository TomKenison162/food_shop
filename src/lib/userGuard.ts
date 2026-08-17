/**
 * The multi-user guard, kept free of database imports so it can be tested
 * on its own — the same split the repo already uses between budget.ts (pure
 * rules) and budgetSpend.ts (queries).
 *
 * Every table expressing a preference or a history is scoped to a user; the
 * recipe catalogue is not. The danger in that arrangement is not difficulty,
 * it is silence: one query that forgets its filter lets a person rate
 * someone else's meals or drain their pantry, and nothing visibly breaks for
 * weeks.
 *
 * So nothing is allowed to be quiet about it:
 *  - the columns are NOT NULL with no database default, so Postgres rejects
 *    a forgotten user rather than defaulting to user 1
 *  - every per-user function takes `userId` as a required argument, so a
 *    forgotten user is a compile error
 *  - this catches whatever survives both, and names the caller
 *
 * There is deliberately no "current user" global and no fallback. Code that
 * cannot say who it acts for is a bug, not a default.
 */
export function requireUserId(userId: number | null | undefined, context: string): number {
  if (userId === null || userId === undefined || !Number.isInteger(userId) || userId <= 0) {
    throw new Error(
      `Missing or invalid userId in ${context}. Every per-user query must name its user explicitly; ` +
        `there is no default, because defaulting would silently write into someone else's data.`
    );
  }
  return userId;
}
