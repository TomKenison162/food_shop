import { NextRequest, NextResponse } from "next/server";
import { priceApprovedMeals } from "@/lib/pricing/priceApproved";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Prices every approved-but-unpriced meal. This is the only user-facing
 * trigger for real pricing-API spend, so it requires an explicit
 * `{"confirm": true}` body rather than firing on a bare POST — a small
 * guard against accidental/automated hits given this costs real money.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== true) {
    return NextResponse.json(
      { error: "POST { confirm: true } to price your approved queue. This spends real API credits." },
      { status: 400 }
    );
  }

  try {
    const result = await priceApprovedMeals();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
