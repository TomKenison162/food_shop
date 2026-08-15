import { NextResponse } from "next/server";
import { trainModel } from "@/lib/ml/model";

export async function POST() {
  const result = await trainModel();
  return NextResponse.json(result);
}
