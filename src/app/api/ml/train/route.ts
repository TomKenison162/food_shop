import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { trainModel } from "@/lib/ml/model";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const userId = requireUserParam(req);
  const result = await trainModel(userId);
  return NextResponse.json(result);
}
