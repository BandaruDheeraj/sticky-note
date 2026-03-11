#!/usr/bin/env node
/**
 * Git custom merge driver for sticky-note.json
 *
 * Merges threads by ID instead of line-based union merge.
 * For threads present in both sides, the version with the latest
 * last_activity_at wins. Threads unique to either side are preserved.
 *
 * Usage (called by git automatically):
 *   node .sticky-note/merge-driver.js %O %A %B
 *
 * %O = ancestor, %A = ours (result written here), %B = theirs
 */

const fs = require("fs");

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (_) {
    return { version: "2", project: "", threads: [] };
  }
}

function getTimestamp(thread) {
  const ts = thread.last_activity_at || thread.closed_at || thread.created_at || "";
  if (!ts) return 0;
  const t = new Date(ts).getTime();
  return isNaN(t) ? 0 : t;
}

function mergeThreads(ancestor, ours, theirs) {
  const ancestorMap = new Map((ancestor.threads || []).map((t) => [t.id, t]));
  const oursMap = new Map((ours.threads || []).map((t) => [t.id, t]));
  const theirsMap = new Map((theirs.threads || []).map((t) => [t.id, t]));

  const allIds = new Set([...oursMap.keys(), ...theirsMap.keys()]);
  const merged = [];

  for (const id of allIds) {
    const inOurs = oursMap.has(id);
    const inTheirs = theirsMap.has(id);
    const inAncestor = ancestorMap.has(id);

    if (inOurs && inTheirs) {
      // Both sides have it — pick the most recently active version
      const o = oursMap.get(id);
      const t = theirsMap.get(id);
      merged.push(getTimestamp(o) >= getTimestamp(t) ? o : t);
    } else if (inOurs && !inTheirs) {
      // Only in ours — keep unless theirs deliberately removed it
      if (inAncestor) {
        // Was in ancestor, theirs removed it — respect the deletion
      } else {
        merged.push(oursMap.get(id));
      }
    } else if (!inOurs && inTheirs) {
      // Only in theirs — keep unless ours deliberately removed it
      if (inAncestor) {
        // Was in ancestor, ours removed it — respect the deletion
      } else {
        merged.push(theirsMap.get(id));
      }
    }
  }

  return merged;
}

// ── Main ──────────────────────────────────────────────────

const [ancestorPath, oursPath, theirsPath] = process.argv.slice(2);

if (!ancestorPath || !oursPath || !theirsPath) {
  process.stderr.write("Usage: merge-driver.js <ancestor> <ours> <theirs>\n");
  process.exit(1);
}

const ancestor = loadJson(ancestorPath);
const ours = loadJson(oursPath);
const theirs = loadJson(theirsPath);

const mergedThreads = mergeThreads(ancestor, ours, theirs);

// Use ours as the base for non-thread fields (version, project, etc.)
const result = { ...ours, threads: mergedThreads };

fs.writeFileSync(oursPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
process.exit(0);
