import { NextRequest } from "next/server";

/**
 * Reads `?user=` and refuses the request without it.
 *
 * There is deliberately no fallback to user 1. A route that quietly assumed
 * a user would be indistinguishable from one that works, right up until it
 * wrote somebody else's approval or drained somebody else's pantry — so the
 * failure is made immediate and obvious instead.
 */
export function requireUserParam(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("user");
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new UserParamError();
  }
  return id;
}

export class UserParamError extends Error {
  constructor() {
    super("Missing or invalid ?user= parameter. Every per-user route must name its user explicitly.");
    this.name = "UserParamError";
  }
}
