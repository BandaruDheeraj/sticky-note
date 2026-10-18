import type { CommandContext } from './context.js';

export interface OptionSpec {
  type: 'string' | 'boolean';
  description: string;
  short?: string;
  /** Allow repeating the flag; value becomes string[]. */
  multiple?: boolean;
  /** Placeholder shown in help, e.g. <path>. */
  valueName?: string;
}

export type OptionSpecs = Record<string, OptionSpec>;

type ValueOf<S extends OptionSpec> = S['type'] extends 'boolean'
  ? boolean
  : S['multiple'] extends true
    ? string[]
    : string;

export type OptionValues<O extends OptionSpecs> = { [K in keyof O]?: ValueOf<O[K]> };

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  /** Collect all remaining positionals, joined by spaces. Must be last. */
  variadic?: boolean;
}

export interface CommandInput<O extends OptionSpecs> {
  args: Record<string, string | undefined>;
  options: OptionValues<O> & GlobalOptionValues;
}

export interface Command<O extends OptionSpecs = OptionSpecs> {
  /** Space-separated for subcommands, e.g. "env add-server". */
  name: string;
  aliases?: string[];
  summary: string;
  description?: string;
  args?: ArgSpec[];
  options?: O;
  examples?: string[];
  /** Hidden commands are dispatchable but omitted from help (e.g. run-hook). */
  hidden?: boolean;
  /** Return an exit code; undefined means 0. */
  run(ctx: CommandContext, input: CommandInput<O>): Promise<number | void>;
}

/** Identity helper that preserves option types for `run`. */
export function defineCommand<const O extends OptionSpecs = {}>(command: Command<O>): Command<O> {
  return command;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = Command<any>;

export const GLOBAL_OPTIONS = {
  json: { type: 'boolean', description: 'Output machine-readable JSON' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
  cwd: { type: 'string', valueName: '<dir>', description: 'Run as if started in <dir>' },
} as const satisfies OptionSpecs;

export type GlobalOptionValues = OptionValues<typeof GLOBAL_OPTIONS>;
