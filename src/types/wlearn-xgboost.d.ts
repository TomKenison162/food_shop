declare module "@wlearn/xgboost" {
  export interface XGBModelParams {
    task?: "classification" | "regression";
    objective?: string;
    max_depth?: number;
    eta?: number;
    numRound?: number;
    num_class?: number;
    subsample?: number;
    colsample_bytree?: number;
    lambda?: number;
    alpha?: number;
    num_parallel_tree?: number;
    verbosity?: 0 | 1 | 2;
    coerce?: "auto" | "warn" | "error";
  }

  export class XGBModel {
    static create(params?: XGBModelParams): Promise<XGBModel>;
    static load(buffer: Uint8Array): Promise<XGBModel>;

    fit(
      X: number[][] | { data: Float64Array; rows: number; cols: number },
      y: number[] | Float64Array,
      opts?: { sampleWeight?: number[] | Float64Array }
    ): this;
    predict(X: number[][]): Float64Array;
    predictProba(X: number[][]): Float64Array;
    score(X: number[][], y: number[]): number;
    save(): Uint8Array;
    getParams(): XGBModelParams;
    setParams(params: XGBModelParams): void;
    dispose(): void;
  }
}
