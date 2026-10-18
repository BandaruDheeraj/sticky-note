import type { Thread, ThreadStatus } from '../core/thread.js';
import type { Output } from './output.js';

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const units: [number, string][] = [[60, 'm'], [3600, 'h'], [86400, 'd'], [604800, 'w']];
  let label = `${Math.floor(seconds / 60)}m`;
  for (const [size, suffix] of units) if (seconds >= size) label = `${Math.floor(seconds / size)}${suffix}`;
  return `${label} ago`;
}

export function statusLabel(out: Output, status: ThreadStatus): string {
  switch (status) {
    case 'active':
      return out.style(status, 'green');
    case 'stuck':
      return out.style(status, 'yellow', 'bold');
    case 'closed':
      return out.style(status, 'dim');
  }
}

export function printThread(out: Output, t: Thread): void {
  out.print(`${out.style(t.title, 'bold')}  ${statusLabel(out, t.status)}`);
  out.print(out.style(`id ${t.id} · ${t.workType} · ${t.branch ?? 'no branch'}`, 'dim'));
  out.print(`Author:       ${t.author.name}`);
  if (t.contributors.length > 1) out.print(`Contributors: ${t.contributors.map((p) => p.name).join(', ')}`);
  out.print(`Updated:      ${relativeTime(t.updatedAt)} (${t.updatedAt})`);
  if (t.closedAt) out.print(`Closed:       ${t.closedAt}`);
  if (t.files.length) {
    out.print();
    out.print(out.style('Files', 'bold'));
    for (const f of t.files) out.print(`  ${f}`);
  }
  if (t.narrative) {
    out.print();
    out.print(out.style('Narrative', 'bold'));
    out.print(t.narrative);
  }
  if (t.failedApproaches.length) {
    out.print();
    out.print(out.style('Failed approaches', 'bold'));
    for (const f of t.failedApproaches) out.print(`  ✗ ${f.description}${f.reason ? ` — ${f.reason}` : ''}`);
  }
}
