"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Meal } from "@/lib/types";

interface QueueRow {
  meal: Meal;
  approvedAt: string;
}

export default function QueuePage() {
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [pricing, setPricing] = useState(false);
  const [priceResult, setPriceResult] = useState<string | null>(null);

  useEffect(() => {
    loadQueue();
  }, []);

  function loadQueue() {
    fetch("/api/queue")
      .then((r) => r.json())
      .then((data) => setQueue(data.queue ?? []));
  }

  const unpricedCount = queue.filter((row) => !row.meal.tier).length;

  async function handlePriceApproved() {
    if (
      !confirm(
        `This will call the grocery pricing API for ${unpricedCount} unpriced meal(s) in your queue and spend real API credits. Continue?`
      )
    ) {
      return;
    }
    setPricing(true);
    setPriceResult(null);
    const res = await fetch("/api/admin/price-approved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json();
    setPricing(false);
    if (res.ok) {
      setPriceResult(`Priced ${data.pricedMealIds.length} meal(s).`);
      loadQueue();
    } else {
      setPriceResult(`Error: ${data.error}`);
    }
  }

  return (
    <div className="min-h-screen px-4 py-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Your queue</h1>
        <Link href="/" className="text-sm text-gray-400">
          ← Back to swiping
        </Link>
      </div>

      {unpricedCount > 0 && (
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-2">
          <p className="text-sm text-gray-400">
            {unpricedCount} meal(s) in your queue don't have real prices yet.
          </p>
          <button
            onClick={handlePriceApproved}
            disabled={pricing}
            className="py-3 rounded-full bg-gray-100 text-gray-900 font-semibold disabled:opacity-40"
          >
            {pricing ? "Pricing…" : `Get real prices for ${unpricedCount} meal(s)`}
          </button>
          {priceResult && <p className="text-xs text-gray-500">{priceResult}</p>}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {queue.map(({ meal }) => (
          <div key={meal.id} className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{meal.name}</span>
              <span className="text-sm text-gray-400">
                {meal.tier ? `£${meal.costTwoPerson} (2p)` : "Pricing pending"}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1">{meal.primaryProtein}</p>
          </div>
        ))}
        {queue.length === 0 && <p className="text-gray-500 text-sm">No approved meals yet.</p>}
      </div>
    </div>
  );
}
