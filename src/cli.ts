#!/usr/bin/env node
/** curt-hermes CLI: Hermes state.db -> .curt files; .curt -> Claude Code JSONL. */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { curtFilename, parseCurt } from "curt-format";
import {
	GENERATOR,
	convertDb,
	emitClaudeCodeJsonl,
	resolveCurtWritePath,
	serializeValidated,
	validateCcJsonl,
} from "./hermes.js";

interface Options {
	outDir?: string;
	stdout: boolean;
	sample?: number;
	session?: string;
	source?: string;
	emitCcJsonl?: boolean;
}

function usage(): never {
	console.error(`curt-hermes — Hermes agent store <-> .curt conversations

Direction 1 (export/archive): Hermes state.db -> .curt files
  curt-hermes <state.db>
  curt-hermes <state.db> -o ./out
  curt-hermes <state.db> --source cli|cron|discord|subagent
  curt-hermes <state.db> --session <sessionId>
  curt-hermes <state.db> --sample 5
  curt-hermes <state.db> --stdout > one.curt

Input is the Hermes SQLite store (~/.hermes/state.db). The database is opened
read-only. Credential and identifier columns (system_prompt, origin_json,
display_name, user_id, session_key, chat_id, thread_id, billing_*, cwd, git
fields) are never read as values — only their NULL-ness, for drop accounting.

Direction 2 (bridge into Hermes): .curt -> Claude Code session JSONL
  curt-hermes --emit-cc-jsonl <file.curt|dir> [-o out]

Emits the de-facto Claude Code interchange format that 'hermes sessions
import' natively consumes, so .curt archives go INTO Hermes without upstream
changes. One .jsonl per conversation.

Options:
  -o, --out <dir>       Output directory (default: alongside the input)
  --source <s>          Direction 1: only sessions with sessions.source = s
  --session <id>        Direction 1: only the session with this id
  --sample <n>          Direction 1: only the first n matching sessions
  --stdout              Direction 1: print .curt bodies instead of writing
  --emit-cc-jsonl       Direction 2: .curt file(s) -> Claude Code JSONL
  -h, --help            Show this help`);
	process.exit(2);
}

function parseArgs(argv: string[]): { input?: string; options: Options } {
	const options: Options = { stdout: false };
	let input: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") usage();
		if (a === "--stdout") {
			options.stdout = true;
		} else if (a === "--emit-cc-jsonl") {
			options.emitCcJsonl = true;
		} else if (a === "-o" || a === "--out") {
			const v = argv[++i];
			if (!v) usage();
			options.outDir = v;
		} else if (a === "--source") {
			const v = argv[++i];
			if (!v) usage();
			options.source = v;
		} else if (a === "--session") {
			const v = argv[++i];
			if (!v) usage();
			options.session = v;
		} else if (a === "--sample") {
			const v = argv[++i];
			const n = v ? Number(v) : NaN;
			if (!Number.isInteger(n) || n < 1) usage();
			options.sample = n;
		} else if (a.startsWith("-")) {
			console.error(`Unknown option: ${a}`);
			usage();
		} else if (input === undefined) {
			input = a;
		} else {
			console.error(`Unexpected extra argument: ${a}`);
			usage();
		}
	}
	return { input, options };
}

// ---- Direction 1 ----

function runConvert(dbPath: string, options: Options): number {
	const { items, converted, skipped, totals } = convertDb(dbPath, options);

	let roundtripFailures = 0;
	let collisions = 0;
	for (const { result } of items) {
		const body = serializeValidated(result.conversation);
		if (!body) {
			roundtripFailures++;
			console.error(`round-trip validation failed for ${result.conversation.id}; not written`);
			continue;
		}
		if (options.stdout) {
			console.log(body);
		} else {
			const outDir = resolve(options.outDir ?? ".");
			mkdirSync(outDir, { recursive: true });
			const file = join(outDir, curtFilename(result.conversation));
			const target = resolveCurtWritePath(file, body);
			if (target.collided) {
				collisions++;
				console.error(`filename collision for ${result.conversation.id}; wrote ${target.path} instead`);
			}
			writeFileSync(target.path, body);
			console.log(target.path);
		}
	}

	console.error(
		`${GENERATOR}: ${converted} converted, ${skipped} skipped, ${roundtripFailures} round-trip failures` +
			(collisions > 0 ? `, ${collisions} filename collisions (suffixed)` : "") +
			` (messages: ${totals.roles.user} user / ${totals.roles.assistant} assistant / ${totals.roles.tool} tool; ` +
			`${totals.skippedRoles} meta/system rows, ${totals.malformedRows} malformed rows, ` +
			`${totals.jsonContents} JSON contents, ${totals.untrustedWrappers} untrusted wrappers stripped, ` +
			`${totals.unmatchedToolCalls} unmatched toolCalls, ${totals.unmatchedToolResults} unmatched toolResults, ` +
			`${totals.emptyDropped} empty dropped, ${totals.redactedFields} identifier fields dropped)`,
	);
	// Per-session problems are counted, never fatal.
	return 0;
}

// ---- Direction 2 ----

function jsonlName(conversationId: string, createdAt: number, title: string): string {
	// Curtis bulk-convention name, .curt -> .jsonl.
	const fake = {
		id: conversationId,
		title,
		createdAt: Number.isFinite(createdAt) ? createdAt : 0,
	};
	const name = curtFilename(fake as never);
	return `${name.slice(0, -".curt".length)}.jsonl`;
}

function runEmitCcJsonl(input: string, options: Options): number {
	const st = statSync(input);
	const curtFiles: string[] = [];
	if (st.isDirectory()) {
		for (const f of readdirSync(input).sort()) {
			if (extname(f) === ".curt") curtFiles.push(join(input, f));
		}
	} else if (extname(input) === ".curt") {
		curtFiles.push(input);
	} else {
		console.error(`Not a .curt file or directory of .curt files: ${input}`);
		return 2;
	}
	if (curtFiles.length === 0) {
		console.error(`No .curt files found in ${input}`);
		return 2;
	}

	const outDir = options.outDir ? resolve(options.outDir) : st.isDirectory() ? resolve(input) : resolve(input, "..");
	if (!options.stdout) mkdirSync(outDir, { recursive: true });

	let written = 0;
	let rejected = 0;
	for (const file of curtFiles) {
		let body: string;
		try {
			body = readFileSync(file, "utf8");
		} catch {
			console.error(`unreadable: ${file}`);
			rejected++;
			continue;
		}
		const parsed = parseCurt(body);
		if (!parsed) {
			console.error(`not a valid .curt file, skipped: ${file}`);
			rejected++;
			continue;
		}
		const jsonl = emitClaudeCodeJsonl(parsed);
		const check = validateCcJsonl(jsonl);
		if (check.errors.length > 0) {
			console.error(`structural validation failed for ${parsed.id}; not written (${check.errors.length} errors)`);
			rejected++;
			continue;
		}
		if (check.orphanToolResults > 0) {
			console.error(`${parsed.id}: ${check.orphanToolResults} orphan tool_result(s) carried through from the archive`);
		}
		if (options.stdout) {
			process.stdout.write(jsonl);
		} else {
			const target = join(outDir, jsonlName(parsed.id, parsed.createdAt, parsed.title));
			writeFileSync(target, jsonl);
			console.log(target);
		}
		written++;
	}
	console.error(
		`${GENERATOR}: ${written} JSONL emitted (${curtFiles.length - written - rejected} empty), ${rejected} rejected`,
	);
	return 0;
}

function main(): number {
	const { input, options } = parseArgs(process.argv.slice(2));
	if (options.emitCcJsonl) {
		if (!input) usage();
		return runEmitCcJsonl(resolve(input), options);
	}
	if (!input) usage();
	const dbPath = resolve(input);
	if (!existsSync(dbPath)) {
		console.error(`No such file: ${dbPath}`);
		return 2;
	}
	return runConvert(dbPath, options);
}

process.exitCode = main();
