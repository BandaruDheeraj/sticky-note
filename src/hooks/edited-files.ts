import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Tools that modify files, and the input field holding the path. */
const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Tools that only read a file. */
const READ_TOOLS: Record<string, string> = {
  Read: 'file_path',
};

export const EDIT_TOOL_NAMES = Object.keys(EDIT_TOOLS);
export const READ_TOOL_NAMES = Object.keys(READ_TOOLS);

/**
 * Repo-relative, POSIX-style paths of files a tool call edited. Files outside
 * the repo are ignored; they aren't shared context.
 */
export function editedFiles(toolName: string, toolInput: Record<string, unknown>, cwd: string, repoRoot: string): string[] {
  return fileFromInput(EDIT_TOOLS[toolName], toolInput, cwd, repoRoot);
}

/** Files a tool call read or edited. */
export function touchedFiles(toolName: string, toolInput: Record<string, unknown>, cwd: string, repoRoot: string): string[] {
  return fileFromInput(EDIT_TOOLS[toolName] ?? READ_TOOLS[toolName], toolInput, cwd, repoRoot);
}

function fileFromInput(field: string | undefined, toolInput: Record<string, unknown>, cwd: string, repoRoot: string): string[] {
  const value = field ? toolInput[field] : undefined;
  if (typeof value !== 'string' || !value) return [];
  const rel = repoRelative(value, cwd, repoRoot);
  return rel ? [rel] : [];
}

/** Repo-relative POSIX path for `file` (absolute or relative to `cwd`), or null if it's outside the repo. */
export function repoRelative(file: string, cwd: string, repoRoot: string): string | null {
  // git reports the repo root with symlinks resolved (e.g. macOS /var → /private/var).
  const rel = path.relative(realPath(repoRoot), realPath(path.resolve(cwd, file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** realpath that tolerates a missing leaf (e.g. a file that was just deleted). */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}
