import { describe, expect, it } from "vitest";
import { addDaysToDateString, dayOfWeekForDateString, startOfWeek } from "./date";

describe("addDaysToDateString", () => {
  it("adds and subtracts days", () => {
    expect(addDaysToDateString("2026-08-15", 1)).toBe("2026-08-16");
    expect(addDaysToDateString("2026-08-15", -1)).toBe("2026-08-14");
  });

  it("crosses month and year boundaries", () => {
    expect(addDaysToDateString("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToDateString("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles leap days", () => {
    expect(addDaysToDateString("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("startOfWeek", () => {
  it("returns the Monday of the containing week", () => {
    // 2026-08-15 is a Saturday.
    expect(dayOfWeekForDateString("2026-08-15")).toBe(6);
    expect(startOfWeek("2026-08-15")).toBe("2026-08-10");
  });

  it("treats Sunday as the end of the week, not the start", () => {
    // 2026-08-16 is a Sunday — its week still starts Monday the 10th.
    expect(dayOfWeekForDateString("2026-08-16")).toBe(0);
    expect(startOfWeek("2026-08-16")).toBe("2026-08-10");
  });

  it("is a no-op on a Monday", () => {
    expect(startOfWeek("2026-08-10")).toBe("2026-08-10");
  });
});
