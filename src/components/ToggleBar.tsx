"use client";

import { Tier } from "@/lib/types";

const TIERS: { value: Tier | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "budget", label: "Budget" },
  { value: "standard", label: "Standard" },
  { value: "gourmet", label: "Gourmet" },
];

interface Props {
  portions: 1 | 2;
  onPortionsChange: (p: 1 | 2) => void;
  tier: Tier | "all";
  onTierChange: (t: Tier | "all") => void;
}

export default function ToggleBar({ portions, onPortionsChange, tier, onTierChange }: Props) {
  return (
    <div className="sticky top-0 z-20 bg-gray-950/90 backdrop-blur px-4 pt-4 pb-3 flex flex-col gap-3 border-b border-gray-800">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-gray-400 w-20">Portions</span>
        <div className="flex bg-gray-800 rounded-full p-1">
          {[1, 2].map((p) => (
            <button
              key={p}
              onClick={() => onPortionsChange(p as 1 | 2)}
              className={`px-4 py-1 rounded-full text-sm font-medium transition ${
                portions === p ? "bg-gray-100 text-gray-900" : "text-gray-300"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-gray-400 w-20">Budget</span>
        <div className="flex bg-gray-800 rounded-full p-1 overflow-x-auto">
          {TIERS.map((t) => (
            <button
              key={t.value}
              onClick={() => onTierChange(t.value)}
              className={`px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap transition ${
                tier === t.value ? "bg-gray-100 text-gray-900" : "text-gray-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
