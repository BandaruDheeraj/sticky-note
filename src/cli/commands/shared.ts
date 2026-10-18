import { AmbiguousIdError, type ThreadStore } from '../../core/store/thread-store.js';
import type { Thread } from '../../core/thread.js';
import { CliError } from '../errors.js';

export async function requireThread(store: ThreadStore, idOrPrefix: string): Promise<Thread> {
  try {
    const thread = await store.get(idOrPrefix);
    if (!thread) throw new CliError(`No thread matches "${idOrPrefix}"`, 1, 'Run "sticky-note threads -a" to list ids.');
    return thread;
  } catch (err) {
    if (err instanceof AmbiguousIdError) throw new CliError(err.message, 1, 'Use more characters of the id.');
    throw err;
  }
}
