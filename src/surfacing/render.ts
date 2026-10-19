import type { ActiveClaim } from '../core/claim.js';
import type { Thread } from '../core/thread.js';
import { isLive, type RankedThread } from './relevance.js';

const MAX_FILES = 4;
const MAX_NARRATIVE = 240;

/**
 * Plain-text block injected into the agent's context. Kept short and in a
 * fixed shape so the agent can relay it and it's easy to eyeball in logs.
 */
export function renderContext(heading: string, ranked: RankedThread[], now: Date): string {
  if (ranked.length === 0) return '';
  const lines = [`[sticky-note] ${heading}`];
  for (const { thread: t, reasons } of ranked) {
    lines.push(`- ${headline(t, now)}`);
    if (t.files.length) lines.push(`  Files: ${listFiles(t.files)}`);
    const narrative = t.narrative.trim().replace(/\s+/g, ' ');
    if (narrative) lines.push(`  Notes: ${truncate(narrative, MAX_NARRATIVE)}`);
    for (const f of t.failedApproaches.slice(-3)) lines.push(`  Tried, didn't work: ${f.description}${f.reason ? ` (${f.reason})` : ''}`);
    if (reasons.length) lines.push(`  Why shown: ${reasons.join('; ')}`);
  }
  lines.push('Details: `sticky-note show <id>`. Tell the user about anything here that affects their request.');
  return lines.join('\n');
}

export function renderOverlapWarning(file: string, threads: Thread[], now: Date): string {
  const lines = [`[sticky-note] ${file} is part of a teammate's open work:`];
  for (const t of threads.slice(0, 3)) {
    const who = t.contributors.at(-1)?.name ?? t.author.name;
    const when = isLive(t, now) ? 'working on it right now' : `last active ${ago(t.updatedAt, now)}`;
    lines.push(`- ${who} (${when}): "${t.title}" [${t.status}] id ${t.id}`);
  }
  lines.push('Consider checking with them before editing, to avoid conflicting changes.');
  return lines.join('\n');
}

export function renderClaimWarning(file: string, claims: ActiveClaim[], now: Date): string {
  const lines = [`[sticky-note] ${file} is claimed by a teammate:`];
  for (const c of claims) {
    lines.push(`- ${c.owner.name}${c.reason ? `: ${c.reason}` : ''} (claimed ${ago(c.claimedAt, now)}, until ${c.expiresAt})`);
  }
  lines.push('Ask the user before editing this file; they may want to coordinate with the claimant first.');
  return lines.join('\n');
}

function headline(t: Thread, now: Date): string {
  const status = isLive(t, now) ? 'IN PROGRESS' : t.status.toUpperCase();
  const branch = t.branch ? ` · branch ${t.branch}` : '';
  return `${status} · "${t.title}" · ${t.author.name} · ${ago(t.updatedAt, now)}${branch} · id ${t.id}`;
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, MAX_FILES).join(', ');
  return files.length > MAX_FILES ? `${shown} (+${files.length - MAX_FILES} more)` : shown;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
