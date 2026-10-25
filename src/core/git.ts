import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${args.join(' ')} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  /** Extra `-c key=value` config applied to this invocation only. */
  config?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

/** Thin, testable wrapper around the git binary, bound to one working directory. */
export class Git {
  constructor(readonly cwd: string) {}

  async run(args: string[], opts: GitRunOptions = {}): Promise<string> {
    const configArgs = Object.entries(opts.config ?? {}).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
    const fullArgs = [...configArgs, ...args];
    try {
      const { stdout } = await execFileAsync('git', fullArgs, {
        cwd: this.cwd,
        env: { ...process.env, ...opts.env },
        maxBuffer: 64 * 1024 * 1024,
        // Callers like the detached sync have no console, so Windows would open one per git call.
        windowsHide: true,
      });
      return stdout.trimEnd();
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
      if (e.code === 'ENOENT') throw new Error('git is not installed or not on PATH');
      throw new GitError(fullArgs, e.stderr ?? e.message, typeof e.code === 'number' ? e.code : null);
    }
  }

  /** Like run(), but returns null instead of throwing on a non-zero exit. */
  async tryRun(args: string[], opts?: GitRunOptions): Promise<string | null> {
    try {
      return await this.run(args, opts);
    } catch (err) {
      if (err instanceof GitError) return null;
      throw err;
    }
  }

  at(cwd: string): Git {
    return new Git(cwd);
  }

  async isRepo(): Promise<boolean> {
    return (await this.tryRun(['rev-parse', '--is-inside-work-tree'])) === 'true';
  }

  async topLevel(): Promise<string> {
    return this.run(['rev-parse', '--show-toplevel']);
  }

  /** The shared .git dir, correct even when cwd is itself a linked worktree. */
  async commonDir(): Promise<string> {
    const dir = await this.run(['rev-parse', '--git-common-dir']);
    return path.resolve(this.cwd, dir);
  }

  async currentBranch(): Promise<string | null> {
    const name = await this.tryRun(['symbolic-ref', '--short', '-q', 'HEAD']);
    return name || null;
  }

  async refExists(ref: string): Promise<boolean> {
    return (await this.tryRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null;
  }

  async hasRemote(remote: string): Promise<boolean> {
    const remotes = await this.run(['remote']);
    return remotes.split('\n').includes(remote);
  }

  async configGet(key: string): Promise<string | null> {
    const value = await this.tryRun(['config', '--get', key]);
    return value || null;
  }
}
