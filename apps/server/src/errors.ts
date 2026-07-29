import type { ApiErrorCode } from '@writing-studio/contract';

/** Expected service-layer failure that maps to a stable API error code. */
export class StudioError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StudioError';
  }
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
