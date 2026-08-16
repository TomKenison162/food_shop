import { describe, expect, it } from "vitest";
import { isPlausibleProduct, scoreProductMatch } from "./matching";
import { pickBestProduct } from "./pepestoAdapter";

function candidate(product_name: string, pence: number, grams = 500) {
  return { product: { product_name, price: { price: pence }, quantity: { grams } } };
}

describe("product plausibility", () => {
  // Every rejection below was a real match that produced a real overcharge.
  it("rejects lime leaves for limes", () => {
    // A leaf weighs ~1g, so two limes demanded eight packs: £16.00.
    expect(isPlausibleProduct("Sainsbury's Fresh Packed Lime Leaves 4 Pack", "lime")).toBe(false);
  });

  it("still accepts lime leaves when the recipe asks for lime leaves", () => {
    // The rule above must not swallow the ingredient it's named after.
    expect(isPlausibleProduct("Sainsbury's Fresh Packed Lime Leaves 4 Pack", "kaffir lime leaves")).toBe(true);
  });

  it("rejects white wine for red wine", () => {
    expect(isPlausibleProduct("Coolwater Bay Marlborough Sauvignon Blanc White Wine 75cl", "red wine")).toBe(false);
  });

  it("rejects a finished ramen broth for cooking stock", () => {
    // £2.70 per 500ml made 1.2L of chicken stock cost £8.10.
    expect(isPlausibleProduct("Itsu 500ml Chicken Ramen Brilliant Broth", "chicken stock")).toBe(false);
  });

  it("rejects diced stewing beef for a sirloin steak", () => {
    expect(isPlausibleProduct("Sainsbury's British Diced Beef Organic 500g", "beef sirloin")).toBe(false);
  });

  it("rejects grill steaks for a shoulder joint", () => {
    expect(isPlausibleProduct("Stamford Street Co. Lamb Grill Steaks 300g", "lamb shoulder")).toBe(false);
  });

  it("rejects breast when the recipe wants legs", () => {
    expect(isPlausibleProduct("Gressingham Duck Breast 170g", "duck legs")).toBe(false);
  });

  it("still accepts the genuinely right product", () => {
    expect(isPlausibleProduct("Sainsbury's British or Irish Diced Beef Shin 500g", "diced beef shin")).toBe(true);
    expect(isPlausibleProduct("Sainsbury's Whole Cucumber", "cucumber")).toBe(true);
    expect(isPlausibleProduct("Sainsbury's Fresh Packed Mint 30g", "mint")).toBe(true);
  });
});

describe("choosing between plausible products", () => {
  it("prefers the standard range over the premium one", () => {
    const best = pickBestProduct(
      [candidate("Sainsbury's British Diced Beef Organic 500g", 800), candidate("Sainsbury's Diced Beef 500g", 500)],
      "diced beef"
    );
    expect(best?.product_name).toBe("Sainsbury's Diced Beef 500g");
  });

  it("takes the cheaper product when two match equally well", () => {
    const best = pickBestProduct([candidate("Beef Mince 500g", 650), candidate("Beef Mince 500g", 400)], "beef mince");
    expect(best?.price.price).toBe(400);
  });

  it("does not chase the cheapest at the cost of a wrong product", () => {
    // Price is a tie-breaker, not the objective — a 20p item that isn't the
    // ingredient is worse than a £4 one that is.
    const best = pickBestProduct(
      [candidate("Sainsbury's Chicken Stock Cubes 8 Pack", 120), candidate("Sainsbury's Chicken Breast Fillets 640g", 450)],
      "chicken stock"
    );
    expect(best?.product_name).toContain("Stock");
  });

  it("returns null when nothing plausible is on offer", () => {
    expect(pickBestProduct([candidate("Bacardi Breezer 275ml", 200)], "sake")).toBeNull();
  });

  it("scores a verbatim name above a merely overlapping one", () => {
    expect(scoreProductMatch("Sainsbury's Beef Mince 500g", "beef mince")).toBeGreaterThan(
      scoreProductMatch("Sainsbury's Beef & Ale Pie 400g", "beef mince")
    );
  });
});

describe("prepared form must match", () => {
  // Each of these was a real reuse that made a line wrong, or dearer.
  it("rejects whole seeds for a ground spice", () => {
    expect(isPlausibleProduct("Natco Cumin Seeds 360g", "ground cumin")).toBe(false);
  });

  it("rejects oil spray for cooking oil", () => {
    expect(isPlausibleProduct("Sainsbury's Air Fryer Oil Spray 200ml", "vegetable oil")).toBe(false);
  });

  it("rejects the fruit when the recipe wants the juice", () => {
    expect(isPlausibleProduct("Sainsbury's Oranges 5 Pack", "orange juice")).toBe(false);
    expect(isPlausibleProduct("Sainsbury's Pure Orange Juice 1L", "orange juice")).toBe(true);
  });

  it("still accepts the matching form", () => {
    expect(isPlausibleProduct("Sainsbury's Ground Cumin 38g", "ground cumin")).toBe(true);
    expect(isPlausibleProduct("Sainsbury's Vegetable Oil 1L", "vegetable oil")).toBe(true);
  });
});
