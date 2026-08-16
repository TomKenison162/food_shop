import { describe, expect, it } from "vitest";
import {
  DECLINE_LABELS,
  DECLINE_REASONS,
  isDeclineReason,
  isPreferenceSignal,
} from "./declineReasons";

describe("decline reasons", () => {
  it("recognises every reason it defines", () => {
    for (const r of DECLINE_REASONS) expect(isDeclineReason(r)).toBe(true);
  });

  it("rejects anything else, so a tampered link can't invent a label", () => {
    expect(isDeclineReason("hated_it")).toBe(false);
    expect(isDeclineReason("")).toBe(false);
    expect(isDeclineReason("NOT_HOME")).toBe(false);
  });

  it("has button copy for every reason", () => {
    for (const r of DECLINE_REASONS) expect(DECLINE_LABELS[r]).toBeTruthy();
  });

  describe("training eligibility", () => {
    it("excludes 'not home', which says nothing about the food", () => {
      // This is the whole point of collecting reasons: a week away used to
      // produce a run of negatives that the model read as dislike.
      expect(isPreferenceSignal("not_home")).toBe(false);
    });

    it("keeps every reason that is a judgement of the meal", () => {
      expect(isPreferenceSignal("not_in_mood")).toBe(true);
      expect(isPreferenceSignal("too_pricey")).toBe(true);
      expect(isPreferenceSignal("too_much_effort")).toBe(true);
    });

    it("treats a plain decline with no reason as a preference signal", () => {
      // Rows predating reasoned declines still carry a real accepted=false.
      expect(isPreferenceSignal(null)).toBe(true);
    });
  });
});
