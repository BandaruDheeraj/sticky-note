import pkg from '../../package.json' with { type: 'json' };
import { Cli } from './cli.js';
import { createRegistry } from './commands/index.js';

const cli = new Cli({ bin: 'sticky-note', version: pkg.version, registry: createRegistry() });
process.exitCode = await cli.run(process.argv.slice(2));
