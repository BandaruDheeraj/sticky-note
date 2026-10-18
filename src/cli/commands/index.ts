import { CommandRegistry } from '../registry.js';
import { closeCommand } from './close.js';
import { initCommand } from './init.js';
import { newCommand } from './new.js';
import { showCommand } from './show.js';
import { statusCommand } from './status.js';
import { syncCommand } from './sync.js';
import { threadsCommand } from './threads.js';

/** Every CLI command. To add one: create a file with defineCommand() and list it here. */
export function createRegistry(): CommandRegistry {
  return new CommandRegistry().register(
    initCommand,
    statusCommand,
    newCommand,
    threadsCommand,
    showCommand,
    closeCommand,
    syncCommand,
  );
}
