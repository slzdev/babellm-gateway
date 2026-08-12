/**
 * Round-robin cursors, one per virtual model, held in process memory.
 *
 * This is deliberately not the `rr_cursors` table the gateway spec describes.
 * In-memory is correct for a single instance and skews across several — two
 * processes keep independent counters, both start at zero, and both favour
 * the same target. That trade was made knowingly; this module exists so that
 * reversing it means replacing one file rather than untangling selection.
 *
 * State also resets on restart, which round robin tolerates: the guarantee is
 * "spread requests across targets", not "resume where the last process left".
 */
const cursors = new Map<string, number>()

// Kept well inside the exact-integer range so a long-lived process never
// reaches the point where += 1 stops changing the value.
export const WRAP = 0x7fffffff

/** Returns the current cursor for a model, then advances it. */
export function nextCursor(virtualModelId: string): number {
  const current = cursors.get(virtualModelId) ?? 0
  cursors.set(virtualModelId, (current + 1) % WRAP)
  return current
}

/** Test-only. Nothing in the request path should ever clear cursors. */
export function resetCursors(): void {
  cursors.clear()
}

/** Test-only. Lets a test drive the cursor to its wrap boundary directly. */
export function seedCursor(virtualModelId: string, value: number): void {
  cursors.set(virtualModelId, value)
}
