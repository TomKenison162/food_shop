"use client";

import { withUser } from "@/lib/useUserId";

import { useEffect, useState } from "react";
import { Meal, Tier } from "@/lib/types";
import ToggleBar from "./ToggleBar";
import SwipeDeck from "./SwipeDeck";
import OnboardingGrid from "./OnboardingGrid";
import Link from "next/link";

export default function AppShell() {
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [portions, setPortions] = useState<1 | 2>(2);
  const [tier, setTier] = useState<Tier | "all">("all");
  const [deck, setDeck] = useState<Meal[]>([]);
  const [lastDecision, setLastDecision] = useState<{
    meal: Meal;
    direction: "approve" | "reject";
  } | null>(null);

  useEffect(() => {
    fetch(withUser("/api/queue"))
      .then((r) => r.json())
      .then((data) => {
        setNeedsOnboarding((data.queue?.length ?? 0) === 0);
        setOnboardingChecked(true);
      });
    fetch(withUser("/api/settings"))
      .then((r) => r.json())
      .then((data) => {
        if (data.portions === 1 || data.portions === 2) setPortions(data.portions);
      });
  }, []);

  function handlePortionsChange(p: 1 | 2) {
    setPortions(p);
    fetch(withUser("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portions: p }),
    });
  }

  useEffect(() => {
    if (!onboardingChecked || needsOnboarding) return;
    loadDeck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingChecked, needsOnboarding, tier]);

  function loadDeck() {
    const qs = tier === "all" ? "" : `?tier=${tier}`;
    fetch(withUser(`/api/meals${qs}`))
      .then((r) => r.json())
      .then((data) => setDeck(data.meals ?? []));
  }

  async function handleDecision(meal: Meal, direction: "approve" | "reject") {
    setDeck((prev) => prev.filter((m) => m.id !== meal.id));
    setLastDecision({ meal, direction });
    await fetch(withUser(`/api/meals/${meal.id}/${direction}`), { method: "POST" });
  }

  /** Reverses the most recent swipe — a misswipe shouldn't be permanent. */
  async function handleUndo() {
    if (!lastDecision) return;
    const { meal, direction } = lastDecision;
    setLastDecision(null);
    await fetch(withUser(`/api/meals/${meal.id}/${direction === "reject" ? "restore" : "unapprove"}`), {
      method: "POST",
    });
    setDeck((prev) => [meal, ...prev]);
  }

  if (!onboardingChecked) {
    return <div className="h-screen flex items-center justify-center text-gray-500">Loading…</div>;
  }

  if (needsOnboarding) {
    return (
      <OnboardingGrid
        onDone={() => {
          setNeedsOnboarding(false);
        }}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <ToggleBar portions={portions} onPortionsChange={handlePortionsChange} tier={tier} onTierChange={setTier} />
      <SwipeDeck meals={deck} portions={portions} onDecision={handleDecision} />
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
        {lastDecision ? (
          <button onClick={handleUndo} className="text-sm text-gray-300 underline">
            Undo {lastDecision.direction === "reject" ? "reject" : "approve"} of{" "}
            {lastDecision.meal.name}
          </button>
        ) : (
          <span />
        )}
        <Link href="/queue" className="text-sm text-gray-500">
          Approved queue →
        </Link>
      </div>
    </div>
  );
}
