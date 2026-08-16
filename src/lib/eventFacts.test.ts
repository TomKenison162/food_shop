import { describe, expect, it } from "vitest";
import { deviceFacts, recipeFacts, scoreStats, timeFacts } from "./eventFacts";

describe("timeFacts", () => {
  const t = timeFacts(new Date("2026-12-25T18:30:00Z"));

  it("captures a wide calendar picture with no API call", () => {
    expect(Object.keys(t).length).toBeGreaterThan(30);
  });

  it("knows UK bank holidays from a static table", () => {
    expect(t.isBankHoliday).toBe(true);
    expect(timeFacts(new Date("2026-06-10T12:00:00Z")).isBankHoliday).toBe(false);
  });

  it("measures distance to bank holidays in both directions", () => {
    const june = timeFacts(new Date("2026-06-10T12:00:00Z"));
    expect(june.daysToNextBankHoliday).toBeGreaterThan(0);
    expect(june.daysSincePreviousBankHoliday).toBeGreaterThan(0);
  });

  it("tracks BST versus GMT", () => {
    expect(timeFacts(new Date("2026-07-01T12:00:00Z")).isBritishSummerTime).toBe(true);
    expect(timeFacts(new Date("2026-01-15T12:00:00Z")).isBritishSummerTime).toBe(false);
  });

  it("computes moon phase without a lookup", () => {
    expect(t.moonPhase).toBeGreaterThanOrEqual(0);
    expect(t.moonPhase).toBeLessThanOrEqual(1);
  });

  it("labels the season", () => {
    expect(timeFacts(new Date("2026-01-15T12:00:00Z")).season).toBe("winter");
    expect(timeFacts(new Date("2026-07-15T12:00:00Z")).season).toBe("summer");
  });
});

describe("recipeFacts", () => {
  const f = recipeFacts(
    ["Marinate overnight.", "Braise at 160C for 3 hours.", "Serve with rice."],
    "Slow-cooked and rich.",
    ["pork shoulder", "soy sauce", "gochujang", "double cream", "rice"]
  );

  it("detects cuisines from ingredients alone", () => {
    expect(f.cuisines).toContain("korean");
  });

  it("detects heat sources, methods, equipment and allergens", () => {
    expect(f.heatSources).toContain("paste");
    expect(f.methods).toContain("braise");
    expect(f.equipment).toContain("oven");
    expect(f.allergens).toContain("dairy");
  });

  it("extracts every stated duration and the oven temperature", () => {
    expect(f.longestDurationMin).toBe(180);
    expect(f.temperaturesC).toContain(160);
  });
});

describe("scoreStats", () => {
  it("summarises a score distribution", () => {
    const s = scoreStats([0.1, 0.5, 0.5, 0.9]);
    expect(s.count).toBe(4);
    expect(s.distinct).toBe(3);
    expect(s.range).toBeCloseTo(0.8);
  });

  it("handles an untrained model with no scores", () => {
    expect(scoreStats([]).count).toBe(0);
  });
});

describe("deviceFacts", () => {
  it("classifies a phone", () => {
    const d = deviceFacts("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15");
    expect(d.isMobile).toBe(true);
    expect(d.os).toBe("ios");
  });

  it("flags scanners, which click links without a human", () => {
    expect(deviceFacts("Mozilla/5.0 (compatible; proofpoint-urlscanner)").isBot).toBe(true);
  });
});
