/**
 * Cloudflare KV adapter for Sticky Note V3.
 *
 * KV key schema (all prefixed by project):
 *   {project}:thread:{uuid}           → thread JSON
 *   {project}:thread-index            → JSON array of thread UUIDs
 *   {project}:audit:{timestamp}:{uuid} → audit record JSON
 *   {project}:audit-index             → JSON array of audit keys
 *   {project}:presence:{user}         → presence record JSON
 *   {project}:presence-index          → JSON array of usernames
 *   {project}:config                  → config JSON
 */

// ── Threads ──────────────────────────────────────────────

async function getThreads(kv, project, filters = {}) {
  const indexKey = `${project}:thread-index`;
  const index = JSON.parse((await kv.get(indexKey)) || "[]");

  if (index.length === 0) return [];

  const threads = await Promise.all(
    index.map(async (id) => {
      const raw = await kv.get(`${project}:thread:${id}`);
      return raw ? JSON.parse(raw) : null;
    })
  );

  let result = threads.filter(Boolean);

  if (filters.status) {
    result = result.filter((t) => t.status === filters.status);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    result = result.filter(
      (t) =>
        (t.narrative || "").toLowerCase().includes(q) ||
        (t.handoff_summary || "").toLowerCase().includes(q) ||
        (t.last_note || "").toLowerCase().includes(q) ||
        (t.files_touched || []).some((f) => f.toLowerCase().includes(q))
    );
  }

  return result;
}

async function getThread(kv, project, id) {
  const raw = await kv.get(`${project}:thread:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function putThread(kv, project, thread) {
  const id = thread.id;
  await kv.put(`${project}:thread:${id}`, JSON.stringify(thread));

  // Update index
  const indexKey = `${project}:thread-index`;
  const index = JSON.parse((await kv.get(indexKey)) || "[]");
  if (!index.includes(id)) {
    index.push(id);
    await kv.put(indexKey, JSON.stringify(index));
  }
}

async function deleteThread(kv, project, id) {
  // Tombstone: keep minimal record
  const existing = await getThread(kv, project, id);
  if (existing) {
    const tombstone = {
      id: existing.id,
      user: existing.user,
      status: "expired",
      closed_at: existing.closed_at || new Date().toISOString(),
      created_at: existing.created_at,
    };
    await kv.put(`${project}:thread:${id}`, JSON.stringify(tombstone));
  }
}

// ── Audit ────────────────────────────────────────────────

async function appendAudit(kv, project, record) {
  const ts = record.timestamp || new Date().toISOString();
  const uid = crypto.randomUUID();
  const key = `${project}:audit:${ts}:${uid}`;
  await kv.put(key, JSON.stringify(record));

  const indexKey = `${project}:audit-index`;
  const index = JSON.parse((await kv.get(indexKey)) || "[]");
  index.push(key);

  // Cap at 10,000 entries; trim oldest on overflow
  if (index.length > 10000) {
    const removed = index.splice(0, index.length - 10000);
    await Promise.all(removed.map((k) => kv.delete(k)));
  }
  await kv.put(indexKey, JSON.stringify(index));
}

async function queryAudit(kv, project, filters = {}) {
  const indexKey = `${project}:audit-index`;
  const index = JSON.parse((await kv.get(indexKey)) || "[]");

  if (index.length === 0) return [];

  const records = await Promise.all(
    index.map(async (key) => {
      const raw = await kv.get(key);
      return raw ? JSON.parse(raw) : null;
    })
  );

  let result = records.filter(Boolean);

  if (filters.user) {
    result = result.filter((r) => r.user === filters.user);
  }
  if (filters.file) {
    result = result.filter((r) => (r.file || "").includes(filters.file));
  }
  if (filters.tool) {
    result = result.filter((r) => r.tool === filters.tool);
  }
  if (filters.since) {
    const since = new Date(filters.since).getTime();
    result = result.filter(
      (r) => new Date(r.timestamp || 0).getTime() >= since
    );
  }

  return result;
}

// ── Presence ─────────────────────────────────────────────

const PRESENCE_TTL_SECONDS = 15 * 60; // 15 minutes

async function getPresence(kv, project) {
  const indexKey = `${project}:presence-index`;
  const index = JSON.parse((await kv.get(indexKey)) || "[]");

  if (index.length === 0) return [];

  const records = await Promise.all(
    index.map(async (user) => {
      const raw = await kv.get(`${project}:presence:${user}`);
      return raw ? JSON.parse(raw) : null;
    })
  );

  return records.filter(Boolean);
}

async function upsertPresence(kv, project, record) {
  const user = record.user;
  await kv.put(`${project}:presence:${user}`, JSON.stringify(record), {
    expirationTtl: PRESENCE_TTL_SECONDS,
  });

  const indexKey = `${project}:presence-index`;
  const index = JSON.parse((await kv.get(indexKey)) || "[]");
  if (!index.includes(user)) {
    index.push(user);
    await kv.put(indexKey, JSON.stringify(index));
  }
}

async function deletePresence(kv, project, user) {
  await kv.delete(`${project}:presence:${user}`);

  const indexKey = `${project}:presence-index`;
  const index = JSON.parse((await kv.get(indexKey)) || "[]");
  const filtered = index.filter((u) => u !== user);
  await kv.put(indexKey, JSON.stringify(filtered));
}

// ── Config ───────────────────────────────────────────────

async function getConfig(kv, project) {
  const raw = await kv.get(`${project}:config`);
  return raw ? JSON.parse(raw) : null;
}

async function putConfig(kv, project, config) {
  await kv.put(`${project}:config`, JSON.stringify(config));
}

// ── Export ────────────────────────────────────────────────

export {
  getThreads,
  getThread,
  putThread,
  deleteThread,
  appendAudit,
  queryAudit,
  getPresence,
  upsertPresence,
  deletePresence,
  getConfig,
  putConfig,
};
