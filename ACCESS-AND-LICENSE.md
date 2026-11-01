# Access and license

Like `curt-openclaw` (and unlike `curt-wildchat`'s public research dataset),
this converter's input is **your own local Hermes data**: the SQLite store at
`~/.hermes/state.db` (plus its WAL/SHM sidecars, read but never written).
There is no remote access, no network use, and no credential surface:

- The database is opened SQLite `mode=ro` — writes are impossible by
  construction.
- Credential and identifier columns (`system_prompt`, `origin_json`,
  `display_name`, `user_id`, `session_key`, `chat_id`, `thread_id`,
  `billing_*`, `cwd`, git fields, `tool_names`) are never SELECTed as
  values — only their NULL-ness, for drop accounting. `auth.json`, config
  files, and token stores are never touched.
- Direction 2 reads only `.curt` files (which parseCurt validates
  whole-file) and writes Claude Code JSONL.

Consequences:

- **License of the code:** MIT (see `LICENSE`). Test fixtures and `demos/`
  are fully synthetic; no real conversation content ships in this repo.
- **License of converted content:** yours (or your agents'/providers', per
  your own terms). `.curt` and emitted JSONL output are record-equivalent to
  the source store — treat both as private, and scrub before sharing.
- Real-corpus conversion output is kept out of version control (untracked
  `work/` directory, gitignored from the start). The verified-corpus subset
  DB extracted from the remote host was deleted from the host immediately
  after conversion; the local copy lives only in gitignored `work/`.
