/** Typed API error: status + ApiErrorCode + message (+ extra top-level fields such as `current` on a 412). */
import type { ApiErrorCode } from '@jammarly/shared/api';

export class ApiRouteError extends Error {
  override readonly name = 'ApiRouteError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
