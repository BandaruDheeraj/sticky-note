# Plan: Arize AX Export for Team Session Visualization

## Goal

Export sticky-note thread data from the Cloudflare Worker to Arize AX so teams
can visualize session activity, stuck threads, and developer workflows using
Arize's Sessions view with custom attribute filtering.

## Why Arize Sessions

Arize's Sessions view groups traces by `session_id` and supports arbitrary
custom attributes — it doesn't require token counts or latency data. This makes
it a workable fit for sticky-note threads, which are developer sessions with
narrative summaries, file attribution, and status metadata rather than
LLM call traces.

Features that will work:
- Browse sessions by user, branch, status
- Filter to `status=stuck` and see failed approaches
- Read narrative summaries as span content
- Search by file, tool, or keyword across all sessions

Features that will be empty (require LLM-specific data):
- Token usage / cost analysis
- Latency histograms
- Eval scoring

## Data Mapping

Each sticky-note thread becomes one Arize trace with a single root span.

| Sticky-note field        | OTLP / Arize attribute              |
|--------------------------|-------------------------------------|
| `thread.id`              | `session_id` + trace ID             |
| `thread.user`            | `user.id`                           |
| `thread.tool`            | `llm.system`                        |
| `thread.branch`          | `sn.branch`                         |
| `thread.status`          | `sn.status`                         |
| `thread.work_type`       | `sn.work_type`                      |
| `thread.narrative`       | span `input.value`                  |
| `thread.handoff_summary` | span `output.value`                 |
| `thread.files_touched`   | `sn.files` (comma-separated)        |
| `thread.failed_approaches` | `sn.failed_approaches`            |
| `thread.last_note`       | `sn.last_note`                      |
| `thread.created_at`      | span start time                     |
| `thread.updated_at`      | span end time                       |

## Architecture

The Cloudflare Worker handles the export. No new service needed.

```
sticky-note threads (KV)
        │
        ▼
  Cloudflare Worker
  /export/arize  ──POST──▶  Arize OTLP collector
                            https://otlp.arize.com/v1/traces
```

Two trigger options (implement one, offer both):

**Option A — On-demand endpoint**
`POST /export/arize` reads all threads from KV, converts to OTLP, and
pushes to Arize in one call. Run manually or wire to a button in a
dashboard. Simple, no ongoing cost.

**Option B — Cron trigger**
Cloudflare Cron Trigger fires every N hours, exports threads updated
since the last run. Keeps Arize continuously up to date. Requires
storing a `last_exported_at` cursor in KV.

Recommendation: ship Option A first, add Option B if the team wants
continuous sync.

## OTLP Span Format

```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        { "key": "service.name", "value": { "stringValue": "sticky-note" } },
        { "key": "sn.project",   "value": { "stringValue": "BandaruDheeraj/MOBA" } }
      ]
    },
    "scopeSpans": [{
      "spans": [{
        "traceId": "<16-byte hex from thread.id>",
        "spanId":  "<8-byte hex from thread.id>",
        "name":    "<thread.work_type>: <thread.narrative (truncated 120 chars)>",
        "startTimeUnixNano": "<thread.created_at as nanoseconds>",
        "endTimeUnixNano":   "<thread.updated_at as nanoseconds>",
        "attributes": [
          { "key": "session_id",            "value": { "stringValue": "<thread.id>" } },
          { "key": "user.id",               "value": { "stringValue": "<thread.user>" } },
          { "key": "llm.system",            "value": { "stringValue": "<thread.tool>" } },
          { "key": "sn.status",             "value": { "stringValue": "<thread.status>" } },
          { "key": "sn.branch",             "value": { "stringValue": "<thread.branch>" } },
          { "key": "sn.work_type",          "value": { "stringValue": "<thread.work_type>" } },
          { "key": "sn.files",              "value": { "stringValue": "<files_touched joined>" } },
          { "key": "sn.failed_approaches",  "value": { "stringValue": "<failed_approaches joined>" } },
          { "key": "sn.last_note",          "value": { "stringValue": "<thread.last_note>" } },
          { "key": "input.value",           "value": { "stringValue": "<thread.narrative>" } },
          { "key": "output.value",          "value": { "stringValue": "<thread.handoff_summary>" } }
        ]
      }]
    }]
  }]
}
```

## Configuration

Two new Worker environment variables (set in `wrangler.toml` secrets):

| Variable           | Description                                      |
|--------------------|--------------------------------------------------|
| `ARIZE_API_KEY`    | Arize Space API key (from Arize dashboard)       |
| `ARIZE_SPACE_ID`   | Arize Space ID (used as OTLP header)             |

Arize OTLP endpoint: `https://otlp.arize.com/v1/traces`

Required headers:
```
Authorization: Bearer <ARIZE_API_KEY>
space_id: <ARIZE_SPACE_ID>
Content-Type: application/json
```

## Worker Changes

### `sticky-server/worker.js`

Add route:
```
POST /export/arize
```

Handler:
1. Check `ARIZE_API_KEY` and `ARIZE_SPACE_ID` are configured — 400 if not
2. Read all thread IDs from `${project}:threads_index` in KV
3. Fetch each thread from KV
4. Convert each to an OTLP span (mapping above)
5. Batch into groups of 100 (Arize collector limit)
6. POST each batch to `https://otlp.arize.com/v1/traces`
7. Return `{ exported: N, failed: M }` summary

### `sticky-server/wrangler.toml`

```toml
[vars]
# ARIZE_API_KEY and ARIZE_SPACE_ID set via `wrangler secret put`
```

## CLI Integration (optional follow-up)

After the Worker endpoint exists, `npx sticky-note export --to arize` could
call `POST /export/arize` on the configured `sticky_url` as a convenience
command. Not required for the initial implementation.

## Arize Sessions View Setup

Once data is flowing, in Arize:

1. **Sessions** tab → group by `session_id`
2. Add columns: `user.id`, `sn.status`, `sn.branch`, `sn.work_type`
3. Filter presets to save:
   - Stuck: `sn.status = stuck`
   - By user: `user.id = <name>`
   - Recent: sort by `startTime` desc
4. Click any session to see full narrative (`input.value`) and handoff summary (`output.value`)

## Out of Scope

- Audit log export (can be added later as a second span type)
- Presence / who's active (point-in-time, not historical — not a good fit for traces)
- Eval scoring on thread quality
- Continuous cron sync (Option B) — add if on-demand export proves useful
