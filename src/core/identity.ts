import os from 'node:os';
import type { Git } from './git.js';
import type { Person } from './thread.js';

/** Who is acting, taken from git config so it matches commit authorship. */
export async function resolveIdentity(git: Git): Promise<Person> {
  const [name, email] = await Promise.all([git.configGet('user.name'), git.configGet('user.email')]);
  return {
    name: name ?? os.userInfo().username,
    ...(email ? { email } : {}),
  };
}
