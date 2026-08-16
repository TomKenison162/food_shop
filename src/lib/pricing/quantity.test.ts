import { describe, expect, it } from "vitest";
import { gramsPerPiece, parseQuantityToGrams } from "./quantity";
import { computeQuantityCost } from "./pepestoAdapter";

describe("parseQuantityToGrams", () => {
  it("parses weights", () => {
    expect(parseQuantityToGrams("400g").grams).toBe(400);
    expect(parseQuantityToGrams("1.5kg").grams).toBe(1500);
  });

  it("parses volumes as ~1g/ml", () => {
    expect(parseQuantityToGrams("200ml").grams).toBe(200);
    expect(parseQuantityToGrams("1L").grams).toBe(1000);
  });

  it("parses spoon measures", () => {
    expect(parseQuantityToGrams("2 tbsp").grams).toBe(30);
    expect(parseQuantityToGrams("1 tsp").grams).toBe(5);
  });

  it("prefers an explicit unit word over the ingredient's piece weight", () => {
    expect(parseQuantityToGrams("2 cloves", "garlic").grams).toBe(10);
    expect(parseQuantityToGrams("4 sprigs", "rosemary").grams).toBe(8);
    expect(parseQuantityToGrams("1 tin", "chopped tomatoes").grams).toBe(400);
  });

  it("treats 'to taste' as negligible rather than unparseable", () => {
    expect(parseQuantityToGrams("to taste").grams).toBe(1);
  });

  it("returns null grams when nothing can be parsed", () => {
    expect(parseQuantityToGrams("").grams).toBeNull();
  });

  describe("unit-less counted lines", () => {
    it("uses the ingredient's own piece weight, not a flat default", () => {
      // The bug this guards: a flat 100g/piece costed "2 sirloin steaks" as
      // 200g — about a quarter of reality — which fed straight into tiering
      // and the weekly budget and made expensive cuts look cheap.
      expect(parseQuantityToGrams("2", "sirloin steaks").grams).toBe(450);
      expect(parseQuantityToGrams("6", "chicken thighs").grams).toBe(900);
      expect(parseQuantityToGrams("9", "lasagne sheets").grams).toBe(108);
      expect(parseQuantityToGrams("2", "brioche buns").grams).toBe(120);
    });

    it("falls back to a generic weight for unknown ingredients", () => {
      expect(parseQuantityToGrams("2", "mystery item").grams).toBe(240);
    });

    it("matches the most specific ingredient key", () => {
      // "chicken breast" must win over the shorter "chicken".
      expect(gramsPerPiece("chicken breast")).toBe(180);
      expect(gramsPerPiece("chicken thigh")).toBe(150);
    });
  });
});

describe("computeQuantityCost", () => {
  const honey = { skuName: "Clear Honey 340g", pricePerPackGBP: 0.74, packQuantity: { grams: 340 } };
  const chicken = { skuName: "Chicken Thighs 500g", pricePerPackGBP: 3.75, packQuantity: { grams: 500 } };

  it("charges a whole pack for the first shop but prorates the marginal cost", () => {
    const cost = computeQuantityCost(honey, "2 tbsp", "honey");
    expect(cost.firstShopPrice).toBe(0.74);
    expect(cost.marginalPrice).toBeCloseTo(0.07, 2);
  });

  it("prorates proportionally when most of a pack is used", () => {
    const cost = computeQuantityCost(chicken, "400g", "chicken thighs");
    expect(cost.firstShopPrice).toBe(3.75);
    expect(cost.marginalPrice).toBeCloseTo(3.0, 2);
  });

  it("buys multiple packs when the recipe needs more than one", () => {
    const cost = computeQuantityCost(chicken, "1.2kg", "chicken thighs");
    expect(cost.firstShopPrice).toBe(11.25); // 3 packs
    expect(cost.gramsPurchased).toBe(1500);
    expect(cost.marginalPrice).toBeCloseTo(9.0, 2);
  });

  it("uses ingredient-aware piece weights for counted lines", () => {
    // 6 thighs = 900g → two 500g packs, and nearly all of it consumed.
    const cost = computeQuantityCost(chicken, "6", "chicken thighs");
    expect(cost.firstShopPrice).toBe(7.5);
    expect(cost.marginalPrice).toBeCloseTo(6.75, 2);
  });

  it("never charges marginal above the packs actually bought", () => {
    const cost = computeQuantityCost(chicken, "500g", "chicken thighs");
    expect(cost.marginalPrice).toBeLessThanOrEqual(cost.firstShopPrice!);
  });

  it("assumes a small share of the pack for unparseable quantities", () => {
    const cost = computeQuantityCost(honey, "a drizzle", "honey");
    expect(cost.firstShopPrice).toBe(0.74);
    expect(cost.marginalPrice).toBeLessThan(0.74);
    expect(cost.marginalPrice).toBeGreaterThan(0);
  });

  it("returns empty costs when there is no product match", () => {
    const cost = computeQuantityCost(null, "400g", "chicken thighs");
    expect(cost.firstShopPrice).toBeNull();
    expect(cost.marginalPrice).toBeNull();
  });
});

describe("unit words carried by the ingredient name", () => {
  it("reads the unit from the ingredient when the quantity has none", () => {
    // Regression: "2" + "bay leaves" fell through to a 120g generic piece
    // weight, making 2 leaves 240g — 80 packs and £88 for a garnish.
    expect(parseQuantityToGrams("2", "bay leaves").grams).toBe(10);
    expect(parseQuantityToGrams("4", "curry leaves").grams).toBe(20);
    expect(parseQuantityToGrams("2", "lemongrass stalks").grams).toBe(30);
  });

  it("still prefers a specific ingredient match over a generic unit word", () => {
    expect(parseQuantityToGrams("2", "chicken breasts").grams).toBe(360);
  });
});

describe("piece weights that caused real over-buying", () => {
  // Every case here was measured on a real priced meal before being fixed.
  it("treats spring onions as garnish, not as onions", () => {
    // "4 spring onions" hit the `onion` key at 150g => 600g => six 100g
    // bunches at £1.20 = £7.20 for a garnish, in two separate dishes.
    expect(gramsPerPiece("spring onion")).toBeLessThan(30);
    expect(parseQuantityToGrams("4", "spring onions").grams).toBeLessThan(100);
  });

  it("sizes sausages individually rather than at the default", () => {
    expect(parseQuantityToGrams("6", "pork sausages").grams).toBeLessThan(500);
  });

  it("sizes chillies and leaves as the trivial amounts they are", () => {
    expect(gramsPerPiece("red chilli")).toBeLessThan(30);
    expect(gramsPerPiece("bay leaf")).toBeLessThan(5);
    expect(gramsPerPiece("garlic clove")).toBeLessThan(15);
  });

  it("still sizes whole joints correctly", () => {
    // The fix must not shrink genuinely large items.
    expect(gramsPerPiece("whole chicken")).toBeGreaterThan(1000);
    expect(gramsPerPiece("lamb shank")).toBeGreaterThan(200);
  });
});
