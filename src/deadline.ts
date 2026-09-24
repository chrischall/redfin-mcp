/**
 * Cooperative cancellation for `runBoundedBatch` workers (fleet-audit #956).
 *
 * `runBoundedBatch` (mcp-utils <= 2.6.0) aborts the `signal` it hands each
 * worker when the overall deadline fires and answers the unsettled rows
 * `pending` — but its runners keep dequeuing the next item and never stop
 * an in-flight worker. Every fetch a worker issues after that point goes
 * through the user's signed-in redfin.com tab for a result nobody reads,
 * while the caller is re-running the same `pending` rows. Workers call
 * {@link throwIfAborted} before each request (and inside the
 * retry-once-on-timeout closure) so an abandoned row stops at the next
 * request boundary.
 */
export class DeadlineAbandonedError extends Error {
  constructor() {
    super('batch overall deadline reached; row abandoned');
    this.name = 'DeadlineAbandonedError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DeadlineAbandonedError();
}
