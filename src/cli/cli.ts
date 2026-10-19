import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { GLOBAL_OPTIONS, type AnyCommand, type OptionSpecs } from './command.js';
import { Services, type CommandContext } from './context.js';
import { CliError, ExitCode, UsageError } from './errors.js';
import { Output, type OutputStreams } from './output.js';
import type { CommandRegistry } from './registry.js';

export interface CliOptions {
  bin: string;
  version: string;
  registry: CommandRegistry;
  streams?: OutputStreams;
  stdin?: NodeJS.ReadableStream;
  cwd?: string;
}

/** Parses argv, dispatches to a registered command, and maps errors to exit codes. */
export class Cli {
  private readonly streams: OutputStreams;

  constructor(private readonly opts: CliOptions) {
    this.streams = opts.streams ?? { stdout: process.stdout, stderr: process.stderr };
  }

  async run(argv: string[]): Promise<number> {
    const first = argv[0];
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      const target = first === 'help' ? this.opts.registry.resolve(argv.slice(1)) : null;
      this.write(target ? this.commandHelp(target.command) : this.globalHelp());
      return ExitCode.Ok;
    }
    if (first === '--version' || first === '-v') {
      this.write(`${this.opts.version}\n`);
      return ExitCode.Ok;
    }

    const resolved = this.opts.registry.resolve(argv);
    if (!resolved) {
      return this.fail(new UsageError(`Unknown command "${first}"`, `Run "${this.opts.bin} --help" to see available commands.`), false);
    }

    const { command, rest } = resolved;
    let jsonMode = false;
    try {
      const input = this.parse(command, rest);
      jsonMode = input.options.json === true;
      if (input.options.help) {
        this.write(this.commandHelp(command));
        return ExitCode.Ok;
      }
      const cwd = path.resolve(this.opts.cwd ?? process.cwd(), input.options.cwd ?? '.');
      const ctx: CommandContext = {
        cwd,
        out: new Output(this.streams, jsonMode),
        stdin: this.opts.stdin ?? process.stdin,
        services: new Services(cwd),
      };
      return (await command.run(ctx, input)) ?? ExitCode.Ok;
    } catch (err) {
      return this.fail(err, jsonMode, command);
    }
  }

  private parse(command: AnyCommand, argv: string[]) {
    const specs: OptionSpecs = { ...GLOBAL_OPTIONS, ...command.options };
    const options: NonNullable<ParseArgsConfig['options']> = {};
    for (const [name, spec] of Object.entries(specs)) {
      options[name] = { type: spec.type, ...(spec.short && { short: spec.short }), ...(spec.multiple && { multiple: true }) };
    }

    let parsed;
    try {
      parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    } catch (err) {
      throw new UsageError((err as Error).message.split('\n')[0]!, `Run "${this.opts.bin} ${command.name} --help" for usage.`);
    }

    const argSpecs = command.args ?? [];
    const positionals = [...parsed.positionals];
    const args: Record<string, string | undefined> = {};
    let rest: string[] = [];
    for (const spec of argSpecs) {
      if (spec.variadic) {
        rest = positionals.splice(0);
        args[spec.name] = rest.join(' ') || undefined;
      } else {
        args[spec.name] = positionals.shift();
      }
    }
    if (!parsed.values.help) {
      const missing = argSpecs.find((s) => s.required && args[s.name] === undefined);
      if (missing) throw new UsageError(`Missing required argument <${missing.name}>`, `Usage: ${this.usageLine(command)}`);
      if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`, `Usage: ${this.usageLine(command)}`);
    }
    return { args, rest, options: parsed.values as Record<string, never> };
  }

  private fail(err: unknown, jsonMode: boolean, command?: AnyCommand): number {
    const out = new Output(this.streams, jsonMode);
    const isExpected = err instanceof CliError;
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = isExpected ? err.exitCode : ExitCode.Error;

    if (jsonMode) out.json({ ok: false, error: { message, ...(command && { command: command.name }) } });
    out.error(message);
    if (isExpected && err.hint) this.streams.stderr.write(`${err.hint}\n`);
    if (!isExpected && process.env.STICKY_DEBUG && err instanceof Error && err.stack) {
      this.streams.stderr.write(`${err.stack}\n`);
    }
    return exitCode;
  }

  private write(text: string): void {
    this.streams.stdout.write(text);
  }

  // --- help ------------------------------------------------------------------

  private usageLine(command: AnyCommand): string {
    const args = (command.args ?? []).map((a) => {
      const label = a.variadic ? `${a.name}...` : a.name;
      return a.required ? `<${label}>` : `[${label}]`;
    });
    return [this.opts.bin, command.name, ...args, '[options]'].join(' ');
  }

  globalHelp(): string {
    const commands = this.opts.registry.list();
    const width = Math.max(...commands.map((c) => c.name.length));
    return [
      `${this.opts.bin} ${this.opts.version}`,
      'Shared memory for your team\'s AI coding agents.',
      '',
      `Usage: ${this.opts.bin} <command> [options]`,
      '',
      'Commands:',
      ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
      '',
      'Global options:',
      ...formatOptions(GLOBAL_OPTIONS),
      '',
      `Run "${this.opts.bin} <command> --help" for details on a command.`,
      '',
    ].join('\n');
  }

  commandHelp(command: AnyCommand): string {
    const lines = [`Usage: ${this.usageLine(command)}`, '', command.description ?? command.summary];
    if (command.aliases?.length) lines.push('', `Aliases: ${command.aliases.join(', ')}`);
    if (command.args?.length) {
      const width = Math.max(...command.args.map((a) => a.name.length));
      lines.push('', 'Arguments:', ...command.args.map((a) => `  ${a.name.padEnd(width)}  ${a.description}`));
    }
    if (command.options && Object.keys(command.options).length) lines.push('', 'Options:', ...formatOptions(command.options));
    lines.push('', 'Global options:', ...formatOptions(GLOBAL_OPTIONS));
    if (command.examples?.length) lines.push('', 'Examples:', ...command.examples.map((e) => `  ${e}`));
    return `${lines.join('\n')}\n`;
  }
}

function formatOptions(specs: OptionSpecs): string[] {
  const rows = Object.entries(specs).map(([name, spec]) => {
    const flag = `${spec.short ? `-${spec.short}, ` : '    '}--${name}${spec.type === 'string' ? ` ${spec.valueName ?? '<value>'}` : ''}`;
    return [flag, `${spec.description}${spec.multiple ? ' (repeatable)' : ''}`] as const;
  });
  const width = Math.max(...rows.map(([f]) => f.length));
  return rows.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`);
}
