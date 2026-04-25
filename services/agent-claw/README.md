# agent-claw

ChemClaw agent service — custom harness with hooks-first architecture.

Runs on port **3101** alongside the legacy `services/agent/` service (port 3100)
during Phases A–E. Port 3100 is decommissioned in Phase F.

## Configuration

Copy `.env.example` from the repo root and set at minimum:

```
POSTGRES_PASSWORD=<secret>
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=<secret>
CHEMCLAW_DEV_MODE=true
```

To point the Streamlit frontend at this service instead of the legacy one:

```
AGENT_BASE_URL=http://localhost:3101
```

Phase B will wire the frontend switch formally.

## Development

```bash
make run.agent-claw       # starts on port 3101
npm run dev               # tsx watch (no make required)
npm test                  # vitest
npm run typecheck         # tsc --noEmit
```

## Hooks

YAML hook definitions live at `<repo-root>/hooks/*.yaml`. The loader reads
them at startup. The `HOOKS_DIR` env var overrides the default path.

Built-in hooks shipped in Phase A.3:

| Hook | Point | Effect |
|---|---|---|
| `redact-secrets` | `pre_tool` | Redacts SMILES, emails, NCE IDs, compound codes from tool inputs |
| `tag-maturity` | `post_tool` | Stamps `maturity: "EXPLORATORY"` on object outputs |
| `budget-guard` | `pre_tool` | Aborts tool call if projected token usage would exceed `AGENT_TOKEN_BUDGET` |

## Slash commands

Send as the first token of a user message:

| Command | Behavior |
|---|---|
| `/help` | Returns the verb list (no LLM call) |
| `/skills` | Lists skill packs (Phase B placeholder) |
| `/feedback up\|down "reason"` | Writes a row to `feedback_events` |
| `/check` | Confidence ensemble placeholder (Phase C) |
| `/learn` | Skill induction placeholder (Phase C) |
| `/plan <message>` | Runs harness in plan-mode preview |
| `/dr <question>` | Tags for deep-research skill (Phase B) |

## Architecture

See `AGENTS.md` at the repo root for the operational constitution and tool catalog.
See `~/.claude/plans/go-through-the-three-vivid-sunset.md` for the full phased roadmap.
