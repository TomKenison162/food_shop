/**
 * How long leftover stock of an ingredient stays usable, once opened.
 *
 * Without this, pantry entries live forever and the app ends up telling you
 * to skip buying chicken because of a pack opened three weeks ago — worse
 * than not tracking leftovers at all, because it's confidently wrong.
 *
 * Conservative fridge-life figures for opened/portioned food, not
 * unopened-packet best-before dates. Ordered most-specific first; the
 * longest matching key wins.
 */
const SHELF_LIFE_DAYS: Record<string, number> = {
  // highly perishable
  prawn: 2,
  scallop: 2,
  mussels: 2,
  fish: 2,
  salmon: 2,
  cod: 2,
  mince: 2,
  // fresh meat
  chicken: 3,
  turkey: 3,
  pork: 3,
  beef: 3,
  lamb: 3,
  duck: 3,
  venison: 3,
  steak: 3,
  // cured / processed meat
  bacon: 7,
  chorizo: 14,
  sausage: 3,
  "parma ham": 7,
  // dairy
  cream: 4,
  milk: 5,
  yoghurt: 7,
  paneer: 5,
  halloumi: 14,
  feta: 10,
  mozzarella: 5,
  cheese: 14,
  butter: 30,
  egg: 21,
  // fresh produce
  salad: 4,
  lettuce: 5,
  herb: 5,
  parsley: 5,
  coriander: 5,
  mint: 5,
  basil: 5,
  spinach: 5,
  mushroom: 6,
  broccoli: 7,
  "pak choi": 5,
  beansprouts: 3,
  cucumber: 7,
  pepper: 10,
  tomato: 7,
  carrot: 21,
  onion: 30,
  garlic: 60,
  ginger: 21,
  potato: 30,
  apple: 21,
  lemon: 21,
  lime: 21,
  orange: 21,
  // bakery
  bread: 4,
  bun: 4,
  naan: 5,
  pitta: 5,
  flatbread: 5,
  tortilla: 7,
  pancake: 7,
  // ambient / dry / preserved — effectively indefinite for our purposes
  rice: 180,
  pasta: 180,
  spaghetti: 180,
  noodle: 180,
  couscous: 180,
  lentil: 180,
  flour: 180,
  sugar: 180,
  breadcrumb: 90,
  crouton: 30,
  bean: 120,
  chickpea: 120,
  oil: 180,
  vinegar: 365,
  sauce: 30,
  paste: 30,
  stock: 14,
  honey: 365,
  mustard: 90,
  spice: 365,
  powder: 365,
  seed: 365,
  salt: 365,
  pepper_ground: 365,
  wine: 5,
  beer: 5,
  coconut: 5,
};

const DEFAULT_SHELF_LIFE_DAYS = 7;
const AMBIENT_DAYS = 365;

/**
 * Markers that make an ingredient shelf-stable regardless of what it's made
 * of. These are checked before the name table because the preparation
 * matters more than the plant: fresh coriander lasts days, ground coriander
 * lasts a year, and both are just "coriander" in a recipe line.
 */
const AMBIENT_MARKERS = [
  "ground ",
  "dried ",
  "powder",
  "flakes",
  "seeds",
  " spice",
  "spice ",
  "masala",
  "paprika",
  "cumin",
  "turmeric",
  "cinnamon",
  "allspice",
  "oregano",
  "cayenne",
  "peppercorn",
  "saffron",
  "bay leaves",
  "stock cube",
];

export function shelfLifeDays(genericName: string): number {
  const name = genericName.toLowerCase();

  if (AMBIENT_MARKERS.some((marker) => name.includes(marker))) {
    return AMBIENT_DAYS;
  }

  let best: { key: string; days: number } | null = null;
  for (const [key, days] of Object.entries(SHELF_LIFE_DAYS)) {
    if (name.includes(key) && (best === null || key.length > best.key.length)) {
      best = { key, days };
    }
  }
  return best?.days ?? DEFAULT_SHELF_LIFE_DAYS;
}
