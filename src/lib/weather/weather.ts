/**
 * Current temperature via Open-Meteo (https://open-meteo.com) — free, no API
 * key. Returns null if WEATHER_LAT/WEATHER_LON aren't set or the call fails;
 * callers should treat a null temperature as "feature unavailable", not 0.
 */
export async function getCurrentTemperatureC(): Promise<number | null> {
  const lat = process.env.WEATHER_LAT;
  const lon = process.env.WEATHER_LON;
  if (!lat || !lon) return null;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=Europe%2FLondon`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const temp = data?.current?.temperature_2m;
    return typeof temp === "number" ? temp : null;
  } catch {
    return null;
  }
}
