import { PassThrough, Readable } from 'node:stream';
import { Cli } from '../../src/cli/cli.js';
import { createRegistry } from '../../src/cli/commands/index.js';
import type { CommandRegistry } from '../../src/cli/registry.js';

export interface RunOptions {
  cwd?: string;
  registry?: CommandRegistry;
  stdin?: string;
}

/** Run the CLI in-process and capture its output. */
export async function runCli(argv: string[], opts: RunOptions = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c) => (out += c));
  stderr.on('data', (c) => (err += c));
  const cli = new Cli({
    bin: 'sticky-note',
    version: '0.0.0-test',
    registry: opts.registry ?? createRegistry(),
    streams: { stdout, stderr, color: false },
    stdin: Readable.from([opts.stdin ?? '']),
    cwd: opts.cwd,
  });
  const code = await cli.run(argv);
  return { code, out, err, json: () => JSON.parse(out) };
}
