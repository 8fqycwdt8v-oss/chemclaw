# How to author a new skill

A skill pack is a directory under `skills/` containing two files:

```
skills/<your_skill_id>/
├── SKILL.md      # YAML frontmatter + description body
└── prompt.md     # Framing text prepended to the system prompt when active
```

## Steps

1. Copy this template directory:
   ```bash
   cp -r skills/_template skills/<your_skill_id>
   ```

2. Edit `SKILL.md`:
   - Set `id` to match the directory name.
   - Write a one-sentence `description`.
   - List the `tools` the skill uses (see AGENTS.md tool catalog).
   - Optionally set `max_steps_override` for longer-horizon tasks.

3. Write `prompt.md`:
   - 100–250 words is the right size.
   - Describe when the skill is triggered, the step-by-step approach, and any output conventions.
   - Do NOT duplicate the tool descriptions from AGENTS.md — reference tool names only.
   - Follow the citation discipline from AGENTS.md (no fabricated fact_ids).

4. Restart the agent service (or wait for the hot-reload interval).

5. Verify with `/skills list` — your skill should appear.

## Activation

Skills are activated in two ways:

- **Persistent**: `/skills enable <id>` — stays active for the session.
- **Per-turn**: a slash verb implies a skill (`/retro`, `/dr`, `/qc`).

## Constraints

- Max 8 simultaneously active skills (context window management).
- `tools` list entries must match registered tool IDs exactly.
- `id` must be a valid JS identifier (lowercase letters, digits, underscores).
