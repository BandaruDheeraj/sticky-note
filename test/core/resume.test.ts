import { afterEach, describe, expect, it } from 'vitest';
import { ResumeIntentStore } from '../../src/core/resume.js';
import { cleanupTmpDirs, tmpDir } from '../helpers/repo.js';

afterEach(cleanupTmpDirs);

describe('ResumeIntentStore', () => {
  it('returns null when nothing is armed', async () => {
    const store = new ResumeIntentStore(await tmpDir());
    expect(await store.consume()).toBeNull();
  });

  it('is consumed exactly once', async () => {
    const store = new ResumeIntentStore(await tmpDir());
    await store.set('thread-1');
    expect(await store.consume()).toBe('thread-1');
    expect(await store.consume()).toBeNull();
  });

  it('expires after its ttl', async () => {
    const store = new ResumeIntentStore(await tmpDir());
    const setAt = new Date('2026-10-25T10:00:00Z');
    await store.set('thread-1', setAt, 10 * 60_000);
    expect(await store.consume(new Date(setAt.getTime() + 9 * 60_000))).toBe('thread-1');
  });

  it('is cleared (and not returned) once expired', async () => {
    const store = new ResumeIntentStore(await tmpDir());
    const setAt = new Date('2026-10-25T10:00:00Z');
    await store.set('thread-1', setAt, 10 * 60_000);
    expect(await store.consume(new Date(setAt.getTime() + 11 * 60_000))).toBeNull();
    // The expired intent was discarded on that read, not left for a later, in-window check.
    expect(await store.consume(setAt)).toBeNull();
  });

  it('a later set() replaces an earlier one', async () => {
    const store = new ResumeIntentStore(await tmpDir());
    await store.set('thread-1');
    await store.set('thread-2');
    expect(await store.consume()).toBe('thread-2');
  });
});
