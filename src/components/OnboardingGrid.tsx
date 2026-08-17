"use client";

import { withUser } from "@/lib/useUserId";

import { useEffect, useState } from "react";
import { Meal } from "@/lib/types";

interface Props {
  onDone: () => void;
}

export default function OnboardingGrid({ onDone }: Props) {
  const [classics, setClassics] = useState<Meal[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(withUser("/api/classics"))
      .then((r) => r.json())
      .then((data) => setClassics(data.meals));
  }, []);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleContinue() {
    setSubmitting(true);
    await Promise.all(
      [...selected].map((id) => fetch(withUser(`/api/meals/${id}/approve`), { method: "POST" }))
    );
    setSubmitting(false);
    onDone();
  }

  return (
    <div className="flex flex-col h-screen px-4 py-6 gap-4">
      <div>
        <h1 className="text-2xl font-bold">Welcome</h1>
        <p className="text-gray-400 text-sm mt-1">
          Tap the dishes you already love. We'll add them to your queue so you're not starting
          from zero.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto grid grid-cols-2 gap-3 pb-4">
        {classics.map((meal) => {
          const isSelected = selected.has(meal.id);
          return (
            <button
              key={meal.id}
              onClick={() => toggle(meal.id)}
              className={`rounded-2xl p-4 text-left border transition ${
                isSelected
                  ? "bg-gray-100 text-gray-900 border-gray-100"
                  : "bg-gray-900 text-gray-100 border-gray-800"
              }`}
            >
              <div className="font-semibold text-sm">{meal.name}</div>
              <div className={`text-xs mt-1 ${isSelected ? "text-gray-600" : "text-gray-500"}`}>
                {meal.primaryProtein}
              </div>
            </button>
          );
        })}
      </div>

      <button
        onClick={handleContinue}
        disabled={submitting || selected.size === 0}
        className="w-full py-4 rounded-full bg-gray-100 text-gray-900 font-semibold disabled:opacity-40"
      >
        {submitting ? "Adding…" : `Continue (${selected.size} selected)`}
      </button>
      <button onClick={onDone} className="text-sm text-gray-500 text-center">
        Skip for now
      </button>
    </div>
  );
}
