/**
 * Plain logistic regression trained by batch gradient descent. No external
 * ML library, no LLM — this is the "proper hard machine learning" piece:
 * a small linear model over hand-built features (day of week, weekend,
 * temperature, tier, protein, pantry overlap, recency), trained on the
 * user's own yes/no feedback.
 */
export interface TrainedModel {
  weights: number[];
  bias: number;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function predict(model: TrainedModel, x: number[]): number {
  const z = x.reduce((sum, xi, i) => sum + xi * model.weights[i], model.bias);
  return sigmoid(z);
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
}

/** Trains on (X, y) where y is 0/1. Returns weights + bias. */
export function train(X: number[][], y: number[], options: TrainOptions = {}): TrainedModel {
  const { epochs = 500, learningRate = 0.1, l2 = 0.01 } = options;
  const n = X.length;
  const d = X[0]?.length ?? 0;

  let weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const pred = predict({ weights, bias }, X[i]);
      const error = pred - y[i];
      for (let j = 0; j < d; j++) {
        gradW[j] += error * X[i][j];
      }
      gradB += error;
    }

    for (let j = 0; j < d; j++) {
      weights[j] -= learningRate * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= learningRate * (gradB / n);
  }

  return { weights, bias };
}
