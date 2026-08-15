import { describe, expect, it } from "vitest";
import { parseQuantityToGrams } from "./quantity";
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

  it("parses counted units with per-unit weights", () => {
    expect(parseQuantityToGrams("2 cloves").grams).toBe(10);
    expect(parseQuantityToGrams("4 sprigs").grams).toBe(8);
  });

  it("treats 'to taste' as negligible rather than unparseable", () => {
    expect(parseQuantityToGrams("to taste").grams).toBe(1);
  });

  it("returns null grams when nothing can be parsed", () => {
    expect(parseQuantityToGrams("").grams).toBeNull();
  });
});

describe("computeQuantityCost", () => {
  const honey = {
    skuName: "Clear Honey 340g",
    pricePerPackGBP: 0.74,
    packQuantity: { grams: 340 },
  };
  const chicken = {
    skuName: "Chicken Thighs 500g",
    pricePerPackGBP: 3.75,
    packQuantity: { grams: 500 },
  };

  it("charges a whole pack for the first shop but prorates the marginal cost", () => {
    // 2 tbsp (~30g) of a 340g jar: you buy the jar, but only use ~9% of it.
    const cost = computeQuantityCost(honey, "2 tbsp");
    expect(cost.firstShopPrice).toBe(0.74);
    expect(cost.marginalPrice).toBeCloseTo(0.07, 2);
  });

  it("prorates proportionally when most of a pack is used", () => {
    const cost = computeQuantityCost(chicken, "400g");
    expect(cost.firstShopPrice).toBe(3.75);
    expect(cost.marginalPrice).toBeCloseTo(3.0, 2);
  });

  it("buys multiple packs when the recipe needs more than one", () => {
    const cost = computeQuantityCost(chicken, "1.2kg");
    expect(cost.firstShopPrice).toBe(11.25); // 3 packs
    expect(cost.gramsPurchased).toBe(1500);
    expect(cost.marginalPrice).toBeCloseTo(9.0, 2);
  });

  it("never charges marginal above the packs actually bought", () => {
    const cost = computeQuantityCost(chicken, "500g");
    expect(cost.marginalPrice).toBeLessThanOrEqual(cost.firstShopPrice!);
  });

  it("assumes a small share of the pack for unparseable quantities", () => {
    const cost = computeQuantityCost(honey, "a drizzle");
    expect(cost.firstShopPrice).toBe(0.74);
    expect(cost.marginalPrice).toBeLessThan(0.74);
    expect(cost.marginalPrice).toBeGreaterThan(0);
  });

  it("returns empty costs when there is no product match", () => {
    const cost = computeQuantityCost(null, "400g");
    expect(cost.firstShopPrice).toBeNull();
    expect(cost.marginalPrice).toBeNull();
  });
});
