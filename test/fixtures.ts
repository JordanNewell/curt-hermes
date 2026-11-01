/**
 * Builds a synthetic Hermes state.db fixture (schema mirrors the real store,
 * schema_version 30 — sessions / messages / session_model_usage, with the
 * real columns this converter touches). All content is synthetic.
 *
 * DB driver: node:sqlite (DatabaseSync) — built into Node >= 22.5, zero
 * native dependencies; deliberate choice over better-sqlite3.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SESSION_A = "20260510_215901_aaaaaaaa"; // discord, rich shapes
export const SESSION_B = "20260511_101502_bbbbbbbb"; // cli, title present
export const SESSION_C = "20260512_120000_cccccccc"; // cron, filtered by --source
export const SESSION_D = "20260513_090000_dddddddd"; // discord, no usable messages

export function buildFixtureDb(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const dbPath = join(dir, "state.db");
	const db = new DatabaseSync(dbPath);

	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY, source TEXT, user_id TEXT, model TEXT,
			model_config TEXT, system_prompt TEXT, parent_session_id TEXT,
			started_at REAL, ended_at REAL, end_reason TEXT,
			message_count INTEGER, tool_call_count INTEGER,
			input_tokens INTEGER, output_tokens INTEGER,
			cache_read_tokens INTEGER, cache_write_tokens INTEGER,
			reasoning_tokens INTEGER, billing_provider TEXT, billing_base_url TEXT,
			billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
			title TEXT, archived INTEGER, session_key TEXT, chat_id TEXT,
			chat_type TEXT, thread_id TEXT, display_name TEXT, origin_json TEXT,
			profile_name TEXT, pinned INTEGER, tool_names TEXT, title_source TEXT
		);
		CREATE TABLE messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
			content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT,
			timestamp REAL, token_count INTEGER, finish_reason TEXT,
			reasoning TEXT, reasoning_content TEXT
		);
		CREATE TABLE session_model_usage (
			session_id TEXT, model TEXT, billing_provider TEXT,
			api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
			cache_read_tokens INTEGER, cache_write_tokens INTEGER,
			reasoning_tokens INTEGER, estimated_cost_usd REAL
		);
	`);

	const addSession = (s: Record<string, unknown>) => {
		const keys = Object.keys(s);
		db.prepare(
			`INSERT INTO sessions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
		).run(...keys.map((k) => s[k] as string | number | null));
	};
	const addMessage = (m: Record<string, unknown>) => {
		const keys = Object.keys(m);
		db.prepare(
			`INSERT INTO messages (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
		).run(...keys.map((k) => m[k] as string | number | null));
	};

	// Epoch SECONDS (Hermes stores REAL seconds; converter normalizes to ms).
	const T0 = 1778447132.909; // -> 1778447132909 ms
	const T1 = 1778447143.051; // -> 1778447143051 ms

	addSession({
		id: SESSION_A,
		source: "discord",
		user_id: "synthetic-user-id",
		model: "synthetic-model-a",
		system_prompt: "SYNTHETIC SYSTEM PROMPT — never emitted",
		started_at: T0,
		ended_at: T1 + 60,
		end_reason: "agent_close",
		message_count: 7,
		tool_call_count: 2,
		input_tokens: 1200,
		output_tokens: 3400,
		cache_read_tokens: 100,
		cache_write_tokens: 200,
		reasoning_tokens: 500,
		estimated_cost_usd: 0.0123,
		session_key: "synthetic-session-key",
		chat_id: "synthetic-chat-id",
		chat_type: "dm",
		thread_id: "synthetic-thread-id",
		display_name: "synthetic-display-name",
		origin_json: '{"surface":"synthetic"}',
		billing_provider: "synthetic-provider",
		billing_base_url: "https://synthetic.invalid",
		tool_names: '["read_file"]',
		title: null,
		title_source: null,
	});
	addMessage({
		session_id: SESSION_A, role: "session_meta", content: null,
		timestamp: T0, token_count: 0,
	});
	addMessage({
		session_id: SESSION_A, role: "user",
		content: "Synthetic first user prompt for fixture session A.",
		timestamp: T0 + 1, token_count: 12,
	});
	addMessage({
		session_id: SESSION_A, role: "assistant",
		content: "Running the synthetic tool now.",
		tool_calls: JSON.stringify([
			{
				id: "call_syn1",
				call_id: "cid_syn1",
				response_item_id: "ri_syn1",
				type: "function",
				function: { name: "read_file", arguments: JSON.stringify({ path: "synthetic.txt" }) },
			},
		]),
		reasoning: "Synthetic reasoning trace part one.",
		reasoning_content: "Synthetic reasoning trace part two.",
		finish_reason: "tool_calls",
		timestamp: T0 + 2, token_count: 210,
	});
	addMessage({
		session_id: SESSION_A, role: "tool", tool_call_id: "call_syn1",
		tool_name: "read_file",
		content: `<untrusted_tool_result source="mcp__synthetic__read">\nTool output: synthetic-42\n</untrusted_tool_result>`,
		timestamp: T0 + 3, token_count: 8,
	});
	addMessage({
		session_id: SESSION_A, role: "user",
		content: "Synthetic follow-up question.",
		timestamp: T0 + 4, token_count: 9,
	});
	addMessage({
		session_id: SESSION_A, role: "assistant",
		content: JSON.stringify({ text: "Structured synthetic reply.", done: true }),
		timestamp: T0 + 5, token_count: 55,
	});
	addMessage({
		session_id: SESSION_A, role: "tool", tool_call_id: "call_missing",
		tool_name: "orphan_tool",
		content: JSON.stringify({ output: "synthetic structured tool output", exit_code: 0 }),
		timestamp: T0 + 6, token_count: 10,
	});

	addSession({
		id: SESSION_B,
		source: "cli",
		model: "synthetic-model-b",
		started_at: T0 + 100,
		ended_at: T1 + 200,
		end_reason: "session_reset",
		message_count: 3,
		input_tokens: 100,
		output_tokens: 200,
		estimated_cost_usd: 0.002,
		title: "A stored synthetic title",
		title_source: "llm",
		archived: 1,
		pinned: 0,
		// malformed tool_calls JSON on the assistant row
	});
	addMessage({
		session_id: SESSION_B, role: "user",
		content: "Synthetic prompt for cli session B.",
		timestamp: T0 + 101, token_count: 10,
	});
	addMessage({
		session_id: SESSION_B, role: "assistant",
		content: "Reply with broken tool_calls payload.",
		tool_calls: "{not json",
		timestamp: T0 + 102, token_count: 20,
	});
	addMessage({
		session_id: SESSION_B, role: "assistant",
		content: "",
		timestamp: T0 + 103, token_count: 0,
	});

	addSession({
		id: SESSION_C,
		source: "cron",
		model: "synthetic-model-c",
		started_at: T0 + 300,
		ended_at: T0 + 320,
		end_reason: "cron_complete",
		message_count: 1,
	});
	addMessage({
		session_id: SESSION_C, role: "user",
		content: "Synthetic cron churn prompt — filtered out by --source.",
		timestamp: T0 + 301, token_count: 5,
	});

	addSession({
		id: SESSION_D,
		source: "discord",
		started_at: T0 + 400,
		ended_at: T0 + 401,
		message_count: 0,
	});
	addMessage({
		session_id: SESSION_D, role: "session_meta", content: null, timestamp: T0 + 400,
	});

	// Multi-model usage on A (emitted), single-model on B (not emitted).
	db.prepare(
		`INSERT INTO session_model_usage (session_id, model, api_call_count,
		 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		 reasoning_tokens, estimated_cost_usd)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(SESSION_A, "synthetic-model-a", 6, 1000, 3000, 90, 180, 450, 0.01);
	db.prepare(
		`INSERT INTO session_model_usage (session_id, model, api_call_count,
		 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		 reasoning_tokens, estimated_cost_usd)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(SESSION_A, "synthetic-model-small", 2, 200, 400, 10, 20, 50, 0.0023);
	db.prepare(
		`INSERT INTO session_model_usage (session_id, model, api_call_count,
		 input_tokens, output_tokens, estimated_cost_usd)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(SESSION_B, "synthetic-model-b", 3, 100, 200, 0.002);

	db.close();
	return dbPath;
}
