#!/usr/bin/env node
/**
 * Git custom merge driver for sticky-note.json
 *
 * Merges threads by ID with field-level 3-way merge instead of
 * line-based union merge. For threads present in both sides, each
 * field is merged individually using ancestor-aware rules.
 *
 * Usage (called by git automatically):
 *   node .sticky-note/merge-driver.js %O %A %B
 *
 * %O = ancestor, %A = ours (result written here), %B = theirs
 *
 * Also exports merge helpers for use by sticky-utils.js saveMemoryMerged().
 */

const fs = require("fs");

// Fields that are merged as set-union (deduplicated)
const SET_UNION_FIELDS = [
  "files_touched", "contributors", "related_session_ids",
];

// Fields that are merged as ordered-dedupe with a size cap
const CAPPED_ARRAY_FIELDS = {
  prompts: 20,
  activities: 20,
};

// Fields merged by deduping on stringified value
const DEDUPE_ARRAY_FIELDS = [
  "failed_approaches", "resume_chain", "resume_history",
];

function loadJsonStrict(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function loadJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (_) {
    return { version: "2", project: "", threads: [] };
  }
}

function getTimestamp(thread) {
  if (!thread) return 0;
  const ts = thread.last_activity_at || thread.closed_at || thread.created_at || "";
  if (!ts) return 0;
  const t = new Date(ts).getTime();
  return isNaN(t) ? 0 : t;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function dedupeArray(arr) {
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    const key = typeof item === "string" ? item : JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function sumToolCalls(a, b) {
  if (!a && !b) return {};
  const result = { ...(a || {}) };
  for (const [key, val] of Object.entries(b || {})) {
    result[key] = (result[key] || 0) + (typeof val === "number" ? val : 0);
  }
  return result;
}

/**
 * Merge a single thread using 3-way (ancestor-aware) or 2-way merge.
 * @param {object|null} ancestor - ancestor version (null for 2-way merge)
 * @param {object} ours - our version
 * @param {object} theirs - their version
 * @returns {object} merged thread
 */
function mergeOneThread(ancestor, ours, theirs) {
  const merged = { ...ours };
  const allKeys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);

  for (const key of allKeys) {
    if (key === "id") continue; // never change ID
    const oVal = ours[key];
    const tVal = theirs[key];

    // If both sides are the same, nothing to merge
    if (jsonEqual(oVal, tVal)) continue;

    if (ancestor) {
      // 3-way merge: check what changed from ancestor
      const aVal = ancestor[key];
      const oursChanged = !jsonEqual(oVal, aVal);
      const theirsChanged = !jsonEqual(tVal, aVal);

      if (!oursChanged && theirsChanged) {
        // Only theirs changed — take theirs
        merged[key] = tVal;
        continue;
      } else if (oursChanged && !theirsChanged) {
        // Only ours changed — already in merged
        continue;
      }
      // Both changed — fall through to conflict resolution
    }

    // Conflict resolution (both changed, or 2-way merge)
    if (SET_UNION_FIELDS.includes(key)) {
      merged[key] = dedupeArray([...(oVal || []), ...(tVal || [])]);
    } else if (key in CAPPED_ARRAY_FIELDS) {
      merged[key] = dedupeArray([...(oVal || []), ...(tVal || [])]).slice(
        -(CAPPED_ARRAY_FIELDS[key])
      );
    } else if (DEDUPE_ARRAY_FIELDS.includes(key)) {
      merged[key] = dedupeArray([...(oVal || []), ...(tVal || [])]);
    } else if (key === "tool_calls") {
      merged[key] = sumToolCalls(oVal, tVal);
    } else {
      // Scalar conflict: take from the more recently active side
      merged[key] = getTimestamp(ours) >= getTimestamp(theirs) ? oVal : tVal;
    }
  }

  return merged;
}

/**
 * 2-way merge for concurrent local writes (no ancestor available).
 */
function mergeOneThread2Way(ours, theirs) {
  return mergeOneThread(null, ours, theirs);
}

function mergeThreads(ancestor, ours, theirs) {
  const ancestorMap = new Map((ancestor.threads || []).filter(Boolean).map((t) => [t.id, t]));
  const oursMap = new Map((ours.threads || []).filter(Boolean).map((t) => [t.id, t]));
  const theirsMap = new Map((theirs.threads || []).filter(Boolean).map((t) => [t.id, t]));

  const allIds = new Set([...oursMap.keys(), ...theirsMap.keys()]);
  const merged = [];

  for (const id of allIds) {
    const inOurs = oursMap.has(id);
    const inTheirs = theirsMap.has(id);
    const inAncestor = ancestorMap.has(id);

    if (inOurs && inTheirs) {
      // Both sides have it — field-level merge
      merged.push(
        mergeOneThread(ancestorMap.get(id) || null, oursMap.get(id), theirsMap.get(id))
      );
    } else if (inOurs && !inTheirs) {
      if (inAncestor) {
        // Was in ancestor, theirs removed it — respect the deletion
      } else {
        merged.push(oursMap.get(id));
      }
    } else if (!inOurs && inTheirs) {
      if (inAncestor) {
        // Was in ancestor, ours removed it — respect the deletion
      } else {
        merged.push(theirsMap.get(id));
      }
    }
  }

  return merged;
}

// ── Main (only when run directly by git) ──────────────────

if (require.main === module) {
  const [ancestorPath, oursPath, theirsPath] = process.argv.slice(2);

  if (!ancestorPath || !oursPath || !theirsPath) {
    process.stderr.write("Usage: merge-driver.js <ancestor> <ours> <theirs>\n");
    process.exit(1);
  }

  // Ancestor may not exist (new file) — safe fallback is OK
  const ancestor = loadJsonSafe(ancestorPath);

  // Ours and theirs must be valid JSON — fail to git conflict if not
  let ours, theirs;
  try {
    ours = loadJsonStrict(oursPath);
  } catch (err) {
    process.stderr.write(`[sticky-note] merge-driver: failed to parse ours (${oursPath}): ${err.message}\n`);
    process.exit(1);
  }
  try {
    theirs = loadJsonStrict(theirsPath);
  } catch (err) {
    process.stderr.write(`[sticky-note] merge-driver: failed to parse theirs (${theirsPath}): ${err.message}\n`);
    process.exit(1);
  }

  const mergedThreads = mergeThreads(ancestor, ours, theirs);
  const result = { ...ours, threads: mergedThreads };

  fs.writeFileSync(oursPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
  process.exit(0);
}

// ── Exports for use by sticky-utils.js ────────────────────

module.exports = { mergeOneThread, mergeOneThread2Way, mergeThreads, getTimestamp };
