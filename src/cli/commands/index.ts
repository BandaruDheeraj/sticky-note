import { CommandRegistry } from '../registry.js';
import { auditCommand } from './audit.js';
import { claimCommand, claimsCommand, unclaimCommand } from './claim.js';
import { closeCommand } from './close.js';
import { contextCommand } from './context.js';
import { initCommand } from './init.js';
import { mcpCommand } from './mcp.js';
import { newCommand } from './new.js';
import { resumeCommand } from './resume.js';
import { runHookCommand } from './run-hook.js';
import { showCommand } from './show.js';
import { statusCommand } from './status.js';
import { syncCommand } from './sync.js';
import { threadsCommand } from './threads.js';
import { whoCommand } from './who.js';

/** Every CLI command. To add one: create a file with defineCommand() and list it here. */
export function createRegistry(): CommandRegistry {
  return new CommandRegistry().register(
    initCommand,
    statusCommand,
    newCommand,
    threadsCommand,
    showCommand,
    closeCommand,
    resumeCommand,
    auditCommand,
    whoCommand,
    claimCommand,
    unclaimCommand,
    claimsCommand,
    contextCommand,
    syncCommand,
    mcpCommand,
    runHookCommand,
  );
}
