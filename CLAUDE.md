# CLAUDE.md

Guidance for Claude when working in this repo.

## Project

`chemclaw` is an autonomous agent for chemical development. Early scaffolding; Python-based. Copy `.env.example` to `.env` for API keys (Anthropic, optional PubChem/RCSB).

## Working style

- **Think, then act.** For non-trivial tasks, form a plan; if scope is ambiguous or spans >3 files, confirm before executing.
- **Reuse first.** Search the codebase for existing helpers, constants, and types before creating new ones.
- **Do less.** No scaffolding, placeholder stubs, or speculative abstractions. If a complete implementation isn't possible, say so rather than shipping a skeleton.
- **Check impact.** After a change, verify callers and dependencies still hold. Don't silently break upstream code.

## Code quality

- Functions do one thing; keep them short and readably nested.
- Descriptive names, named constants, no dead code.
- Handle errors explicitly — never swallow exceptions. Propagate with context.
- Comment *why*, not *what*. Public APIs get docstrings and type annotations.
- Delete rather than comment out.

## Python specifics

- Target Python 3.10+, type-annotate public functions.
- Use `pathlib`, `subprocess.run([...], check=True)` (never `shell=True` with user data), `secrets` for tokens.
- Avoid `pickle` on untrusted data. Virtual envs for setup.

## Security (the essentials)

- Never hardcode secrets or commit `.env`. Load from env vars.
- Validate external input at trust boundaries; use allowlists where practical.
- Use parameterized queries and safe APIs — no string-built SQL, shell, or HTML.
- Use well-audited crypto libraries; never roll your own. TLS 1.2+, verified.
- Don't log secrets or PII.

Flag risky patterns inline and prefer the secure default. Refuse to emit hardcoded credentials, TLS bypass, or broken crypto (MD5/SHA1 for integrity, DES, ECB).

## Testing

- Cover happy path, edge cases, and at least one failure mode for public APIs.
- Add a regression test when fixing a bug.
- No empty or trivially-passing tests.

## Git

- Atomic commits; Conventional Commits style (`feat:`, `fix:`, `docs:`…).
- Don't force-push protected branches. Rotate any secret that lands in history.

## Before marking a task done

- No placeholders (`TODO`, `pass`, `NotImplementedError`, dummy config).
- Callers and dependencies checked.
- Errors handled, inputs validated, no secrets in code or logs.
- Tests cover the change; style matches surrounding code.
