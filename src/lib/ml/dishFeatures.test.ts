import { describe, expect, it } from "vitest";
import { carbBase, effortMinutes, richnessScore } from "./dishFeatures";

describe("effortMinutes", () => {
  it("separates a long braise from a quick stir fry by a wide margin", () => {
    // This is the whole point: it's what makes "too much effort" learnable.
    const braise = effortMinutes([
      "Brown the ribs.",
      "Braise at 160C for 3 hours.",
      "Reduce the sauce.",
      "Serve with mash.",
    ]);
    const stirFry = effortMinutes(["Fry the beef 2 minutes.", "Toss with noodles."]);
    expect(braise).toBeGreaterThan(120);
    expect(stirFry).toBeLessThan(30);
  });

  it("takes the longest step, not the sum, because steps overlap", () => {
    // Pasta boils while the sauce simmers; adding them would double-count.
    const overlapping = effortMinutes(["Simmer the sauce 25 minutes.", "Cook the pasta 10 minutes."]);
    expect(overlapping).toBeLessThan(25 + 10 + 20);
  });

  it("reads hours and minutes alike", () => {
    expect(effortMinutes(["Cook for 2 hours."])).toBeGreaterThan(effortMinutes(["Cook for 30 minutes."]));
    expect(effortMinutes(["Rest for 90 mins."])).toBeGreaterThan(effortMinutes(["Rest for 5 min."]));
  });

  it("still separates dishes when no time is stated at all", () => {
    const many = effortMinutes(["a", "b", "c", "d", "e", "f", "g"]);
    const few = effortMinutes(["a", "b"]);
    expect(many).toBeGreaterThan(few);
  });
});

describe("richnessScore", () => {
  it("ranks cream and cheese above a lean salad", () => {
    const rich = richnessScore(["double cream", "butter", "parmesan", "bacon lardons"]);
    const lean = richnessScore(["salad leaves", "lime", "fish sauce", "cucumber"]);
    expect(rich).toBeGreaterThan(lean);
    expect(lean).toBeLessThan(0.2);
  });

  it("stays within 0..1 however indulgent the dish", () => {
    const s = richnessScore([
      "double cream", "butter", "cheddar cheese", "coconut milk", "chorizo", "milk", "olive oil",
    ]);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("does not treat a splash of oil as richness", () => {
    expect(richnessScore(["olive oil"])).toBeLessThan(0.2);
  });
});

describe("carbBase", () => {
  it("identifies what the dish is served on", () => {
    expect(carbBase(["basmati rice", "chicken thighs"])).toBe("rice");
    expect(carbBase(["rigatoni", "pork sausages"])).toBe("pasta");
    expect(carbBase(["potatoes", "lamb"])).toBe("potato");
    expect(carbBase(["flatbreads", "lamb mince"])).toBe("bread");
  });

  it("returns none for dishes with no carb at all", () => {
    expect(carbBase(["beef sirloin", "salad leaves", "lime", "mint"])).toBe("none");
  });

  it("treats noodles as the pasta family rather than none", () => {
    expect(carbBase(["rice noodles", "prawns"])).not.toBe("none");
  });
});
