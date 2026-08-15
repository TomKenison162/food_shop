"use client";

import { useState } from "react";
import { motion, PanInfo, useMotionValue, useTransform } from "framer-motion";
import { Meal } from "@/lib/types";
import MealCard from "./MealCard";

interface Props {
  meals: Meal[];
  portions: 1 | 2;
  onDecision: (meal: Meal, direction: "approve" | "reject") => void;
}

export default function SwipeDeck({ meals, portions, onDecision }: Props) {
  const visible = meals.slice(0, 3);

  if (visible.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-8 text-gray-500">
        No more meals in this filter. Try another budget level, or generate more recipes.
      </div>
    );
  }

  return (
    <div className="flex-1 relative flex items-center justify-center px-6 py-8">
      <div className="relative w-full max-w-sm h-[480px]">
        {visible.map((meal, i) => (
          <Card
            key={meal.id}
            meal={meal}
            portions={portions}
            index={i}
            isTop={i === 0}
            onDecision={onDecision}
          />
        ))}
      </div>
    </div>
  );
}

function Card({
  meal,
  portions,
  index,
  isTop,
  onDecision,
}: {
  meal: Meal;
  portions: 1 | 2;
  index: number;
  isTop: boolean;
  onDecision: (meal: Meal, direction: "approve" | "reject") => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-15, 15]);
  const [exiting, setExiting] = useState<"approve" | "reject" | null>(null);

  function handleDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.x > 120) {
      setExiting("approve");
      onDecision(meal, "approve");
    } else if (info.offset.x < -120) {
      setExiting("reject");
      onDecision(meal, "reject");
    }
  }

  return (
    <motion.div
      className="absolute inset-0"
      style={{
        x: isTop ? x : 0,
        rotate: isTop ? rotate : 0,
        zIndex: 10 - index,
      }}
      animate={
        exiting
          ? { x: exiting === "approve" ? 500 : -500, opacity: 0 }
          : { scale: 1 - index * 0.04, y: index * 10, opacity: 1 }
      }
      transition={{ duration: exiting ? 0.3 : 0.2 }}
      drag={isTop && !exiting ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={1}
      onDragEnd={handleDragEnd}
    >
      <MealCard meal={meal} portions={portions} />
    </motion.div>
  );
}
