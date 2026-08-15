import { NextResponse } from "next/server";
import { trainModel } from "@/lib/ml/model";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await trainModel();
  return NextResponse.json(result);
}
