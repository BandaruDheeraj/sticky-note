import type { AnyCommand } from './command.js';

/** Holds commands and resolves argv tokens to one, supporting multi-word names. */
export class CommandRegistry {
  private readonly byName = new Map<string, AnyCommand>();
  private readonly ordered: AnyCommand[] = [];

  register(...commands: AnyCommand[]): this {
    for (const command of commands) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        if (this.byName.has(name)) throw new Error(`Duplicate command name: ${name}`);
        this.byName.set(name, command);
      }
      this.ordered.push(command);
    }
    return this;
  }

  /** Longest-prefix match over leading non-flag tokens, e.g. ["env", "add-server", "x"]. */
  resolve(argv: string[]): { command: AnyCommand; rest: string[] } | null {
    const words: string[] = [];
    for (const token of argv) {
      if (token.startsWith('-')) break;
      words.push(token);
    }
    for (let n = words.length; n > 0; n--) {
      const command = this.byName.get(words.slice(0, n).join(' '));
      if (command) return { command, rest: argv.slice(n) };
    }
    return null;
  }

  list(): AnyCommand[] {
    return this.ordered.filter((c) => !c.hidden);
  }
}
