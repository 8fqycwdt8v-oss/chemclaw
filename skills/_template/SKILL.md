---
id: REPLACE_ME
description: "One-sentence description of what this skill enables."
version: 1
tools:
  - tool_name_1
  - tool_name_2
max_steps_override: 20
---

# Skill template

Replace this file when authoring a new skill.

## Required YAML frontmatter fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique slug — must match the directory name (e.g. `retro`). |
| `description` | string | One sentence shown to users in `/skills list`. |
| `version` | integer | Increment when the prompt changes substantially. |
| `tools` | string[] | Tool IDs this skill uses. The harness limits available tools to this list + the always-on baseline when the skill is active. |
| `max_steps_override` | integer (optional) | Override the default `AGENT_CHAT_MAX_STEPS` for turns when this skill is active. |

## How the harness uses this file

1. At startup, `core/skills.ts` scans `skills/*/SKILL.md`, parses the YAML frontmatter, and validates the schema.
2. When the user activates a skill (`/skills enable <id>`) or a slash verb implies one (`/dr` → `deep_research`, `/retro` → `retro`, `/qc` → `qc`), the skill is added to the active set for that turn.
3. The `apply-skills` pre_turn hook:
   - Prepends the corresponding `prompt.md` body to the system prompt (under a `## Active skill: <id>` heading).
   - Filters the available tool catalog to the union of `tools:` across all active skills plus the always-on baseline (`canonicalize_smiles`, `fetch_original_document`).
4. If no skills are active, all registered tools remain available (current default behavior).
