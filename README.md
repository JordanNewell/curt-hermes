# curt-hermes

Two-direction bridge between the [Hermes](https://github.com/NousResearch/hermes)
agent store and the [`.curt`](https://github.com/JordanNewell/dot_curt)
single-file conversation format. Built on
[`curt-format`](https://www.npmjs.com/package/curt-format) (reference
implementation, v1 core). Part of the `curt-*` converter family (`curt-convert`
for Claude Code, `curt-openclaw` for OpenClaw, `curt-wildchat` for
WildChat-1M).

**Hub-and-spoke positioning:** `.curt` is the archival hub. Direction 1
exports Hermes sessions *out* into portable `.curt` archives. Direction 2
emits the de-facto Claude Code session JSONL that `hermes sessions import`
natively consumes — so `.curt` archives go back INTO Hermes (or any
Claude-Code-transcript importer) without upstream changes.

```sh
npm install -g curt-hermes   # or: npx curt-hermes

# Direction 1: Hermes state.db -> .curt files
curt-hermes ~/.hermes/state.db -o ./out
curt-hermes ~/.hermes/state.db --source cli|cron|discord|subagent
curt-hermes ~/.hermes/state.db --session <sessionId>
curt-hermes ~/.hermes/state.db --sample 5
curt-hermes ~/.hermes/state.db --stdout > one.curt

# Direction 2: .curt -> Claude Code session JSONL (for hermes sessions import)
curt-hermes --emit-cc-jsonl ./out           # a directory of .curt files
curt-hermes --emit-cc-jsonl one.curt -o ./jsonl
```

Direction 1 opens the SQLite store **read-only** (`mode=ro`; WAL sidecars are
read, never written). Every `.curt` output is re-parsed with `parseCurt`
before it is written; a file that fails round-trip validation is never
written. Output names follow the Curtis bulk convention
(`YYYY-MM-DD <slug> <suffix>.curt` via `curtFilename()`); a filename
collision gets a `-2`/`-3` suffix instead of silently overwriting. Direction 2
validates each emitted JSONL for line-parseability and `uuid`/`parentUuid`
chain integrity before writing. A summary line with converted/skipped/
round-trip-failure counts goes to stderr; per-session problems are counted,
never fatal.

**Database driver:** `node:sqlite` (`DatabaseSync`) — built into Node ≥ 22.5,
zero native dependencies. A deliberate choice over `better-sqlite3`: no
compile step, and the read-only URI mode matches the access posture.

## Provenance

Input schema verified read-only against a live Hermes store
(a live gateway store at `~/.hermes/state.db`, **schema_version 30**, 8,602 sessions /
157,870 messages) on **2026-11-01**. Real-corpus validation used a remote
subset (all sessions with `source IN ('cli','discord')` and their messages +
`session_model_usage` rows — 87 sessions, 1,810 messages) extracted with
read-only SQLite ATTACH on the host, copied out, converted, and deleted from
the host afterward. Real content stays out of this repo (gitignored `work/`
by convention); `demos/` are fully synthetic.

Schema findings that shaped the converter:

- `sessions.started_at` / `ended_at` are REAL epoch **seconds** — normalized
  to epoch milliseconds (`× 1000`) everywhere.
- `messages.content` carries **no prefix sentinel** in schema_version 30: it
  is either a plain string or a direct JSON document (tool payloads like
  `{output, exit_code}`; assistant structured replies). JSON documents are
  re-serialized canonically as the message text and counted. (The code-level
  `_CONTENT_JSON_PREFIX` guard from the Hermes writer is honored
  defensively: a sentinel-prefixed payload would fail `JSON.parse` and be
  emitted verbatim, never dropped.)
- `messages.tool_calls` (assistant rows) is a JSON array of OpenAI-style
  calls **plus Hermes plumbing**:
  `{id, call_id, response_item_id, type, function:{name, arguments},
  extra_content?}`. Verified: `messages.tool_call_id` links on
  `tool_calls[].id` (never `call_id`). Emitted .curt form is
  `[{id, name, arguments}]` with `arguments` parsed to a value; plumbing
  fields are counted as redacted.
- Untrusted tool output is wrapped in
  `<untrusted_tool_result source="...">` … `</untrusted_tool_result>` —
  format metadata; the wrapper pair is stripped and counted, the inner body
  is the content.
- `role` distribution: `user` / `assistant` / `tool` / `session_meta`
  (presence markers, NULL content — skipped+counted). No `system` rows exist
  in the verified store; they would be skipped+counted if they appeared.
- `reasoning` / `reasoning_content` (assistant) are plain text — joined to
  the message `thinking` passthrough.
- The documented `created_source` column does not exist in schema_version 30
  (plan-vs-reality drift); the converter relies only on verified columns.

## Mapping

| Hermes (`state.db`) | .curt | Notes |
|---|---|---|
| `sessions.id` | `conversation.id` | |
| `sessions.title` (when present; `title_source` `user`/`llm` are both titles, not raw content) | `conversation.title` | Falls back to first user text, single line, 60-char cap. Sessions without a title: derived (verified store: 63 of 87 subset sessions). |
| `sessions.started_at` / `ended_at` (epoch s → ms) | `conversation.createdAt` / `updatedAt` | Falls back to min/max message timestamps. |
| `sessions.model` | `conversation.model` | Messages carry no per-row model column in this schema. |
| message `role:user` | message `role:"user"` | Content verbatim (or JSON re-serialized). |
| message `role:assistant` | message `role:"assistant"` | Content plain or JSON-as-text. |
| assistant `reasoning` + `reasoning_content` | message `thinking` (extra) | Joined `\n\n`. |
| assistant `tool_calls` | message `toolCalls` (extra) | `[{id, name, arguments}]` — draft `tool-linkage` passthrough convention; plumbing (`call_id`, `response_item_id`, `type`, `extra_content`) dropped+counted. |
| assistant `token_count` | message `tokens.totalTokens` (extra) | Single per-message number; maps to the stable `usage-metadata` `tokens` shape. |
| assistant `finish_reason` | message `stopReason` (extra) | |
| message `role:tool` | message `role:"tool"` | Extras: `toolCallId` (links `tool_calls[].id`), `toolName`. `<untrusted_tool_result>` wrapper stripped+counted. |
| `role:session_meta` (and any unknown role) | — | Skipped and counted (`skippedRoles`). |
| `sessions.source`, `chat_type`, `end_reason` | `conversation.hermes` (extra) | Generic surface metadata only. |
| `sessions.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` | `conversation.hermesTokens` (extra) | Numbers only. |
| `sessions.estimated_cost_usd` | `conversation.hermesCostUsd` (extra) | |
| `session_model_usage` rows | `conversation.hermesModelUsage` (extra) | Only emitted when the session used >1 model (5 of 87 in the verified subset); `[{model, apiCallCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, estimatedCostUsd}]`. |
| row order (`messages.id`) | `messages` array order | |
| — | message `id` | Synthesized `"<sessionId>-<n>"` over emitted messages. |

### Direction 2 mapping (.curt → Claude Code JSONL)

| .curt | Claude Code JSONL | Notes |
|---|---|---|
| conversation | one `.jsonl` file | Curtis bulk-convention name, `.jsonl` extension. |
| `conversation.id` | `sessionId` on every line | |
| message | one line | `type:"user"` / `type:"assistant"`; `uuid`/`parentUuid` chain (deterministic UUIDs — re-runs are byte-identical), ISO `timestamp`, `isSidechain:false`, `userType:"external"`. `cwd`/`gitBranch` emitted empty, `version` = generator. |
| message `content` (user) | `message.content` string | |
| message `thinking` | `message.content[].{type:"thinking", thinking}` block | |
| message `content` (assistant) | `message.content[].{type:"text", text}` block | |
| message `toolCalls` | `message.content[].{type:"tool_use", id, name, input}` blocks | `arguments` → `input`. |
| message `role:"tool"` | `type:"user"` line with `message.content[].{type:"tool_result", tool_use_id, content}` | `isError` → `is_error`. |
| message `model`, `stopReason`, `tokens` | `message.model`, `message.stop_reason`, `message.usage.output_tokens` | |
| `role:"system"` | `type:"system"` line with `content` | None exist in the verified store; handled defensively. |

Each emitted file is validated before writing: every line parses, the
`uuid`/`parentUuid` chain is intact, duplicates rejected. Orphan
`tool_result`s (aborted calls in the archive) are carried through and
counted, not fatal. Emitting the de-facto interchange means `hermes sessions
import` consumes `.curt` archives without any upstream Hermes changes.

### Extensions

The top-level `extensions` array declares `["usage-metadata"]` (stable in
`EXTENSIONS.md`) because `tokens` is emitted. The **`tool-linkage` extension
is draft**, so its field names (`toolCalls` on assistant messages,
`toolCallId` on tool messages) ride as plain passthrough extras without
declaring the extension — the same convention curt-openclaw uses. If/when
`tool-linkage` reaches stable, declaring it is a one-line change.

## Known losses

Deliberate — identifiers, paths, prompts, and plumbing that must not leak
into a portable file. Counted in `redactedFields` (aggregate only; never
logged verbatim):

- Never read as values at all (NULL-ness only, for the drop ledger):
  `system_prompt`, `origin_json`, `display_name`, `user_id`, `session_key`,
  `chat_id`, `thread_id`, `billing_provider`, `billing_base_url`,
  `tool_names`. Also never touched: `cwd`, `git_branch`, `git_repo_root`,
  `model_config`, `profile_name`, `parent_session_id`, `handoff_*`,
  `transport_profile`, `last_activity_*`, `compression_*`.
- `tool_calls` plumbing: `call_id`, `response_item_id`, `type`,
  `extra_content`.
- `<untrusted_tool_result source="...">` wrapper tag + source attribute
  (the body is kept).
- Structural, not redaction:
  - `session_meta` rows (presence markers with NULL content) are skipped and
    counted.
  - Empty-content user/assistant rows (nothing to say) are dropped and
    counted (`emptyDropped`) — 1 in the verified subset.
  - A `toolCall` with no matching `tool` row (aborted call) still emits its
    `toolCalls` entry; counted as `unmatchedToolCalls`. A `tool` row whose
    `tool_call_id` was never seen is counted as `unmatchedToolResults` but
    still emitted.
  - JSON contents are re-serialized (key order canonicalized); text is never
    altered.
  - Per-message model attribution does not exist in this schema — only the
    session-level `model` (and multi-model rollups via
    `hermesModelUsage`).
  - Malformed rows (unparseable `tool_calls` JSON, non-string content) are
    counted, never fatal — 0 in the verified subset.

## Privacy posture

Direction 1 writes content-faithful files: conversation text, tool calls and
outputs, and thinking blocks all land in `.curt` output — treat output as
record-equivalent to the source store. The converter's own metadata layer
never emits identifiers, keys, session/chat/thread ids, system prompts, or
billing endpoints; credential columns are not even SELECTed as values
(NULL-ness only). Direction 2 re-emits that same content into JSONL; nothing
is added except synthetic chain UUIDs and neutral `cwd`/`gitBranch`/`version`
fields. The verified-corpus run was spot-scanned: no banned identifier values
appear in any output's metadata layer.

## Development

```sh
npm i
npm test       # vitest, 36 tests over a synthetic node:sqlite fixture DB
npm run build  # tsc -> dist/
```

The fixture DB is built by `test/fixtures.ts` (schema mirrors the real
store; all content synthetic). Regenerate the staged demos with:

```sh
node --experimental-strip-types test/make-demo.ts
node dist/cli.js demos/synthetic-fixture/state.db -o demos/synthetic-flow
node dist/cli.js --emit-cc-jsonl demos/synthetic-flow -o demos/synthetic-cc-jsonl
rm -rf demos/synthetic-fixture   # regenerable; also keeps *.db out of the tree
```

Real-corpus runs write into an untracked, gitignored `work/` directory by
convention.

## Part of the .curt suite

- [`curt-format`](https://github.com/JordanNewell/dot_curt) — the .curt format spec + reference implementation ([npm](https://www.npmjs.com/package/curt-format))
- [`curt-convert`](https://github.com/JordanNewell/curt-convert) — Claude Code transcripts → .curt ([npm](https://www.npmjs.com/package/curt-convert))
- [`curt-openclaw`](https://github.com/JordanNewell/curt-openclaw) — OpenClaw session transcripts → .curt ([npm](https://www.npmjs.com/package/curt-openclaw))
- [`curt-wildchat`](https://github.com/JordanNewell/curt-wildchat) — WildChat-1M records → .curt ([npm](https://www.npmjs.com/package/curt-wildchat))
- [`curt-vcon`](https://github.com/JordanNewell/curt-vcon) — .curt ⇄ vCon (IETF) bridge ([npm](https://www.npmjs.com/package/curt-vcon))
- [`curt-openwith`](https://github.com/JordanNewell/curt-openwith) — double-click any .curt file: offline viewer, Windows + macOS + Linux

MIT — see [LICENSE](LICENSE). See also
[ACCESS-AND-LICENSE.md](ACCESS-AND-LICENSE.md) for the input-data access and
content-licensing posture.
