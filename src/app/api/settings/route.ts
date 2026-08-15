import { NextRequest, NextResponse } from "next/server";
import { getPortionsSetting, setPortionsSetting } from "@/lib/settings";

export async function GET() {
  const portions = await getPortionsSetting();
  return NextResponse.json({ portions });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.portions !== 1 && body.portions !== 2) {
    return NextResponse.json({ error: "portions must be 1 or 2" }, { status: 400 });
  }
  await setPortionsSetting(body.portions);
  return NextResponse.json({ ok: true });
}
