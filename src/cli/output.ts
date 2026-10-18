export interface OutputStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Defaults to stdout.isTTY && !NO_COLOR. */
  color?: boolean;
}

const codes = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 } as const;
type Style = keyof typeof codes;

/**
 * All user-facing output goes through here so commands stay testable and
 * `--json` output stays clean (human messages go to stderr in JSON mode).
 */
export class Output {
  readonly color: boolean;

  constructor(
    private readonly streams: OutputStreams,
    readonly jsonMode = false,
  ) {
    const isTTY = (streams.stdout as NodeJS.WriteStream).isTTY === true;
    this.color = streams.color ?? (isTTY && !process.env.NO_COLOR);
  }

  style(text: string, ...styles: Style[]): string {
    if (!this.color || styles.length === 0) return text;
    return `\x1b[${styles.map((s) => codes[s]).join(';')}m${text}\x1b[0m`;
  }

  /** Primary human-readable output. Suppressed in JSON mode. */
  print(text = ''): void {
    if (!this.jsonMode) this.streams.stdout.write(`${text}\n`);
  }

  success(text: string): void {
    this.print(`${this.style('✓', 'green')} ${text}`);
  }

  warn(text: string): void {
    this.streams.stderr.write(`${this.style('warning:', 'yellow')} ${text}\n`);
  }

  error(text: string): void {
    this.streams.stderr.write(`${this.style('error:', 'red', 'bold')} ${text}\n`);
  }

  /** Emit the command's result. Only prints in JSON mode. */
  json(data: unknown): void {
    if (this.jsonMode) this.streams.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }

  table(rows: string[][], header?: string[]): void {
    const all = header ? [header, ...rows] : rows;
    if (all.length === 0) return;
    const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => visibleLength(r[i] ?? ''))));
    const fmt = (r: string[]) =>
      r.map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]!))).join('  ').trimEnd();
    if (header) this.print(this.style(fmt(header), 'bold'));
    for (const r of rows) this.print(fmt(r));
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => s.replace(ANSI, '').length;
const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - visibleLength(s)));
