import { describe, expect, it } from "vitest";
import { isPlausibleProduct } from "./matching";

/**
 * Every case here is a real match found in production data during a manual
 * audit of all 43 meat and fish ingredients. 18 of the 43 were wrong.
 */
describe("meat cut matching", () => {
  const reject: [string, string][] = [
    ["pork shoulder", "Richmond Thick Pork Sausages 8 Pack 410g"],
    ["pork tenderloin", "Richmond Thick Pork Sausages 8 Pack 410g"],
    ["pork chops", "Sainsbury's British Pork Mince 20% Fat 500g"],
    ["pork shoulder joint", "Sainsbury's Extra Lean British Pork Stir Fry Strips 300g"],
    ["beef sirloin", "Sainsbury's British or Irish 5% Fat Beef Mince 250g"],
    ["beef fillet", "Sainsbury's British or Irish 25% Fat Beef Mince 500g"],
    ["beef short ribs", "Sainsbury's British or Irish 25% Fat Beef Mince 500g"],
    ["duck legs", "Gressingham Duck Livers 300g"],
    ["lamb chops", "Sainsbury's Stamford Street Co. Lamb Grill Steaks 300g"],
    ["lamb leg", "Stamford Street Co. Bone-In Lamb Leg Chops 320g"],
    ["lamb stock", "Sainsbury's Stamford Street Co. Lamb Grill Steaks 300g"],
    ["whole chicken", "Itsu 500ml Chicken Ramen Brilliant Broth"],
    ["chicken breast", "Sainsbury's 1.6kg British Fresh Medium Whole Chicken"],
    ["chicken breasts", "Sainsbury's Cajun British Chicken Breast Grills 330g"],
    ["king prawns", "Birds Eye Captain's Crispy Lemon & Parsley Battered Prawns 220g"],
  ];

  for (const [ingredient, sku] of reject) {
    it(`rejects "${sku}" for "${ingredient}"`, () => {
      expect(isPlausibleProduct(sku, ingredient)).toBe(false);
    });
  }

  it("rejects a different animal entirely", () => {
    expect(
      isPlausibleProduct("Sainsbury's British or New Zealand Lamb Boneless Shoulder 700 g", "diced venison shoulder")
    ).toBe(false);
  });

  const accept: [string, string][] = [
    ["beef mince", "Sainsbury's British or Irish 5% Fat Beef Mince 250g"],
    ["diced beef shin", "Sainsbury's British or Irish Diced Beef Shin 500g"],
    ["chicken thighs", "Sainsbury's Fresh British Chicken Thighs Skin On 2kg"],
    ["duck breasts", "Sainsbury's British Duck Breast Fillets 397g"],
    ["lamb mince", "Sainsbury's British or New Zealand 20% Fat Lamb Mince 250g"],
    ["lamb shoulder", "Sainsbury's Welsh Hill Mini Lamb Shoulder Joint 450g"],
    ["pork belly slices", "Sainsbury's British Pork Belly Slices 500g"],
    ["pork loin steaks", "Sainsbury's British Pork Loin Steaks 240 g"],
    ["sirloin steaks", "Sainsbury's British or Irish 21 Day Matured Sirloin Steak 225g"],
    ["pork sausages", "Richmond Thick Pork Sausages 8 Pack 410g"],
    ["salmon fillets", "Fish Said Fred Coho Salmon Fillets 250g"],
    ["bacon lardons", "Stamford Street Co. Cooking Bacon 500g"],
  ];

  for (const [ingredient, sku] of accept) {
    it(`accepts "${sku}" for "${ingredient}"`, () => {
      expect(isPlausibleProduct(sku, ingredient)).toBe(true);
    });
  }

  it("leaves non-meat ingredients alone", () => {
    expect(isPlausibleProduct("Sainsbury's Large Garlic Bulb", "garlic")).toBe(true);
    expect(isPlausibleProduct("Sainsbury's Plain Flour 500g", "plain flour")).toBe(true);
  });
});

describe("choosing the right cut over a cheaper generic", () => {
  const c = (n: string, p: number) => ({ product: { product_name: n, price: { price: p }, quantity: { grams: 300 } } });

  it("takes a sirloin steak over cheaper unspecified beef", async () => {
    const { pickBestProduct } = await import("./pepestoAdapter");
    const best = pickBestProduct(
      [c("Sainsbury's Quick Cook Extra Thin British or Irish Beef 200g", 300),
       c("Sainsbury's British or Irish 21 Day Matured Sirloin Steak 225g", 600)],
      "beef sirloin"
    );
    expect(best?.product_name).toContain("Sirloin");
  });

  it("estimates rather than accept a cut-less generic for a named cut", async () => {
    // "Quick Cook Extra Thin Beef" names no cut, so it satisfied sirloin,
    // fillet and short ribs alike and, being cheapest, won all three. A
    // flagged estimate is more honest than a silently wrong cut priced like
    // something else.
    const { pickBestProduct } = await import("./pepestoAdapter");
    const best = pickBestProduct([c("Sainsbury's Quick Cook Extra Thin British or Irish Beef 200g", 300)], "beef fillet");
    expect(best).toBeNull();
  });

  it("still accepts a generic when the ingredient names no cut either", async () => {
    const { pickBestProduct } = await import("./pepestoAdapter");
    const best = pickBestProduct([c("Sainsbury's British Beef 500g", 500)], "beef");
    expect(best).not.toBeNull();
  });
});

describe("preserved forms are not the fresh ingredient", () => {
  it("rejects pickled mussels for fresh mussels", async () => {
    const { isPlausibleProduct } = await import("./matching");
    expect(isPlausibleProduct("Parsons Pickled Mussels 155 g", "mussels")).toBe(false);
  });

  it("does not reject a product the recipe asked to be preserved", async () => {
    const { isPlausibleProduct } = await import("./matching");
    expect(isPlausibleProduct("Sainsbury's Smoked Salmon 120g", "smoked salmon")).toBe(true);
  });
});
