# Runbook: Agent filesystem & shell builtins

`read_file`, `write_file`, `list_directory`, and `run_shell` are
**default-OFF**. ChemClaw is a domain-specialized chemistry agent; direct
filesystem / shell access widens the trust boundary, so an operator must opt
in explicitly. This runbook covers the recommended layout, env-var
configuration, and the `permission_policies` rules to pair with them.

Source: `services/agent-claw/src/tools/builtins/{read_file,write_file,list_directory,run_shell}.ts`,
shared path guard `services/agent-claw/src/tools/builtins/_fs_root.ts`,
registration in `services/agent-claw/src/bootstrap/dependencies.ts`.

## Trust boundary (what protects you)

1. **`AGENT_FS_ROOT`** — every path the agent supplies is resolved against
   this directory and rejected if it escapes via `..` traversal, an absolute
   path outside the root, or a symlink that points outside. Writes to
   not-yet-existing paths resolve the *parent's* realpath, so a dangling
   symlink can't be used to escape.
2. **`AGENT_SHELL_ALLOWLIST`** — `run_shell` only spawns `argv[0]` values on
   this list. Empty list ⇒ `run_shell` refuses every call. Entries must be
   bare executable names (`git`, not `/usr/bin/git`); a path separator in
   `command` is rejected.
3. **No shell interpretation** — `run_shell` uses `spawn`, not a shell. Pipes,
   redirection, `$VAR`, `$(...)` in `args` are literal strings. There is no
   back door to arbitrary execution; never put `sh` / `bash` on the allowlist.
4. **Stripped child env** — `run_shell` children get only `PATH`, `HOME`,
   `LANG` — not the agent's credentials.
5. **Hard caps** — `read_file` 1 MiB (8 MiB for sliced reads); `write_file`
   4 MiB; `list_directory` 1000 entries default (5000 max); `run_shell`
   stdout/stderr 256 KiB each, wall-clock `AGENT_SHELL_TIMEOUT_MS`.
6. **`permission_policies`** still apply on top of all of the above — the
   allowlist is the belt, permission policies are the suspenders.

## 1. Recommended workdir layout

Put `AGENT_FS_ROOT` on a dedicated volume that holds **nothing the agent
shouldn't see or clobber** — no source tree, no secrets, no other tenants'
data. A flat per-purpose layout:

```
/var/lib/chemclaw/agent-workdir/        ← AGENT_FS_ROOT
├── scratch/      transient agent output (safe to wipe between sessions)
├── inputs/       operator-staged read-only inputs (datasets, SDFs, logs)
└── artifacts/    files the agent produces that you want to keep
```

- Mount the volume `rw` for the agent process only; back up `artifacts/`.
- If you run multiple tenants/projects, give each its own root and its own
  agent process — the fs tools have no per-tenant subdivision.
- Don't bind-mount the repo, `~/.ssh`, `/etc`, or the Docker socket under it.

## 2. Enable the tools

In the agent-claw environment (`.env` / Helm values):

```bash
AGENT_FS_TOOLS_ENABLED=true
AGENT_FS_ROOT=/var/lib/chemclaw/agent-workdir   # MUST be an existing dir
AGENT_SHELL_TIMEOUT_MS=120000                   # run_shell hard timeout
# Comma-separated argv[0] allowlist. Empty ⇒ run_shell stays disabled even
# when the other fs tools are on. Restrict to your build/test/git tooling.
AGENT_SHELL_ALLOWLIST=git,python3,pytest,node,npm
```

Restart agent-claw. On boot `dependencies.ts` registers `read_file`,
`write_file`, `list_directory`, and (only if `AGENT_SHELL_ALLOWLIST` is
non-empty) `run_shell`. The builtin-count drift gate
(`MIN_EXPECTED_BUILTINS` in `bootstrap/start.ts`) accounts for these being
conditional, so a stack with them off still boots.

Allowlist hygiene:
- **Never** `sh`, `bash`, `zsh`, `env`, `xargs`, `find` (`-exec`), `awk`,
  `perl`, `python -c` style interpreters invoked bare — any of these
  re-introduces arbitrary execution.
- Prefer specific tools (`git`, `pytest`, `ruff`) over broad ones.
- Remember the child only has `PATH`/`HOME`/`LANG`; tools needing other env
  (proxy vars, registry tokens) won't pick them up — configure the tool
  itself or fork `run_shell`.

## 3. Pair with permission policies (production)

`AGENT_FS_TOOLS_ENABLED` registers the tools; it does **not** auto-allow them
under `enforce` permission mode. For any route that runs with
`permissionMode: "enforce"` (`/api/chat` today), add explicit allow rules so
the resolver (`deny > ask > allow`) lets them through, scoped as tightly as
you can:

```bash
# Read-only tools: allow globally (or per-org / per-project).
curl -X POST -H "x-user-entra-id: $YOU" -H "content-type: application/json" \
  -d '{"scope":"global","scope_id":"",
       "decision":"allow","tool_pattern":"read_file",
       "reason":"fs tools enabled per runbook","audit_reason":"enable read_file"}' \
  "$AGENT_BASE_URL/api/admin/permission-policies"

curl -X POST -H "x-user-entra-id: $YOU" -H "content-type: application/json" \
  -d '{"scope":"global","scope_id":"",
       "decision":"allow","tool_pattern":"list_directory",
       "reason":"fs tools enabled per runbook","audit_reason":"enable list_directory"}' \
  "$AGENT_BASE_URL/api/admin/permission-policies"

# State-mutating tools: prefer "ask" (interactive confirmation) over "allow",
# or scope "allow" to a specific project that needs unattended writes.
curl -X POST -H "x-user-entra-id: $YOU" -H "content-type: application/json" \
  -d '{"scope":"project","scope_id":"<project-id>",
       "decision":"allow","tool_pattern":"write_file",
       "reason":"automated artifact export for <project>","audit_reason":"enable write_file for <project>"}' \
  "$AGENT_BASE_URL/api/admin/permission-policies"

curl -X POST -H "x-user-entra-id: $YOU" -H "content-type: application/json" \
  -d '{"scope":"project","scope_id":"<project-id>",
       "decision":"ask","tool_pattern":"run_shell",
       "reason":"shell builds require human confirmation","audit_reason":"gate run_shell"}' \
  "$AGENT_BASE_URL/api/admin/permission-policies"
```

`tool_pattern` supports trailing wildcards; `argument_pattern` can further
restrict (e.g. only `run_shell` calls whose `command` is `pytest`). The
harness in `acceptEdits` mode auto-allows fs-touching tools — only use that
mode for trusted, non-production flows.

To disable later: flip the policy to `deny` (hot, ≤60 s) per
`docs/runbooks/disable-tool.md`, or unset `AGENT_FS_TOOLS_ENABLED` and
restart.

## 4. What the tools do NOT do

- No `edit_file` / patch-apply tool — `write_file` overwrites whole files
  (`overwrite=true` required to clobber; `create_parents=true` to mkdir).
- No streaming / random-access reads beyond `read_file`'s `start_line` +
  `line_count` slice (bounded to an 8 MiB file).
- No recursive directory walk — `list_directory` is one level; the model
  must recurse via repeated calls.
- No env passthrough or interactive TTY in `run_shell`.

## 5. Incident response

- Suspected misuse: `deny` the tool via `permission_policies` (effective
  ≤60 s), then investigate. Tool calls and arguments are in the agent logs
  (redacted) and Langfuse spans.
- Suspected escape: the path guard rejects with `PathEscapesRootError` /
  `WorkspaceBoundaryError` — grep logs for those. If you see a *successful*
  access outside `AGENT_FS_ROOT`, treat it as a guard bug, file it, and
  unset `AGENT_FS_TOOLS_ENABLED` until triaged.
- Cleanup: `scratch/` is safe to wipe at any time; treat `artifacts/` as
  agent-authored content (review before trusting / shipping it).
