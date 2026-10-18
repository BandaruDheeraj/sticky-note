import type { AgentAdapter } from '../events.js';
import { claudeCodeAdapter } from './claude-code.js';

/** Supported agents, keyed by the name used in `run-hook <agent>`. */
export const ADAPTERS: Record<string, AgentAdapter> = {
  [claudeCodeAdapter.name]: claudeCodeAdapter,
};
