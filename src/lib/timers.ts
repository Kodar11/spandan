/**
 * Resume-delay timer manager.
 *
 * The service worker can be terminated by the browser at any time, so this
 * in-memory timer is only the fast path. The authoritative deadline is the
 * persisted `waitingToResumeUntil` timestamp: every evaluation re-arms this
 * timer for the remaining time if it was lost, and resumes immediately if the
 * deadline already passed (e.g. when the backup alarm wakes a fresh worker).
 */

export type TimerCallback = () => void

let resumeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Schedule a one-shot callback after the given delay.
 *
 * Cancels any previously scheduled resume timer.
 */
export function scheduleResumeTimer(
  callback: TimerCallback,
  delayMs: number,
): void {
  cancelResumeTimer()
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    callback()
  }, delayMs)
}

/**
 * Cancel any pending resume timer.
 */
export function cancelResumeTimer(): void {
  if (resumeTimer) {
    clearTimeout(resumeTimer)
    resumeTimer = null
  }
}

/**
 * Returns true if a resume timer is currently active.
 */
export function hasResumeTimer(): boolean {
  return resumeTimer !== null
}
