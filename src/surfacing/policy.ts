/**
 * How much to inject, and when. Shared by the hooks and `sticky-note context`
 * so the preview always matches what agents actually get.
 */
export const SESSION_START_MIN_SCORE = 1.2;
export const SESSION_START_LIMIT = 5;
export const PROMPT_MIN_SCORE = 2;
export const PROMPT_LIMIT = 3;
/** Minimum gap between background syncs started by one session. */
export const BACKGROUND_SYNC_INTERVAL_MS = 2 * 60_000;
