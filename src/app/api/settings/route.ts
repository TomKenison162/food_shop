import { NextRequest, NextResponse } from "next/server";
import { getSettings, setPausedUntil, setPortionsSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  if ("portions" in body) {
    if (body.portions !== 1 && body.portions !== 2) {
      return NextResponse.json({ error: "portions must be 1 or 2" }, { status: 400 });
    }
    await setPortionsSetting(body.portions);
  }

  if ("pausedUntil" in body) {
    const v = body.pausedUntil;
    if (v !== null && !(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) {
      return NextResponse.json({ error: "pausedUntil must be YYYY-MM-DD or null" }, { status: 400 });
    }
    await setPausedUntil(v);
  }

  return NextResponse.json({ ok: true, ...(await getSettings()) });
}
