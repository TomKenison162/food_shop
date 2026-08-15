"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Meal } from "@/lib/types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function TrainPage() {
  const [candidate, setCandidate] = useState<Meal | null | undefined>(undefined);
  const [dayOfWeek, setDayOfWeek] = useState(new Date().getDay());
  const [isWeekend, setIsWeekend] = useState(dayOfWeek === 0 || dayOfWeek === 6);
  const [temperatureC, setTemperatureC] = useState(15);
  const [count, setCount] = useState(0);
  const [trainStatus, setTrainStatus] = useState<string | null>(null);
  const [training, setTraining] = useState(false);

  useEffect(() => {
    fetch("/api/weather")
      .then((r) => r.json())
      .then((data) => {
        if (typeof data.temperatureC === "number") setTemperatureC(Math.round(data.temperatureC));
      });
    loadCandidate();
  }, []);

  function loadCandidate() {
    fetch("/api/feedback/candidate")
      .then((r) => r.json())
      .then((data) => setCandidate(data.meal));
  }

  function handleDayChange(day: number) {
    setDayOfWeek(day);
    setIsWeekend(day === 0 || day === 6);
  }

  async function respond(accepted: boolean) {
    if (!candidate) return;
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mealId: candidate.id,
        dayOfWeek,
        isWeekend,
        temperatureC,
        accepted,
      }),
    });
    setCount((c) => c + 1);
    loadCandidate();
  }

  async function retrain() {
    setTraining(true);
    setTrainStatus(null);
    const res = await fetch("/api/ml/train", { method: "POST" });
    const data = await res.json();
    setTraining(false);
    setTrainStatus(
      data.trained
        ? `Trained on ${data.sampleCount} examples.`
        : `Not trained yet: ${data.reason}`
    );
  }

  return (
    <div className="min-h-screen px-4 py-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Train the model</h1>
        <Link href="/" className="text-sm text-gray-400">
          ← Back
        </Link>
      </div>
      <p className="text-sm text-gray-400">
        Simulate a day, pick a mood for the weather, and say whether you'd want tonight's
        candidate given that context. Each answer is one training example — {count} logged this
        session.
      </p>

      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-4">
        <div>
          <label className="text-xs uppercase tracking-wide text-gray-400">Day</label>
          <div className="flex flex-wrap gap-2 mt-2">
            {DAYS.map((d, i) => (
              <button
                key={d}
                onClick={() => handleDayChange(i)}
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  dayOfWeek === i ? "bg-gray-100 text-gray-900" : "bg-gray-800 text-gray-300"
                }`}
              >
                {d.slice(0, 3)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-gray-400">
            Temperature: {temperatureC}°C
          </label>
          <input
            type="range"
            min={-5}
            max={35}
            value={temperatureC}
            onChange={(e) => setTemperatureC(Number(e.target.value))}
            className="w-full mt-2"
          />
        </div>
      </div>

      {candidate === undefined && <p className="text-gray-500">Loading…</p>}
      {candidate === null && (
        <p className="text-gray-500">No approved meals yet — go swipe on some first.</p>
      )}
      {candidate && (
        <div className="rounded-3xl bg-gray-900 border border-gray-800 p-6 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold px-3 py-1 rounded-full border border-gray-700 text-gray-300">
              {candidate.tier ? candidate.tier : "unpriced"}
            </span>
            <span className="text-sm text-gray-400">{candidate.primaryProtein}</span>
          </div>
          <h2 className="text-xl font-bold">{candidate.name}</h2>
          <p className="text-sm text-gray-400">{candidate.description}</p>
          <p className="text-xs text-gray-500">
            Would you want to eat this on a {DAYS[dayOfWeek]} at {temperatureC}°C?
          </p>
          <div className="flex gap-3 mt-2">
            <button
              onClick={() => respond(false)}
              className="flex-1 py-3 rounded-full bg-gray-800 text-gray-100 font-semibold"
            >
              No
            </button>
            <button
              onClick={() => respond(true)}
              className="flex-1 py-3 rounded-full bg-gray-100 text-gray-900 font-semibold"
            >
              Yes
            </button>
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 pb-4">
        <button
          onClick={retrain}
          disabled={training}
          className="py-3 rounded-full border border-gray-700 text-gray-100 font-semibold disabled:opacity-40"
        >
          {training ? "Training…" : "Retrain model"}
        </button>
        {trainStatus && <p className="text-xs text-gray-500 text-center">{trainStatus}</p>}
      </div>
    </div>
  );
}
