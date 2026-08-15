import { NextResponse } from "next/server";
import { getCurrentTemperatureC } from "@/lib/weather/weather";

export const dynamic = "force-dynamic";

export async function GET() {
  const temperatureC = await getCurrentTemperatureC();
  return NextResponse.json({ temperatureC });
}
