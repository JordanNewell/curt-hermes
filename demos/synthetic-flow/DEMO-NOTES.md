# Demos — synthetic only

Both directories are generated from the synthetic fixture DB
(`test/fixtures.ts`) — zero real conversation content:

- `synthetic-flow/` — Direction 1 output: three .curt conversations from the
  fixture store (a discord session with tool calls, an untrusted-wrapper
  tool result, JSON contents, multi-model usage; a cli session with a stored
  title and a malformed tool_calls row; a cron session).
- `synthetic-cc-jsonl/` — Direction 2 output: the same three conversations
  emitted as Claude Code session JSONL (validated uuid/parentUuid chain).

Regenerate:

```sh
node --experimental-strip-types test/make-demo.ts
node dist/cli.js demos/synthetic-fixture/state.db -o demos/synthetic-flow
node dist/cli.js --emit-cc-jsonl demos/synthetic-flow -o demos/synthetic-cc-jsonl
rm -rf demos/synthetic-fixture
```
