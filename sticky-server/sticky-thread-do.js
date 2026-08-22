// sticky-server/sticky-thread-do.js
export class StickyThread {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buffer = [];
    this.flushThreshold = 10;
    this.threadId = null;
    this.project = "default";
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    if (url.pathname === "/do/open") {
      this.threadId = body.thread_id;
      this.project = body.project || "default";
      for (const ev of (body.events || [])) this.buffer.push(ev);
      await this._scheduleFlush();
      return new Response(JSON.stringify({ ok: true, thread_id: this.threadId }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/do/append") {
      const event = body.event;
      if (event) this.buffer.push(event);
      if (this.buffer.length >= this.flushThreshold) {
        await this._flush();
      } else {
        await this._scheduleFlush();
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/do/close") {
      const closeEvent = body.close_event;
      if (closeEvent) this.buffer.push(closeEvent);
      await this._flush();
      // Cancel pending alarm
      try { await this.state.storage.deleteAlarm(); } catch (_) {}
      return new Response(JSON.stringify({ ok: true, flushed: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/do/github-commit") {
      // Serialized GitHub REST write for this thread
      const result = await this._githubCommit(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
        status: result.ok ? 200 : 500,
      });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    // Alarm fires after 5s inactivity — flush buffered events
    if (this.buffer.length > 0) {
      await this._flush();
    }
  }

  async _scheduleFlush() {
    try {
      const existing = await this.state.storage.getAlarm();
      if (!existing) {
        await this.state.storage.setAlarm(Date.now() + 5000);
      }
    } catch (_) {}
  }

  async _flush() {
    if (this.buffer.length === 0 || !this.threadId) return;
    const toFlush = this.buffer.splice(0);
    try {
      const kv = this.env.STICKY_KV;
      const metaKey = `${this.project}:thread:${this.threadId}`;
      const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

      const meta = await kv.get(metaKey, { type: "json" }).catch(() => ({})) || {};
      let chunkCount = meta._event_chunks || 0;
      let currentChunkIdx = chunkCount === 0 ? 0 : chunkCount - 1;
      let currentChunk = chunkCount > 0
        ? (await kv.get(`${metaKey}:events:${currentChunkIdx}`, { type: "json" }).catch(() => []) || [])
        : [];

      for (const event of toFlush) {
        const eventBytes = new TextEncoder().encode(JSON.stringify(event)).length;
        const chunkBytes = new TextEncoder().encode(JSON.stringify(currentChunk)).length;
        if (chunkBytes + eventBytes > MAX_CHUNK_BYTES && currentChunk.length > 0) {
          await kv.put(`${metaKey}:events:${currentChunkIdx}`, JSON.stringify(currentChunk));
          currentChunkIdx++;
          currentChunk = [];
        }
        currentChunk.push(event);
      }
      await kv.put(`${metaKey}:events:${currentChunkIdx}`, JSON.stringify(currentChunk));
      meta._event_chunks = currentChunkIdx + 1;
      await kv.put(metaKey, JSON.stringify(meta));
    } catch (err) {
      // Put unwritten events back at front of buffer for retry
      this.buffer.unshift(...toFlush);
    }
  }

  async _githubCommit(body) {
    const { owner, repo, path: filePath, content, message, pat } = body;
    if (!pat) return { ok: false, error: "no PAT" };
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "sticky-note-worker",
    };

    let sha = null;
    let retries = 3;
    while (retries-- > 0) {
      // GET current SHA
      const getResp = await fetch(apiBase, { headers }).catch(() => null);
      if (getResp && getResp.ok) {
        const data = await getResp.json().catch(() => ({}));
        sha = data.sha || null;
      }

      // PUT with SHA
      const putBody = {
        message,
        content: btoa(unescape(encodeURIComponent(content))), // base64 encode UTF-8
        ...(sha ? { sha } : {}),
      };
      const putResp = await fetch(apiBase, {
        method: "PUT",
        headers,
        body: JSON.stringify(putBody),
      }).catch(() => null);

      if (!putResp) return { ok: false, error: "network error" };
      if (putResp.ok) return { ok: true };
      if (putResp.status === 409) {
        // SHA mismatch — retry after backoff
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      const errBody = await putResp.json().catch(() => ({}));
      return { ok: false, error: errBody.message || `HTTP ${putResp.status}` };
    }
    return { ok: false, error: "max retries exceeded (409 conflict)" };
  }
}
