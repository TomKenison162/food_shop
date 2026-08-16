/**
 * Pure derivations for the event log. No API calls, no network, no user
 * interaction — everything here is computed from the clock, the database, or
 * arithmetic.
 *
 * Deliberately NOT filtered by whether a field seems useful. Whether
 * something matters is unknowable before there's data to test it against,
 * and the asymmetry is stark: an unrecorded field is lost forever, while a
 * useless one costs a few bytes. So the rule is simply "if it's free and
 * local, record it".
 *
 * Nothing here feeds the model. See src/lib/ml/features.ts for the small,
 * deliberately narrow set that does.
 */

/** UK bank holidays (England & Wales). Static table, no API. */
const BANK_HOLIDAYS = new Set([
  "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-05", "2025-05-26",
  "2025-08-25", "2025-12-25", "2025-12-26",
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25",
  "2026-08-31", "2026-12-25", "2026-12-28",
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31",
  "2027-08-30", "2027-12-27", "2027-12-28",
]);

const SEASONS = ["winter", "winter", "spring", "spring", "spring", "summer",
                 "summer", "summer", "autumn", "autumn", "autumn", "winter"];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Days to the nearest bank holiday in either direction, searching a year out. */
function bankHolidayDistance(d: Date): { next: number | null; previous: number | null } {
  let next: number | null = null;
  let previous: number | null = null;
  for (let i = 0; i <= 365; i++) {
    if (next === null) {
      const f = new Date(d);
      f.setDate(f.getDate() + i);
      if (BANK_HOLIDAYS.has(iso(f))) next = i;
    }
    if (previous === null) {
      const b = new Date(d);
      b.setDate(b.getDate() - i);
      if (BANK_HOLIDAYS.has(iso(b))) previous = i;
    }
    if (next !== null && previous !== null) break;
  }
  return { next, previous };
}

/** Moon phase 0..1 (0 = new, 0.5 = full). Pure arithmetic. */
function moonPhase(d: Date): number {
  const synodic = 29.530588853;
  const known = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
  const days = (d.getTime() - known) / 86_400_000;
  return ((days % synodic) + synodic) % synodic / synodic;
}

/** True when Europe/London is on BST rather than GMT. */
function isBritishSummerTime(d: Date): boolean {
  const jan = new Date(d.getFullYear(), 0, 1).toLocaleString("en-GB", { timeZone: "Europe/London", timeZoneName: "short" });
  const now = d.toLocaleString("en-GB", { timeZone: "Europe/London", timeZoneName: "short" });
  return jan.slice(-3) !== now.slice(-3);
}

/**
 * Everything the clock and a static calendar can tell us. Around 30 fields,
 * none of which requires a request to anything.
 */
export function timeFacts(now: Date) {
  const london = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const y = london.getFullYear();
  const m = london.getMonth();
  const startOfYear = new Date(y, 0, 1);
  const dayOfYear = Math.floor((london.getTime() - startOfYear.getTime()) / 86_400_000) + 1;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const dow = london.getDay();
  const bh = bankHolidayDistance(london);

  return {
    iso: now.toISOString(),
    unixSeconds: Math.floor(now.getTime() / 1000),
    londonDate: iso(london),
    year: y,
    month: m + 1,
    quarter: Math.floor(m / 3) + 1,
    dayOfMonth: london.getDate(),
    daysInMonth,
    dayOfYear,
    weekOfYear: Math.ceil(dayOfYear / 7),
    dayOfWeek: dow,
    dayName: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][dow],
    hour: london.getHours(),
    minute: london.getMinutes(),
    minutesSinceMidnight: london.getHours() * 60 + london.getMinutes(),
    isWeekend: dow === 0 || dow === 6,
    isFriday: dow === 5,
    isMonday: dow === 1,
    daysToWeekend: (6 - dow + 7) % 7,
    daysSinceWeekend: (dow + 7 - 0) % 7,
    isMonthStart: london.getDate() <= 3,
    isMonthEnd: london.getDate() > daysInMonth - 3,
    daysToMonthEnd: daysInMonth - london.getDate(),
    // Payday is unknown, so both common conventions are recorded and the
    // question can be settled later against real data.
    daysSince25th: london.getDate() >= 25 ? london.getDate() - 25 : london.getDate() + (daysInMonth - 25),
    daysSinceMonthStart: london.getDate() - 1,
    season: SEASONS[m],
    isBankHoliday: BANK_HOLIDAYS.has(iso(london)),
    daysToNextBankHoliday: bh.next,
    daysSincePreviousBankHoliday: bh.previous,
    isBritishSummerTime: isBritishSummerTime(now),
    moonPhase: Number(moonPhase(now).toFixed(4)),
    weekParity: Math.ceil(dayOfYear / 7) % 2,
  };
}

/** Marker sets used to characterise a recipe. Keyword tables, no API. */
const CUISINES: [string, RegExp][] = [
  ["thai", /fish sauce|lemongrass|galangal|thai|lime leaf|tamarind/],
  ["indian", /garam masala|turmeric|cumin|coriander|tikka|biryani|vindaloo|paneer|naan|ghee/],
  ["chinese", /soy sauce|hoisin|five spice|oyster sauce|shaoxing|doubanjiang|sichuan/],
  ["japanese", /mirin|miso|dashi|sake|panko|nori|wasabi|yakitori/],
  ["korean", /gochujang|kimchi|bulgogi|gochugaru/],
  ["italian", /parmesan|mozzarella|basil|oregano|pasta|risotto|pancetta|passata/],
  ["mexican", /tortilla|chipotle|jalapeno|taco|salsa|adobo|tostada/],
  ["french", /creme fraiche|dijon|tarragon|shallot|marsala|bourguignon/],
  ["greek", /feta|tzatziki|halloumi|souvlaki|kleftiko/],
  ["middle_eastern", /harissa|tahini|za'atar|preserved lemon|couscous|merguez|shawarma/],
  ["british", /suet|worcestershire|ale|gravy|black pudding/],
];

const HEAT: [string, RegExp][] = [
  ["chilli", /chilli|chili|jalapeno|scotch bonnet|cayenne|birds eye/],
  ["paste", /harissa|gochujang|doubanjiang|sambal|curry paste/],
  ["pepper", /peppercorn|black pepper|white pepper/],
  ["mustard", /mustard|horseradish|wasabi/],
];

const METHODS: [string, RegExp][] = [
  ["fry", /\bfry\b|\bfrying\b|\bsear\b|\bsauté|\bsaute\b/],
  ["roast", /\broast\b|\bbake\b|\boven\b/],
  ["braise", /\bbraise\b|\bslow.cook\b|\bstew\b|\bsimmer\b/],
  ["grill", /\bgrill\b|\bbarbecue\b|\bchar\b|\bskewer\b/],
  ["boil", /\bboil\b|\bpoach\b|\bsteam\b/],
  ["raw", /\btoss\b|\bsalad\b|\bdress\b|\bmarinate\b/],
  ["deep_fry", /deep fry|deep-fry/],
];

const EQUIPMENT: [string, RegExp][] = [
  ["oven", /\boven\b|\broast\b|\bbake\b|\b\d+\s*c\b/],
  ["hob", /\bpan\b|\bfry\b|\bsimmer\b|\bboil\b/],
  ["wok", /\bwok\b|stir.fry/],
  ["grill", /\bgrill\b|\bskewer\b/],
  ["blender", /\bblend\b|\bprocessor\b|\bpuree\b/],
];

const ALLERGENS: [string, RegExp][] = [
  ["dairy", /milk|butter|cheese|cream|yoghurt|paneer|halloumi|ghee/],
  ["gluten", /flour|bread|pasta|noodle|panko|couscous|pastry|soy sauce|barley/],
  ["nut", /peanut|almond|cashew|walnut|pistachio|hazelnut/],
  ["shellfish", /prawn|shrimp|scallop|mussel|crab|lobster|squid/],
  ["fish", /\bfish\b|salmon|cod|anchov|tuna|haddock/],
  ["egg", /\beggs?\b/],
  ["soy", /soy|tofu|edamame|miso/],
];

function hits(table: [string, RegExp][], text: string): string[] {
  return table.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Every stated duration in the instructions, in minutes. */
function durations(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi)) out.push(Number(m[1]) * 60);
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/gi)) out.push(Number(m[1]));
  return out;
}

/**
 * Everything derivable about a recipe from its own text and ingredient list.
 * Roughly 25 fields, all keyword matching and arithmetic.
 */
export function recipeFacts(instructions: string[], description: string, ingredientNames: string[]) {
  const method = instructions.join(" ").toLowerCase();
  const ing = ingredientNames.join(" ").toLowerCase();
  const all = `${method} ${ing} ${description.toLowerCase()}`;
  const times = durations(method);

  return {
    instructionCount: instructions.length,
    instructionChars: method.length,
    instructionWords: method.split(/\s+/).length,
    avgStepWords: instructions.length ? Math.round(method.split(/\s+/).length / instructions.length) : 0,
    descriptionWords: description.split(/\s+/).length,
    ingredientCount: ingredientNames.length,
    statedDurations: times,
    longestDurationMin: times.length ? Math.max(...times) : null,
    shortestDurationMin: times.length ? Math.min(...times) : null,
    totalStatedMin: times.reduce((a, b) => a + b, 0),
    hasOvernightStep: /overnight|\b\d+\s*hours?\b/i.test(method) && (times.length ? Math.max(...times) >= 240 : false),
    cuisines: hits(CUISINES, all),
    heatSources: hits(HEAT, ing),
    methods: hits(METHODS, method),
    equipment: hits(EQUIPMENT, method),
    allergens: hits(ALLERGENS, ing),
    temperaturesC: [...method.matchAll(/(\d{2,3})\s*c\b/g)].map((m) => Number(m[1])),
    mentionsRest: /\brest\b/i.test(method),
    mentionsMarinate: /marinat/i.test(method),
    mentionsShred: /shred/i.test(method),
  };
}

/** Distribution statistics for a set of model scores. */
export function scoreStats(values: number[]) {
  if (values.length === 0) {
    return { count: 0, min: null, max: null, mean: null, median: null, stdDev: null, distinct: 0, range: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Number(mean.toFixed(6)),
    median: sorted[Math.floor(sorted.length / 2)],
    stdDev: Number(Math.sqrt(variance).toFixed(6)),
    distinct: new Set(values.map((v) => v.toFixed(6))).size,
    range: sorted[sorted.length - 1] - sorted[0],
  };
}

/** Crude device classification from a user agent string. No lookups. */
export function deviceFacts(userAgent: string | null) {
  const ua = (userAgent ?? "").toLowerCase();
  return {
    raw: userAgent,
    isMobile: /iphone|android|mobile/.test(ua),
    isTablet: /ipad|tablet/.test(ua),
    isDesktop: !/iphone|android|mobile|ipad|tablet/.test(ua) && ua.length > 0,
    os: /iphone|ipad|ios/.test(ua) ? "ios"
      : /android/.test(ua) ? "android"
      : /mac os|macintosh/.test(ua) ? "macos"
      : /windows/.test(ua) ? "windows"
      : /linux/.test(ua) ? "linux"
      : null,
    browser: /edg\//.test(ua) ? "edge"
      : /chrome/.test(ua) ? "chrome"
      : /safari/.test(ua) ? "safari"
      : /firefox/.test(ua) ? "firefox"
      : null,
    isBot: /bot|crawler|spider|preview|scanner|proofpoint|mimecast/.test(ua),
  };
}
