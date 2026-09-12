import 'server-only'

/**
 * A bound on how long storage may take before it counts as absent.
 *
 * Every Firestore call in this product already degrades: a video that cannot be
 * cached is a re-ingest, a history entry that cannot be written is forgotten,
 * and `lib/server/quota.ts` **allows** a request whose ledger is unreachable,
 * because losing a cap beats losing the product.
 *
 * None of that helped, because a Firestore client pointed at somewhere nothing
 * is listening does not fail — it retries, with backoff, for about ninety
 * seconds. Measured here: an ingest against a configured-but-absent emulator
 * sat on "Looking up the video" for 86 s and then threw. In production that is
 * a request spending most of a 300-second function budget to arrive at a
 * degraded mode it could have reached immediately.
 *
 * So the degradation has to be on a clock. A storage call that has not answered
 * in a few seconds is treated exactly as one that failed, which is a path every
 * caller already handles.
 */

/**
 * Five seconds.
 *
 * Firestore answers a document read in tens of milliseconds; a hundred times
 * that is not slowness, it is absence. Long enough that a cold connection or a
 * bad minute on the network is not mistaken for an outage, short enough that a
 * user waiting on an ingest does not notice it happening.
 *
 * **It accumulates, and that is accepted rather than solved.** One ingest makes
 * about five storage calls — claim, cache read, cache write, history, settle —
 * so a total outage costs up to twenty-five seconds of waiting spread across
 * the request. That is bounded, it only happens when storage is entirely gone,
 * and it is far inside the route's own 300-second ceiling. A circuit breaker
 * that stopped trying after the first timeout would remove it, and would be
 * real machinery carried permanently for a case that should be rare; if
 * outages stop being rare, that is the fix.
 */
export const STORAGE_TIMEOUT_MS = 5_000

export class StorageTimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`${operation} did not answer within ${ms}ms`)
    this.name = 'StorageTimeoutError'
  }
}

/**
 * Reject if `work` has not settled in time.
 *
 * The underlying call is **not** cancelled — Firestore's client offers no way
 * to — so it carries on in the background and its result is discarded. That is
 * the right trade for a read. For a write it means the write may still land
 * after the caller has given up, which is harmless here: every write in the
 * request path is idempotent (a cache put, a history touch) or is a
 * transaction that is safe to lose.
 *
 * The timer is cleared on the happy path, so this does not hold the event loop
 * open for five seconds after every successful read.
 */
export async function withTimeout<T>(
  operation: string,
  work: Promise<T>,
  ms: number = STORAGE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageTimeoutError(operation, ms)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
