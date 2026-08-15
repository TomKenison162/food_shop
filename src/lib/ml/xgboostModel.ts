import { XGBModel } from "@wlearn/xgboost";

/**
 * Real gradient-boosted trees (XGBoost, compiled to WASM — @wlearn/xgboost),
 * not a hand-rolled approximation and not an LLM. Hyperparameters are
 * deliberately conservative (shallow trees, few rounds, L2 regularization)
 * because the training set is small and personal (tens to low hundreds of
 * examples) — a deep/high-round XGBoost would just memorize it.
 */
const MODEL_PARAMS = {
  objective: "binary:logistic" as const,
  max_depth: 3,
  eta: 0.1,
  numRound: 60,
  subsample: 0.8,
  colsample_bytree: 0.8,
  lambda: 2,
  verbosity: 0 as const,
};

export async function trainXGBoost(X: number[][], y: number[]): Promise<Uint8Array> {
  const model = await XGBModel.create(MODEL_PARAMS);
  try {
    model.fit(X, y);
    return model.save();
  } finally {
    model.dispose();
  }
}

/** Scores every row in one batch (avoids reloading the WASM model per candidate). */
export async function scoreWithXGBoost(modelBuffer: Uint8Array, X: number[][]): Promise<number[]> {
  const model = await XGBModel.load(modelBuffer);
  try {
    const probs = model.predictProba(X); // Float64Array, shape nrow*2 for binary:logistic
    const scores: number[] = [];
    for (let i = 0; i < X.length; i++) {
      scores.push(probs[i * 2 + 1]); // P(accepted=1)
    }
    return scores;
  } finally {
    model.dispose();
  }
}
