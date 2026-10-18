import { z } from 'zod';
import type { AgentAdapter, HookEvent } from '../events.js';

const AGENT = 'claude-code';

// Lenient: only the fields we use are required; unknown fields pass through.
const Payload = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string(),
    cwd: z.string(),
    source: z.string().optional(),
    reason: z.string().optional(),
    prompt: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** Claude Code event names that `init` registers, in settings.json order. */
export const CLAUDE_CODE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'] as const;

/** Events whose stdout Claude Code can add to the model's context. */
const CONTEXT_EVENTS: Partial<Record<HookEvent['kind'], string>> = {
  'session-start': 'SessionStart',
  prompt: 'UserPromptSubmit',
};

export const claudeCodeAdapter: AgentAdapter = {
  name: AGENT,

  parse(raw) {
    const p = Payload.parse(raw);
    const base = { agent: AGENT, sessionId: p.session_id, cwd: p.cwd };
    switch (p.hook_event_name) {
      case 'SessionStart':
        return { ...base, kind: 'session-start', source: p.source ?? 'startup' };
      case 'UserPromptSubmit':
        return { ...base, kind: 'prompt', prompt: p.prompt ?? '' };
      case 'PostToolUse':
        return { ...base, kind: 'tool-used', toolName: p.tool_name ?? '', toolInput: p.tool_input ?? {} };
      case 'Stop':
        return { ...base, kind: 'turn-end' };
      case 'SessionEnd':
        return { ...base, kind: 'session-end', reason: p.reason ?? 'other' };
      default:
        return null;
    }
  },

  render(event, result) {
    const hookEventName = CONTEXT_EVENTS[event.kind];
    if (!hookEventName || !result.context) return '';
    return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: result.context } });
  },
};
