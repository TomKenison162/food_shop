import { NextResponse } from "next/server";
import { selectTonightsDinner } from "@/lib/rotation";

export async function GET() {
  const result = await selectTonightsDinner();
  if (!result) {
    return NextResponse.json({ meal: null, reason: "Approved queue is empty." }, { status: 200 });
  }
  return NextResponse.json(result);
}
