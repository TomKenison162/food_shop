"use client";

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

  useEffect(() => {
    fetch("/api/queue")
      .then((r) => r.json())
      .then((data) => {
        setNeedsOnboarding((data.queue?.length ?? 0) === 0);
        setOnboardingChecked(true);
      });
  }, []);

  useEffect(() => {
    if (!onboardingChecked || needsOnboarding) return;
    loadDeck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingChecked, needsOnboarding, tier]);

  function loadDeck() {
    const qs = tier === "all" ? "" : `?tier=${tier}`;
    fetch(`/api/meals${qs}`)
      .then((r) => r.json())
      .then((data) => setDeck(data.meals ?? []));
  }

  async function handleDecision(meal: Meal, direction: "approve" | "reject") {
    setDeck((prev) => prev.filter((m) => m.id !== meal.id));
    await fetch(`/api/meals/${meal.id}/${direction}`, { method: "POST" });
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
      <ToggleBar portions={portions} onPortionsChange={setPortions} tier={tier} onTierChange={setTier} />
      <SwipeDeck meals={deck} portions={portions} onDecision={handleDecision} />
      <Link
        href="/queue"
        className="text-center text-sm text-gray-500 py-3 border-t border-gray-800"
      >
        View approved queue →
      </Link>
    </div>
  );
}
