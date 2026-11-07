/**
 * Convert a Hermes agent SQLite store (`state.db`) into .curt conversations,
 * and .curt conversations into Claude Code session JSONL (the interchange
 * Hermes `sessions import` natively consumes).
 *
 * Input schema verified read-only against a live Hermes store (schema_version
 * 30) on 2026-11-01: `sessions` / `messages` / `session_model_usage`.
 * See README.md for the full mapping and provenance.
 *
 * Privacy: this module never SELECTs credential/config columns
 * (`system_prompt`, `origin_json`, `display_name`, `user_id`, `session_key`,
 * `chat_id`, `thread_id`, `billing_*`, `cwd`, git fields) as values — only
 * NULL-ness booleans, for drop accounting. Conversation content flows through
 * by design (the .curt output is record-equivalent), but the metadata layer
 * emits nothing identifying.
 */

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
	type CurtConversation,
	type CurtMessage,
	parseCurt,
	serializeCurt,
} from "curt-format";

export const GENERATOR = "curt-hermes@1.0.0";

/** Stable registry extensions this converter emits (see dot_curt EXTENSIONS.md). */
export const EXTENSIONS = ["usage-metadata"] as const;

/** Hermes content sentinel check: contents in schema_version 30 are either a
 * plain string or a direct JSON document (no prefix sentinel was observed in
 * the verified store; the code-level `_CONTENT_JSON_PREFIX` guard is honored
 * defensively here — any `<sentinel>{...}` shape would fail JSON.parse and be
 * emitted verbatim as text, never dropped). */

/** Hermes wraps untrusted tool output in this tag pair; it is format
 * metadata, stripped before the body is emitted (counted). */
export const UNTRUSTED_TAG = "<untrusted_tool_result";

export interface ConvertStats {
	/** Messages emitted into the conversation, by role. */
	roles: { user: number; assistant: number; tool: number };
	/** session_meta / system / unknown-role rows: skipped and counted. */
	skippedRoles: number;
	/** Rows whose content or tool_calls JSON could not be used as expected. */
	malformedRows: number;
	/** Contents that were JSON documents, re-serialized as text. */
	jsonContents: number;
	/** `<untrusted_tool_result>` wrapper pairs stripped from tool output. */
	untrustedWrappers: number;
	/** tool_calls plumbing fields dropped (call_id, response_item_id, type,
	 *  extra_content) plus per-session identifier columns never emitted. */
	redactedFields: number;
	/** toolCall entries never answered by a tool row in the same session. */
	unmatchedToolCalls: number;
	/** tool rows whose tool_call_id has no preceding emitted toolCall. */
	unmatchedToolResults: number;
	/** User/assistant rows dropped for empty content. */
	emptyDropped: number;
}

export interface ConvertResult {
	conversation: CurtConversation;
	stats: ConvertStats;
}

export interface ConvertOptions {
	/** Derived title cap, matching the Curtis convention (60 chars). */
	titleMax?: number;
}

// ---- Hermes input types (structural; everything optional) ----

export interface HermesSessionRow {
	id: unknown;
	source: unknown;
	model: unknown;
	title: unknown;
	title_source: unknown;
	started_at: unknown;
	ended_at: unknown;
	end_reason: unknown;
	chat_type: unknown;
	message_count: unknown;
	tool_call_count: unknown;
	input_tokens: unknown;
	output_tokens: unknown;
	cache_read_tokens: unknown;
	cache_write_tokens: unknown;
	reasoning_tokens: unknown;
	estimated_cost_usd: unknown;
	// NULL-ness booleans only — values are never selected.
	has_system_prompt: unknown;
	has_origin_json: unknown;
	has_display_name: unknown;
	has_user_id: unknown;
	has_session_key: unknown;
	has_chat_id: unknown;
	has_thread_id: unknown;
	has_billing_provider: unknown;
	has_billing_base_url: unknown;
	has_tool_names: unknown;
}

export interface HermesMessageRow {
	id: unknown;
	session_id: unknown;
	role: unknown;
	content: unknown;
	tool_calls: unknown;
	tool_call_id: unknown;
	tool_name: unknown;
	timestamp: unknown;
	token_count: unknown;
	finish_reason: unknown;
	reasoning: unknown;
	reasoning_content: unknown;
}

export interface HermesModelUsageRow {
	session_id: unknown;
	model: unknown;
	api_call_count: unknown;
	input_tokens: unknown;
	output_tokens: unknown;
	cache_read_tokens: unknown;
	cache_write_tokens: unknown;
	reasoning_tokens: unknown;
	estimated_cost_usd: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
	return typeof v === "string";
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * Hermes timestamps are REAL epoch SECONDS; normalize to epoch milliseconds.
 * Values already in ms (>= 1e12) pass through; garbage becomes 0.
 */
export function toEpochMs(v: unknown): number {
	if (!isNum(v)) return 0;
	return v >= 1e12 ? Math.round(v) : Math.round(v * 1000);
}

/** First user text -> display title (single line, capped). */
export function deriveTitle(text: string, max = 60): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Normalize a content cell. Plain strings pass through verbatim. Strings that
 * parse as a JSON object/array (Hermes stores structured payloads as direct
 * JSON, no prefix sentinel in schema_version 30) are re-serialized canonically
 * and counted. NULL becomes empty text.
 */
export function normalizeContent(
	raw: unknown,
	stats: ConvertStats,
): string {
	if (raw === null || raw === undefined) return "";
	if (!isStr(raw)) {
		stats.malformedRows++;
		return "";
	}
	if (raw.length === 0) return "";
	const c = raw[0]!;
	if (c === "{" || c === "[") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (isObj(parsed) || Array.isArray(parsed)) {
				stats.jsonContents++;
				return JSON.stringify(parsed);
			}
		} catch {
			// Not JSON after all (or a sentinel-prefixed payload) — emit verbatim.
		}
	}
	return raw;
}

/**
 * Strip the `<untrusted_tool_result source="...">` / `</untrusted_tool_result>`
 * wrapper Hermes puts around untrusted tool output. The tag (with its tool
 * source attribute) is format metadata; the inner body is the content.
 */
export function stripUntrustedWrapper(
	text: string,
	stats: ConvertStats,
): string {
	if (!text.startsWith(UNTRUSTED_TAG)) return text;
	const nl = text.indexOf("\n");
	if (nl === -1) return text;
	const body = text.slice(nl + 1);
	const trimmed = body.replace(/\n<\/untrusted_tool_result>\s*$/, "");
	stats.untrustedWrappers++;
	return trimmed;
}

/**
 * Parse the assistant `tool_calls` JSON cell: an array of OpenAI-style calls
 * plus Hermes plumbing — `{id, call_id, response_item_id, type,
 * function:{name, arguments}, extra_content?}`. Emitted .curt form is
 * `[{id, name, arguments}]` (the draft tool-linkage passthrough convention);
 * plumbing fields are counted as redacted. `arguments` is a JSON string —
 * parsed when possible so .curt carries the value.
 */
export function parseToolCalls(
	raw: unknown,
	stats: ConvertStats,
): Record<string, unknown>[] {
	if (raw === null || raw === undefined) return [];
	if (!isStr(raw) || raw.length === 0) {
		stats.malformedRows++;
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		stats.malformedRows++;
		return [];
	}
	if (!Array.isArray(parsed)) {
		stats.malformedRows++;
		return [];
	}
	const out: Record<string, unknown>[] = [];
	for (const call of parsed) {
		if (!isObj(call)) {
			stats.malformedRows++;
			continue;
		}
		for (const k of ["call_id", "response_item_id", "type", "extra_content"]) {
			if (call[k] !== undefined) stats.redactedFields++;
		}
		const fn = isObj(call.function) ? call.function : {};
		const entry: Record<string, unknown> = {};
		if (isStr(call.id)) entry.id = call.id;
		else if (isStr(call.call_id)) entry.id = call.call_id;
		if (isStr(fn.name)) entry.name = fn.name;
		if (fn.arguments !== undefined) {
			const a = fn.arguments;
			if (isStr(a)) {
				try {
					entry.arguments = JSON.parse(a);
				} catch {
					entry.arguments = a;
				}
			} else {
				entry.arguments = a;
			}
		}
		out.push(entry);
	}
	return out;
}

function emptyStats(): ConvertStats {
	return {
		roles: { user: 0, assistant: 0, tool: 0 },
		skippedRoles: 0,
		malformedRows: 0,
		jsonContents: 0,
		untrustedWrappers: 0,
		redactedFields: 0,
		unmatchedToolCalls: 0,
		unmatchedToolResults: 0,
		emptyDropped: 0,
	};
}

/** Identifier columns never emitted; NULL-ness is counted for the drop ledger. */
const SESSION_REDACTED_BOOLEANS = [
	"has_system_prompt",
	"has_origin_json",
	"has_display_name",
	"has_user_id",
	"has_session_key",
	"has_chat_id",
	"has_thread_id",
	"has_billing_provider",
	"has_billing_base_url",
	"has_tool_names",
] as const;

function countSessionRedactions(row: HermesSessionRow, stats: ConvertStats): void {
	for (const k of SESSION_REDACTED_BOOLEANS) {
		if (row[k] === 1) stats.redactedFields++;
	}
}

/**
 * Convert one Hermes session (its row, ordered message rows, model-usage rows)
 * into a .curt conversation. Returns null when nothing usable exists (never
 * half-converts).
 */
export function convertSession(
	session: HermesSessionRow,
	messages: HermesMessageRow[],
	modelUsage: HermesModelUsageRow[],
	options: ConvertOptions = {},
): ConvertResult | null {
	const stats = emptyStats();
	countSessionRedactions(session, stats);

	const messagesOut: CurtMessage[] = [];
	const toolCallIds = new Set<string>();

	for (const m of messages) {
		const role = m.role;
		const ts = toEpochMs(m.timestamp);

		if (role === "user" || role === "assistant" || role === "tool") {
			const content = normalizeContent(m.content, stats);
			if (role === "user") {
				if (!content) {
					stats.emptyDropped++;
					continue;
				}
				messagesOut.push({ id: "", role: "user", content, timestamp: ts });
				stats.roles.user++;
				continue;
			}
			if (role === "assistant") {
				const message: CurtMessage = {
					id: "",
					role: "assistant",
					content,
					timestamp: ts,
				};
				const thinking = [m.reasoning, m.reasoning_content]
					.filter((t) => isStr(t) && t.length > 0)
					.join("\n\n");
				if (thinking) message.thinking = thinking;
				const toolCalls = parseToolCalls(m.tool_calls, stats);
				for (const call of toolCalls) {
					if (isStr(call.id)) toolCallIds.add(call.id);
				}
				if (toolCalls.length > 0) message.toolCalls = toolCalls;
				// usage-metadata (stable extension): per-message token count + finish reason.
				if (isNum(m.token_count)) message.tokens = { totalTokens: m.token_count };
				if (isStr(m.finish_reason)) message.stopReason = m.finish_reason;
				if (!content && !thinking && toolCalls.length === 0) {
					stats.emptyDropped++;
					continue;
				}
				messagesOut.push(message);
				stats.roles.assistant++;
				continue;
			}
			// tool result row
			const body = stripUntrustedWrapper(content, stats);
			const message: CurtMessage = {
				id: "",
				role: "tool",
				content: body,
				timestamp: ts,
			};
			if (isStr(m.tool_call_id)) message.toolCallId = m.tool_call_id;
			if (isStr(m.tool_name)) message.toolName = m.tool_name;
			if (isStr(message.toolCallId) && !toolCallIds.has(message.toolCallId)) {
				stats.unmatchedToolResults++;
			}
			messagesOut.push(message);
			stats.roles.tool++;
			continue;
		}

		// session_meta (presence markers, no content) and any future role:
		// skipped and counted, never fatal.
		stats.skippedRoles++;
	}

	for (const call of messagesOut.flatMap((m) =>
		Array.isArray(m.toolCalls) ? m.toolCalls : [],
	)) {
		const id = (call as Record<string, unknown>).id;
		if (isStr(id) && !messagesOut.some((m) => m.toolCallId === id)) {
			stats.unmatchedToolCalls++;
		}
	}

	if (messagesOut.length === 0) return null;

	// Assign message ids: "<sessionId>-<n>" over emitted messages.
	const convId = isStr(session.id) ? session.id : "hermes-session";
	let n = 0;
	for (const m of messagesOut) m.id = `${convId}-${++n}`;

	const times = messagesOut.map((m) => m.timestamp).filter((t) => t > 0);
	const startedAt = toEpochMs(session.started_at);
	const endedAt = toEpochMs(session.ended_at);
	const createdAt = startedAt || (times.length ? Math.min(...times) : 0);
	const updatedAt =
		endedAt || (times.length ? Math.max(...times) : createdAt) || createdAt;

	// Title: sessions.title when present (title_source 'user' or 'llm' — both
	// are titles, not raw content); else derived from the first user message.
	let title = isStr(session.title) && session.title.trim() ? session.title : "";
	if (!title) {
		for (const m of messagesOut) {
			if (m.role === "user") {
				title = deriveTitle(m.content, options.titleMax ?? 60);
				break;
			}
		}
	}

	const conversation: CurtConversation = {
		id: convId,
		title,
		createdAt,
		updatedAt,
		messages: messagesOut,
	};

	if (isStr(session.model) && session.model) conversation.model = session.model;

	// Conversation extras: generic surface metadata only.
	const source = isStr(session.source) ? session.source : undefined;
	const chatType = isStr(session.chat_type) ? session.chat_type : undefined;
	const endReason = isStr(session.end_reason) ? session.end_reason : undefined;
	if (source || chatType || endReason) {
		const meta: Record<string, unknown> = {};
		if (source) meta.source = source;
		if (chatType) meta.chatType = chatType;
		if (endReason) meta.endReason = endReason;
		conversation.hermes = meta;
	}

	// Session token rollups + cost (numbers only).
	const tokensOut: Record<string, unknown> = {};
	for (const [k, col] of [
		["inputTokens", "input_tokens"],
		["outputTokens", "output_tokens"],
		["cacheReadTokens", "cache_read_tokens"],
		["cacheWriteTokens", "cache_write_tokens"],
		["reasoningTokens", "reasoning_tokens"],
	] as const) {
		if (isNum(session[col])) tokensOut[k] = session[col];
	}
	if (Object.keys(tokensOut).length > 0) conversation.hermesTokens = tokensOut;
	if (isNum(session.estimated_cost_usd)) {
		conversation.hermesCostUsd = session.estimated_cost_usd;
	}

	// Per-model rollups — only meaningful (and only emitted) when a session
	// used more than one model.
	const models = new Set(
		modelUsage.map((r) => (isStr(r.model) ? r.model : "")).filter(Boolean),
	);
	if (models.size > 1) {
		conversation.hermesModelUsage = modelUsage.map((r) => {
			const entry: Record<string, unknown> = {};
			if (isStr(r.model)) entry.model = r.model;
			if (isNum(r.api_call_count)) entry.apiCallCount = r.api_call_count;
			if (isNum(r.input_tokens)) entry.inputTokens = r.input_tokens;
			if (isNum(r.output_tokens)) entry.outputTokens = r.output_tokens;
			if (isNum(r.cache_read_tokens)) entry.cacheReadTokens = r.cache_read_tokens;
			if (isNum(r.cache_write_tokens)) entry.cacheWriteTokens = r.cache_write_tokens;
			if (isNum(r.reasoning_tokens)) entry.reasoningTokens = r.reasoning_tokens;
			if (isNum(r.estimated_cost_usd)) entry.estimatedCostUsd = r.estimated_cost_usd;
			return entry;
		});
	}

	return { conversation, stats };
}

/** Serialize with round-trip validation. Returns null if the output fails `parseCurt`. */
export function serializeValidated(conversation: CurtConversation): string | null {
	const body = serializeCurt(conversation, GENERATOR, [...EXTENSIONS]);
	return parseCurt(body) ? body : null;
}

/**
 * Resolve a .curt output path against on-disk content. Identical content
 * overwrites in place (idempotent re-runs stay quiet); differing content is
 * a collision and gets a -N suffix instead of silently losing writes.
 */
export function resolveCurtWritePath(
	filePath: string,
	body: string,
): { path: string; collided: boolean } {
	if (!existsSync(filePath)) return { path: filePath, collided: false };
	if (readFileSync(filePath, "utf8") === body) return { path: filePath, collided: false };
	const stem = filePath.slice(0, -".curt".length);
	let n = 2;
	let target = `${stem}-2.curt`;
	while (existsSync(target)) {
		// An existing -N variant with identical content is the same export, not a
		// collision — otherwise re-runs after a base-file mismatch would keep
		// spawning fresh duplicates forever.
		if (readFileSync(target, "utf8") === body) return { path: target, collided: false };
		target = `${stem}-${++n}.curt`;
	}
	return { path: target, collided: true };
}

// ---- Database access ----

/**
 * Session-level SELECT. Note what is absent: credential and identifier
 * columns are selected only as NULL-ness booleans; their values never enter
 * this process.
 */
const SESSION_SELECT = `
	SELECT id, source, model, title, title_source, started_at, ended_at,
	       end_reason, chat_type, message_count, tool_call_count,
	       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
	       reasoning_tokens, estimated_cost_usd,
	       system_prompt IS NOT NULL AS has_system_prompt,
	       origin_json IS NOT NULL AS has_origin_json,
	       display_name IS NOT NULL AS has_display_name,
	       user_id IS NOT NULL AS has_user_id,
	       session_key IS NOT NULL AS has_session_key,
	       chat_id IS NOT NULL AS has_chat_id,
	       thread_id IS NOT NULL AS has_thread_id,
	       billing_provider IS NOT NULL AS has_billing_provider,
	       billing_base_url IS NOT NULL AS has_billing_base_url,
	       tool_names IS NOT NULL AS has_tool_names
	FROM sessions`;

const MESSAGE_SELECT = `
	SELECT id, session_id, role, content, tool_calls, tool_call_id, tool_name,
	       timestamp, token_count, finish_reason, reasoning, reasoning_content
	FROM messages WHERE session_id = ? ORDER BY id`;

const MODEL_USAGE_SELECT = `
	SELECT session_id, model, api_call_count, input_tokens, output_tokens,
	       cache_read_tokens, cache_write_tokens, reasoning_tokens,
	       estimated_cost_usd
	FROM session_model_usage WHERE session_id = ? ORDER BY model`;

export interface SessionItem {
	sessionId: string;
	source: string | null;
	result: ConvertResult;
}

export interface DbConvertResult {
	items: SessionItem[];
	converted: number;
	skipped: number;
	totals: ConvertStats;
}

/**
 * Open a Hermes state.db read-only and convert sessions.
 *
 * Options:
 * - `source` — filter by sessions.source (cli | cron | discord | subagent).
 * - `session` — convert only the session with this id.
 * - `sample` — convert only the first n matching sessions.
 *
 * Malformed rows are counted, never fatal. The database is opened
 * `mode=ro`; WAL/SHM sidecars are read, never written.
 */
export function convertDb(
	dbPath: string,
	options: { source?: string; session?: string; sample?: number } & ConvertOptions = {},
): DbConvertResult {
	const db = new DatabaseSync(`${dbPath.replace(/\\/g, "/")}`, {
		readOnly: true,
	});

	const where: string[] = [];
	const params: (string | number)[] = [];
	if (options.source) {
		where.push("source = ?");
		params.push(options.source);
	}
	if (options.session) {
		where.push("id = ?");
		params.push(options.session);
	}
	const sql =
		SESSION_SELECT + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY id";
	const sessions = db.prepare(sql).all(...params) as unknown as HermesSessionRow[];

	const items: SessionItem[] = [];
	const totals = emptyStats();
	let converted = 0;
	let skipped = 0;

	for (const session of sessions) {
		if (options.sample && converted >= options.sample) break;
		if (!isStr(session.id)) {
			skipped++;
			continue;
		}
		const messages = db
			.prepare(MESSAGE_SELECT)
			.all(session.id) as unknown as HermesMessageRow[];
		const modelUsage = db
			.prepare(MODEL_USAGE_SELECT)
			.all(session.id) as unknown as HermesModelUsageRow[];
		const result = convertSession(session, messages, modelUsage, options);
		if (!result) {
			skipped++;
			continue;
		}
		items.push({
			sessionId: session.id,
			source: isStr(session.source) ? session.source : null,
			result,
		});
		const t = result.stats;
		const a = totals;
		a.roles.user += t.roles.user;
		a.roles.assistant += t.roles.assistant;
		a.roles.tool += t.roles.tool;
		a.skippedRoles += t.skippedRoles;
		a.malformedRows += t.malformedRows;
		a.jsonContents += t.jsonContents;
		a.untrustedWrappers += t.untrustedWrappers;
		a.redactedFields += t.redactedFields;
		a.unmatchedToolCalls += t.unmatchedToolCalls;
		a.unmatchedToolResults += t.unmatchedToolResults;
		a.emptyDropped += t.emptyDropped;
		converted++;
	}

	db.close();
	return { items, converted, skipped, totals };
}

// ---- Direction 2: .curt -> Claude Code session JSONL ----

/**
 * Deterministic UUID (v4-shaped) derived from a string, so re-runs produce
 * byte-identical JSONL. Hermes regenerates ids on import; what matters is
 * that uuid/parentUuid chain within the file.
 */
export function deterministicUuid(seed: string): string {
	const hex = createHash("md5").update(seed).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isoTs(ms: number): string {
	return new Date(ms > 0 ? ms : 0).toISOString();
}

/**
 * Convert one .curt conversation into Claude Code session JSONL — the
 * de-facto interchange Hermes `sessions import` consumes natively.
 *
 * Line shape mirrors real Claude Code transcripts: `user` / `assistant` /
 * `system` typed lines with `uuid`/`parentUuid` chain, ISO `timestamp`,
 * `sessionId`, and `message{role, content}` where content is a string (user
 * text), a block array (assistant: thinking/text/tool_use; user tool_result).
 */
export function emitClaudeCodeJsonl(conversation: CurtConversation): string {
	const lines: Record<string, unknown>[] = [];
	let parentUuid: string | null = null;
	let promptId = deterministicUuid(`${conversation.id}:prompt`);

	for (const m of conversation.messages) {
		const uuid = deterministicUuid(`${conversation.id}:${m.id}`);
		const base: Record<string, unknown> = {
			parentUuid,
			isSidechain: false,
			sessionId: conversation.id,
			uuid,
			timestamp: isoTs(m.timestamp),
		};

		if (m.role === "user") {
			lines.push({
				...base,
				type: "user",
				userType: "external",
				cwd: "",
				version: GENERATOR,
				gitBranch: "",
				message: { role: "user", content: m.content },
			});
		} else if (m.role === "assistant") {
			const blocks: Record<string, unknown>[] = [];
			if (isStr(m.thinking) && m.thinking) {
				blocks.push({ type: "thinking", thinking: m.thinking });
			}
			if (isStr(m.content) && m.content) {
				blocks.push({ type: "text", text: m.content });
			}
			for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
				const c = call as Record<string, unknown>;
				blocks.push({
					type: "tool_use",
					id: isStr(c.id) ? c.id : deterministicUuid(`${conversation.id}:${m.id}:call`),
					name: isStr(c.name) ? c.name : "unknown",
					input: c.arguments ?? {},
				});
			}
			const message: Record<string, unknown> = {
				role: "assistant",
				content: blocks,
			};
			if (isStr(m.model)) message.model = m.model;
			if (isStr(m.stopReason)) message.stop_reason = m.stopReason;
			if (isObj(m.tokens)) {
				const usage: Record<string, unknown> = {};
				if (isNum(m.tokens.totalTokens)) usage.output_tokens = m.tokens.totalTokens;
				if (Object.keys(usage).length > 0) message.usage = usage;
			}
			lines.push({
				...base,
				type: "assistant",
				cwd: "",
				version: GENERATOR,
				gitBranch: "",
				message,
			});
		} else if (m.role === "tool") {
			const result: Record<string, unknown> = {
				type: "tool_result",
				tool_use_id: isStr(m.toolCallId)
					? m.toolCallId
					: deterministicUuid(`${conversation.id}:${m.id}:orphan`),
				content: m.content,
			};
			if (m.isError === true) result.is_error = true;
			lines.push({
				...base,
				type: "user",
				userType: "external",
				cwd: "",
				version: GENERATOR,
				gitBranch: "",
				promptId,
				sourceToolAssistantUUID: parentUuid ?? uuid,
				message: { role: "user", content: [result] },
			});
		} else {
			// system and anything else: a system line with the text attached.
			lines.push({
				...base,
				type: "system",
				subtype: "curt_import",
				level: "info",
				content: m.content,
				userType: "external",
				cwd: "",
				version: GENERATOR,
				gitBranch: "",
			});
		}

		parentUuid = uuid;
		if (m.role === "user" && !Array.isArray(m.toolCalls)) {
			promptId = deterministicUuid(`${conversation.id}:${m.id}:next-prompt`);
		}
	}

	return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
}

export interface CcJsonlValidation {
	lines: number;
	/** Structural breakage: unparseable lines, broken uuid chain, duplicate uuid. */
	errors: string[];
	/** tool_result lines referencing no preceding tool_use — content-level
	 * lossiness inherited from the archive (aborted calls), not structural. */
	orphanToolResults: number;
}

/**
 * Structural validation of emitted (or any) Claude Code session JSONL:
 * every line parses and the uuid/parentUuid chain is intact. Orphan
 * tool_results (a .curt archive may legitimately contain an aborted tool
 * call with no result, or a result with no emitted call) are counted, not
 * fatal.
 */
export function validateCcJsonl(text: string): CcJsonlValidation {
	const errors: string[] = [];
	let orphanToolResults = 0;
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const seenUuids = new Set<string>();
	const toolUseIds = new Set<string>();
	let prevUuid: string | null = null;
	let n = 0;
	for (const line of lines) {
		n++;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			errors.push(`line ${n}: not JSON`);
			continue;
		}
		if (!isObj(obj)) {
			errors.push(`line ${n}: not an object`);
			continue;
		}
		const uuid = obj.uuid;
		if (!isStr(uuid)) errors.push(`line ${n}: missing uuid`);
		else if (seenUuids.has(uuid)) errors.push(`line ${n}: duplicate uuid`);
		else seenUuids.add(uuid);
		const parent = obj.parentUuid;
		if (isStr(parent)) {
			if (parent !== prevUuid) errors.push(`line ${n}: parentUuid does not chain`);
		} else if (parent !== null && n !== 1) {
			errors.push(`line ${n}: missing parentUuid on non-first line`);
		}
		prevUuid = isStr(uuid) ? uuid : prevUuid;

		const message = isObj(obj.message) ? obj.message : null;
		const content = message?.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!isObj(block)) continue;
				if (block.type === "tool_use" && isStr(block.id)) {
					toolUseIds.add(block.id);
				}
				if (block.type === "tool_result") {
					const tid = block.tool_use_id;
					if (!isStr(tid) || !toolUseIds.has(tid)) {
						orphanToolResults++;
					}
				}
			}
		}
	}
	return { lines: lines.length, errors, orphanToolResults };
}
