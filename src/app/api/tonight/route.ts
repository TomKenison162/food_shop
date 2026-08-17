import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { selectTonightsDinner } from "@/lib/rotation";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = requireUserParam(req);
  const result = await selectTonightsDinner(userId);
  if (!result) {
    return NextResponse.json({ meal: null, reason: "Approved queue is empty." }, { status: 200 });
  }
  return NextResponse.json(result);
}
