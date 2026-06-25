import type { ErrorType } from "./types.js";

/** Thrown for any non-2xx API response. Carries the HTTP status and error type. */
export class LienError extends Error {
  readonly status: number;
  readonly type: ErrorType | string;
  readonly param?: string;

  constructor(status: number, type: ErrorType | string, message: string, param?: string) {
    super(message);
    this.name = "LienError";
    this.status = status;
    this.type = type;
    this.param = param;
  }

  /** 429 and 5xx are safe to retry with backoff; 4xx are not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
