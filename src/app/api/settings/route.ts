import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { pauseUntil, setPortionsSetting } from "@/lib/settings";
import { getUser } from "@/lib/users";

export const dynamic = "force-dynamic";

async function settingsFor(userId: number) {
  const user = await getUser(userId);
  if (!user) return null;
  return { userId: user.id, name: user.name, portions: user.portions, pausedUntil: user.pausedUntil };
}

export async function GET(req: NextRequest) {
  const userId = requireUserParam(req);
  const settings = await settingsFor(userId);
  if (!settings) return NextResponse.json({ error: `No such user: ${userId}` }, { status: 404 });
  return NextResponse.json(settings);
}

export async function POST(req: NextRequest) {
  const userId = requireUserParam(req);
  const body = await req.json().catch(() => ({}));

  if ("portions" in body) {
    if (body.portions !== 1 && body.portions !== 2) {
      return NextResponse.json({ error: "portions must be 1 or 2" }, { status: 400 });
    }
    await setPortionsSetting(userId, body.portions);
  }

  if ("pausedUntil" in body) {
    const v = body.pausedUntil;
    if (v !== null && !(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) {
      return NextResponse.json({ error: "pausedUntil must be YYYY-MM-DD or null" }, { status: 400 });
    }
    await pauseUntil(userId, v);
  }

  return NextResponse.json({ ok: true, ...(await settingsFor(userId)) });
}
