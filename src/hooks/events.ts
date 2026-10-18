/**
 * Agent-neutral hook events. Each agent adapter (Claude Code now, Copilot CLI
 * later) translates its own payloads into these, so handlers are written once.
 */
interface BaseEvent {
  agent: string;
  sessionId: string;
  cwd: string;
}

export type HookEvent =
  | (BaseEvent & { kind: 'session-start'; source: string })
  | (BaseEvent & { kind: 'prompt'; prompt: string })
  | (BaseEvent & { kind: 'tool-used'; toolName: string; toolInput: Record<string, unknown> })
  | (BaseEvent & { kind: 'turn-end' })
  | (BaseEvent & { kind: 'session-end'; reason: string });

export type HookEventKind = HookEvent['kind'];

export interface HookResult {
  /** Text to add to the agent's context, for events that support it. */
  context?: string;
}

export interface AgentAdapter {
  name: string;
  /** Translate a raw stdin payload. Returns null for events we don't handle. */
  parse(payload: unknown): HookEvent | null;
  /** Serialize a result to what the agent expects on stdout. */
  render(event: HookEvent, result: HookResult): string;
}
