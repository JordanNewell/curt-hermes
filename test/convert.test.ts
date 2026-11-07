import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCurt } from "curt-format";
import {
	EXTENSIONS,
	GENERATOR,
	convertDb,
	convertSession,
	deriveTitle,
	deterministicUuid,
	emitClaudeCodeJsonl,
	resolveCurtWritePath,
	serializeValidated,
	stripUntrustedWrapper,
	toEpochMs,
	validateCcJsonl,
} from "../src/hermes.js";
import { SESSION_A, SESSION_B, SESSION_C, SESSION_D, buildFixtureDb } from "./fixtures.js";

// Built at module load: describe bodies below convert eagerly.
const tmp = mkdtempSync(join(tmpdir(), "curt-hermes-fixture-"));
const dbPath = buildFixtureDb(tmp);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("toEpochMs", () => {
	it("multiplies epoch SECONDS to ms", () => {
		expect(toEpochMs(1778447132.909)).toBe(1778447132909);
	});
	it("passes already-ms values through", () => {
		expect(toEpochMs(1778447132909)).toBe(1778447132909);
	});
	it("returns 0 for garbage", () => {
		expect(toEpochMs(null)).toBe(0);
		expect(toEpochMs("soon")).toBe(0);
		expect(toEpochMs(Number.NaN)).toBe(0);
	});
});

describe("deriveTitle", () => {
	it("collapses whitespace and caps at 60 chars", () => {
		expect(deriveTitle("x".repeat(100)).length).toBe(60);
		expect(deriveTitle("  a\n\nb  ")).toBe("a b");
	});
});

describe("normalizeContent semantics", () => {
	it("treats empty and NULL content as empty text", () => {
		const stats = {
			roles: { user: 0, assistant: 0, tool: 0 }, skippedRoles: 0, malformedRows: 0,
			jsonContents: 0, untrustedWrappers: 0, redactedFields: 0,
			unmatchedToolCalls: 0, unmatchedToolResults: 0, emptyDropped: 0,
		};
		expect(stripUntrustedWrapper("", stats)).toBe("");
	});
});

describe("stripUntrustedWrapper", () => {
	const stats = {
		roles: { user: 0, assistant: 0, tool: 0 }, skippedRoles: 0, malformedRows: 0,
		jsonContents: 0, untrustedWrappers: 0, redactedFields: 0,
		unmatchedToolCalls: 0, unmatchedToolResults: 0, emptyDropped: 0,
	};
	it("strips the open tag line and closing line, counting the pair", () => {
		const out = stripUntrustedWrapper(
			'<untrusted_tool_result source="mcp__synthetic__read">\nbody line\n</untrusted_tool_result>',
			stats,
		);
		expect(out).toBe("body line");
		expect(stats.untrustedWrappers).toBe(1);
	});
	it("leaves plain content untouched", () => {
		expect(stripUntrustedWrapper("plain body", stats)).toBe("plain body");
		expect(stats.untrustedWrappers).toBe(1);
	});
});

describe("convertSession — session A (discord, rich shapes)", () => {
	const all = convertDb(dbPath);
	const item = all.items.find((i) => i.sessionId === SESSION_A)!;
	const c = item.result.conversation;
	const stats = item.result.stats;

	it("is present and titled from the first user message", () => {
		expect(item.source).toBe("discord");
		expect(c.title).toBe("Synthetic first user prompt for fixture session A.");
	});

	it("normalizes epoch seconds to ms for createdAt/updatedAt", () => {
		expect(c.createdAt).toBe(1778447132909);
		expect(c.updatedAt).toBe(1778447203051);
	});

	it("takes the model from the session row", () => {
		expect(c.model).toBe("synthetic-model-a");
	});

	it("emits roles in row order, skipping session_meta", () => {
		expect(c.messages.map((m) => m.role)).toEqual([
			"user", "assistant", "tool", "user", "assistant", "tool",
		]);
		expect(c.messages.map((m) => m.id)).toEqual(
			c.messages.map((_, i) => `${SESSION_A}-${i + 1}`),
		);
	});

	it("maps assistant reasoning to thinking and toolCalls to passthrough extras", () => {
		const a = c.messages[1]!;
		expect(a.content).toBe("Running the synthetic tool now.");
		expect(a.thinking).toBe(
			"Synthetic reasoning trace part one.\n\nSynthetic reasoning trace part two.",
		);
		expect(a.stopReason).toBe("tool_calls");
		expect(a.tokens).toEqual({ totalTokens: 210 });
		expect(a.toolCalls).toEqual([
			{ id: "call_syn1", name: "read_file", arguments: { path: "synthetic.txt" } },
		]);
		// plumbing fields (call_id, response_item_id, type) are not carried
		expect(JSON.stringify(a.toolCalls)).not.toContain("cid_syn1");
		expect(JSON.stringify(a.toolCalls)).not.toContain("ri_syn1");
	});

	it("strips the untrusted wrapper from tool output", () => {
		expect(c.messages[2]!.content).toBe("Tool output: synthetic-42");
		expect(c.messages[2]!.toolCallId).toBe("call_syn1");
		expect(c.messages[2]!.toolName).toBe("read_file");
	});

	it("re-serializes JSON contents as text", () => {
		expect(c.messages[4]!.content).toBe('{"text":"Structured synthetic reply.","done":true}');
		expect(c.messages[5]!.content).toBe(
			'{"output":"synthetic structured tool output","exit_code":0}',
		);
	});

	it("carries generic hermes metadata, token rollups, and multi-model usage", () => {
		expect(c.hermes).toEqual({ source: "discord", chatType: "dm", endReason: "agent_close" });
		expect(c.hermesTokens).toEqual({
			inputTokens: 1200,
			outputTokens: 3400,
			cacheReadTokens: 100,
			cacheWriteTokens: 200,
			reasoningTokens: 500,
		});
		expect(c.hermesCostUsd).toBe(0.0123);
		expect(c.hermesModelUsage).toHaveLength(2);
		expect(c.hermesModelUsage![0]).toMatchObject({
			model: "synthetic-model-a",
			apiCallCount: 6,
			inputTokens: 1000,
		});
		expect(c.hermesModelUsage![1]!.model).toBe("synthetic-model-small");
	});

	it("never emits identifier columns", () => {
		const s = JSON.stringify(c);
		for (const banned of [
			"SYNTHETIC SYSTEM PROMPT",
			"synthetic-user-id",
			"synthetic-session-key",
			"synthetic-chat-id",
			"synthetic-thread-id",
			"synthetic-display-name",
			"synthetic.invalid",
			"synthetic-provider",
			"read_file\"]",
		]) {
			expect(s).not.toContain(banned);
		}
	});

	it("counts wrappers, JSON contents, unmatched pairs, and redactions", () => {
		expect(stats.untrustedWrappers).toBe(1);
		expect(stats.jsonContents).toBe(2);
		expect(stats.skippedRoles).toBe(1);
		expect(stats.unmatchedToolResults).toBe(1); // call_missing
		expect(stats.unmatchedToolCalls).toBe(0); // call_syn1 answered
		expect(stats.redactedFields).toBe(13); // 10 identifier columns + 3 tool_calls plumbing fields
		expect(stats.roles).toEqual({ user: 2, assistant: 2, tool: 2 });
	});
});

describe("convertSession — session B (cli, title + malformed rows)", () => {
	const item = convertDb(dbPath).items.find((i) => i.sessionId === SESSION_B)!;
	const c = item.result.conversation;
	const stats = item.result.stats;

	it("uses the stored title instead of deriving one", () => {
		expect(c.title).toBe("A stored synthetic title");
	});

	it("counts malformed tool_calls and empty assistant content without dying", () => {
		expect(stats.malformedRows).toBe(1);
		expect(stats.emptyDropped).toBe(1);
		expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("does not emit model usage for single-model sessions", () => {
		expect(c.hermesModelUsage).toBeUndefined();
		expect(c.hermesTokens).toEqual({ inputTokens: 100, outputTokens: 200 });
	});
});

describe("convertDb filters", () => {
	it("--source filters by sessions.source", () => {
		const cron = convertDb(dbPath, { source: "cron" });
		expect(cron.converted).toBe(1);
		expect(cron.items[0]!.sessionId).toBe(SESSION_C);
		expect(convertDb(dbPath, { source: "cli" }).items[0]!.sessionId).toBe(SESSION_B);
	});

	it("--session selects exactly one session", () => {
		expect(convertDb(dbPath, { session: SESSION_A }).converted).toBe(1);
		expect(convertDb(dbPath, { session: "no-such" }).converted).toBe(0);
	});

	it("--sample caps conversions", () => {
		expect(convertDb(dbPath, { sample: 2 }).converted).toBe(2);
	});

	it("sessions with no usable messages are skipped", () => {
		const all = convertDb(dbPath);
		expect(all.skipped).toBe(1); // SESSION_D
		expect(all.items.find((i) => i.sessionId === SESSION_D)).toBeUndefined();
	});
});

describe("round-trip validation", () => {
	it("every converted fixture parses back with parseCurt, extras intact", () => {
		const { items } = convertDb(dbPath);
		expect(items.length).toBeGreaterThanOrEqual(3);
		for (const { result } of items) {
			const body = serializeValidated(result.conversation);
			expect(body).not.toBeNull();
			const parsed = parseCurt(body!);
			expect(parsed).not.toBeNull();
			expect(parsed!.id).toBe(result.conversation.id);
			expect(parsed!.messages).toHaveLength(result.conversation.messages.length);
			expect(parsed!.hermes).toEqual(result.conversation.hermes);
			expect(parsed!.hermesTokens).toEqual(result.conversation.hermesTokens);
			expect(parsed!.hermesModelUsage).toEqual(result.conversation.hermesModelUsage);
			const withCalls = parsed!.messages.find((m) => Array.isArray(m.toolCalls));
			if (withCalls) expect(withCalls.toolCalls).toBeDefined();
			const tool = parsed!.messages.find((m) => m.role === "tool");
			if (tool) expect(tool.toolCallId).toBeDefined();
		}
	});

	it("declares only the stable usage-metadata extension and signs the generator", () => {
		const { items } = convertDb(dbPath);
		const doc = JSON.parse(serializeValidated(items[0]!.result.conversation)!) as Record<
			string,
			unknown
		>;
		expect(doc.generator).toBe(GENERATOR);
		expect(doc.extensions).toEqual([...EXTENSIONS]);
	});
});

describe("resolveCurtWritePath", () => {
	const tmp2 = mkdtempSync(join(tmpdir(), "curt-hermes-collide-"));
	const file = join(tmp2, "2026-01-01 test demo.curt");

	it("returns the original path when the file does not exist", () => {
		expect(resolveCurtWritePath(file, "body")).toEqual({ path: file, collided: false });
	});
	it("overwrites identical content in place", () => {
		writeFileSync(file, "body");
		expect(resolveCurtWritePath(file, "body")).toEqual({ path: file, collided: false });
	});
	it("suffixes -2 on differing content", () => {
		writeFileSync(file, "original");
		const result = resolveCurtWritePath(file, "different");
		expect(result.collided).toBe(true);
		expect(result.path).toBe(`${file.slice(0, -".curt".length)}-2.curt`);
		expect(readFileSync(file, "utf8")).toBe("original");
	});
	it("returns a matching -N variant instead of creating further duplicates", () => {
		const base = file.slice(0, -".curt".length);
		writeFileSync(file, "old body"); // stale base file
		writeFileSync(`${base}-2.curt`, "new body");
		const result = resolveCurtWritePath(file, "new body");
		expect(result.collided).toBe(false);
		expect(result.path).toBe(`${base}-2.curt`);
	});
	it("still suffixes fresh when no existing variant matches", () => {
		const base = file.slice(0, -".curt".length);
		writeFileSync(file, "old body");
		writeFileSync(`${base}-2.curt`, "other body");
		const result = resolveCurtWritePath(file, "new body");
		expect(result.collided).toBe(true);
		expect(result.path).toBe(`${base}-3.curt`);
	});

	afterAll(() => rmSync(tmp2, { recursive: true, force: true }));
});

describe("emitClaudeCodeJsonl — direction 2", () => {
	const item = convertDb(dbPath, { session: SESSION_A }).items[0]!;
	const jsonl = emitClaudeCodeJsonl(item.result.conversation);

	it("produces structurally valid JSONL with a chained uuid graph", () => {
		const check = validateCcJsonl(jsonl);
		expect(check.errors).toEqual([]);
		expect(check.orphanToolResults).toBe(1); // aborted call_missing carried through
		expect(check.lines).toBe(item.result.conversation.messages.length);
	});

	it("maps user text to a user line with a string content", () => {
		const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		const first = lines[0]!;
		expect(first.type).toBe("user");
		expect((first.message as Record<string, unknown>).role).toBe("user");
		expect((first.message as Record<string, unknown>).content).toBe(
			"Synthetic first user prompt for fixture session A.",
		);
		expect(first.parentUuid).toBeNull();
		expect(first.sessionId).toBe(SESSION_A);
		expect(first.timestamp).toBe(new Date(1778447133909).toISOString());
	});

	it("maps assistant toolCalls to tool_use blocks and tool rows to tool_result", () => {
		const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		const assistant = lines[1]!;
		expect(assistant.type).toBe("assistant");
		const blocks = (assistant.message as Record<string, unknown>).content as Record<
			string,
			unknown
		>[];
		expect(blocks.some((b) => b.type === "thinking")).toBe(true);
		const use = blocks.find((b) => b.type === "tool_use")!;
		expect(use.id).toBe("call_syn1");
		expect(use.name).toBe("read_file");
		expect(use.input).toEqual({ path: "synthetic.txt" });
		const toolResult = lines[2]!;
		const rc = ((toolResult.message as Record<string, unknown>).content as Record<
			string,
			unknown
		>[])[0]!;
		expect(rc.type).toBe("tool_result");
		expect(rc.tool_use_id).toBe("call_syn1");
		expect(rc.content).toBe("Tool output: synthetic-42");
	});

	it("is deterministic across runs", () => {
		const again = emitClaudeCodeJsonl(item.result.conversation);
		expect(again).toBe(jsonl);
	});

	it("derives stable uuids from conversation + message ids", () => {
		expect(deterministicUuid("x")).toBe(deterministicUuid("x"));
		expect(deterministicUuid("x")).not.toBe(deterministicUuid("y"));
		expect(deterministicUuid("x")).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("counts orphan tool_results without failing structure", () => {
		const orphan =
			JSON.stringify({
				type: "user",
				uuid: "u2",
				parentUuid: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				sessionId: "s",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }],
				},
			}) + "\n";
		const check = validateCcJsonl(orphan);
		expect(check.errors).toEqual([]);
		expect(check.orphanToolResults).toBe(1);
	});

	it("flags broken uuid chains as errors", () => {
		const bad =
			JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "t", sessionId: "s", message: { role: "user", content: "a" } }) +
			"\n" +
			JSON.stringify({ type: "user", uuid: "u2", parentUuid: "other", timestamp: "t", sessionId: "s", message: { role: "user", content: "b" } }) +
			"\n";
		expect(validateCcJsonl(bad).errors.length).toBeGreaterThan(0);
	});
});
