import type { ErrorCode } from "@odft/contracts";

/** Typed deterministic-domain failure carrying a safe error code. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
