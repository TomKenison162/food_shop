export interface CurrentWeather {
  /** Air temperature, °C. */
  temperatureC: number | null;
  /**
   * "Feels like" temperature, °C — wind chill and humidity folded in. This
   * is what actually decides whether you want a stew, not the raw reading:
   * 8°C still and sunny and 8°C wet and blowing are the same number and
   * completely different evenings.
   */
  apparentTemperatureC: number | null;
  /** Precipitation in the last hour, mm. */
  precipitationMm: number | null;
}

const EMPTY: CurrentWeather = {
  temperatureC: null,
  apparentTemperatureC: null,
  precipitationMm: null,
};

/**
 * Current conditions via Open-Meteo (https://open-meteo.com) — free, no API
 * key, and all three fields come from the single call that used to fetch
 * temperature alone, so the extra signal costs nothing.
 *
 * Returns nulls if WEATHER_LAT/WEATHER_LON aren't set or the call fails;
 * callers must treat null as "feature unavailable", never as 0 — a missing
 * reading is not a freezing day, and 0mm of rain is not the same as not
 * knowing whether it rained.
 */
export async function getCurrentWeather(): Promise<CurrentWeather> {
  const lat = process.env.WEATHER_LAT;
  const lon = process.env.WEATHER_LON;
  if (!lat || !lon) return EMPTY;

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,precipitation&timezone=Europe%2FLondon`;
    const res = await fetch(url);
    if (!res.ok) return EMPTY;
    const data = await res.json();
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      temperatureC: num(data?.current?.temperature_2m),
      apparentTemperatureC: num(data?.current?.apparent_temperature),
      precipitationMm: num(data?.current?.precipitation),
    };
  } catch {
    return EMPTY;
  }
}

/** Back-compat helper for callers that only care about the air temperature. */
export async function getCurrentTemperatureC(): Promise<number | null> {
  return (await getCurrentWeather()).temperatureC;
}
