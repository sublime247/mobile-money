declare module "opossum" {
  import { EventEmitter } from "events";

  export interface CircuitBreakerOptions {
    timeout?: number | false;
    resetTimeout?: number;
    errorThresholdPercentage?: number;
    rollingCountTimeout?: number;
    rollingCountBuckets?: number;
    volumeThreshold?: number;
    capacity?: number;
    enabled?: boolean;
    allowWarmUp?: boolean;
    enableSnapshots?: boolean;
    name?: string;
    errorFilter?: (error: unknown, ...args: unknown[]) => boolean;
  }

  export default class CircuitBreaker<
    TArgs extends unknown[] = unknown[],
    TResult = unknown,
  > extends EventEmitter {
    constructor(
      action: (...args: TArgs) => Promise<TResult> | TResult,
      options?: CircuitBreakerOptions,
    );

    fire(...args: TArgs): Promise<TResult>;
    fallback(
      func: (...args: [...TArgs, unknown]) => Promise<TResult> | TResult,
    ): this;
    shutdown(): void;

    readonly closed: boolean;
    readonly halfOpen: boolean;
    readonly open: boolean;
  }
}
