/**
 * Cooperative cancellation for batch workers (fleet-audit #956).
 *
 * A batch worker that issues several requests per row (climate's page +
 * data fetch, the resolver's rung ladder) calls {@link throwIfAborted}
 * before each one, so a row the overall deadline already answered
 * `pending` stops at the next request boundary instead of fetching
 * through the user's signed-in redfin.com tab for a result nobody reads.
 * (mcp-utils >= 2.12 `runBoundedBatch` itself stops dequeuing once the
 * deadline or the caller's cancel fires; this guard covers the requests
 * INSIDE an in-flight row.)
 *
 * Both now come from realty-core (`RowAbandonedError` / `throwIfAborted`,
 * fleet-audit#1091) — byte-for-byte the local copies they replace —
 * re-exported under redfin's existing names.
 */
export {
  RowAbandonedError as DeadlineAbandonedError,
  throwIfAborted,
} from '@chrischall/realty-core';
