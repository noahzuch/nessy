# Convention: Spec/Decisions Location and Format

The `brainstorm` skill can take its output location (and, optionally, file names and format)
from a project convention instead of the built-in default. Record it as a section titled exactly
`## Spec/Decisions Location and Format` in the project's `CLAUDE.md` (or `AGENTS.md`, or any file
that `CLAUDE.md` pulls in via the `@path` import syntax, e.g. `@README.md`).

Because `CLAUDE.md` is already in the model's context, the skill simply follows such a section;
it is not parsed as config. This file only documents the pattern the skill offers to write.

Use this for a team-shared, committed default that lives in the repo. Note the precedence: a
per-machine `BRAINSTORM_OUT_LOCATION` env var, if set, overrides this convention.

## Ready-to-paste section

```markdown
## Spec/Decisions Location and Format

- **Location:** `docs/design/<topic-slug>/` (one folder per brainstorm topic).
- **Decision Journal:** `decisions.md`, Markdown, incremental `F-N` / `D-N` / `Q-N` entries
  with status tags (facts `verified` / `assumed` / `REFUTED`; decisions `accepted` /
  `superseded-by`). A refuted fact or superseded decision is never deleted — it is marked and
  the correction added as a new entry.
- **Spec:** `spec.md`, Markdown with sections Goal, Context, Design, Acceptance Criteria,
  Boundaries, Out of Scope. Acceptance criteria use RFC-2119 keywords and EARS style
  ("When <trigger>, the system SHALL ..."), each with an executable/observable DoD line.
- **Research artifacts:** `research/` subfolder inside the topic folder.
- **Commit policy:** brainstorm artifacts are private explorations. Do not commit without asking.
```

Adjust the values; only the fields you set override the default, anything you omit falls back.
Keep the exact title `## Spec/Decisions Location and Format` so the skill recognizes it.
