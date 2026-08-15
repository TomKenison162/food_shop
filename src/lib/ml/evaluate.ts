import { trainXGBoost, scoreWithXGBoost } from "./xgboostModel";

export interface Evaluation {
  /** Leave-one-out accuracy of the model. */
  accuracy: number;
  /** Accuracy of always predicting the majority class — the bar to beat. */
  baselineAccuracy: number;
  /** True when the model is meaningfully better than that bar. */
  beatsBaseline: boolean;
  folds: number;
}

/** Must beat the majority-class baseline by this much to be worth using. */
const REQUIRED_MARGIN = 0.05;

/**
 * Leave-one-out cross-validation.
 *
 * With a personal dataset this small, a single train/test split would be
 * dominated by which handful of days landed in the test set, so every
 * example gets to be the test set exactly once. It's affordable precisely
 * because the data is tiny.
 *
 * The comparison that matters is against always predicting the majority
 * class, not against 50%. If you accept 85% of suggestions, a model that's
 * 85% accurate has learned nothing — it's just echoing the base rate, and
 * using it to rank meals would add confident noise on top of the rules.
 */
export async function leaveOneOutEvaluate(X: number[][], y: number[]): Promise<Evaluation> {
  const n = X.length;
  const positives = y.filter((v) => v === 1).length;
  const baselineAccuracy = Math.max(positives, n - positives) / n;

  let correct = 0;
  for (let i = 0; i < n; i++) {
    const trainX = X.filter((_, j) => j !== i);
    const trainY = y.filter((_, j) => j !== i);

    // A fold with only one class can't train a useful classifier; fall back
    // to predicting that class, which is what the model would learn anyway.
    if (new Set(trainY).size < 2) {
      if (trainY[0] === y[i]) correct++;
      continue;
    }

    const model = await trainXGBoost(trainX, trainY);
    const [p] = await scoreWithXGBoost(model, [X[i]]);
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
  }

  const accuracy = correct / n;
  return {
    accuracy,
    baselineAccuracy,
    beatsBaseline: accuracy >= baselineAccuracy + REQUIRED_MARGIN,
    folds: n,
  };
}
