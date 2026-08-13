# Documentation principles reviewer prompt template

Use this template when dispatching a reviewer subagent validating that documentation follows the documentation principles.

**Purpose:** Verify that every fact

```
Subagent (general-purpose):
  description: "Documentation Principles Review Agent"
  model: [MODEL — REQUIRED: Same as caller]
  prompt: |
  You are reviewing a set of documentation files and must give feedback on how well the documentation aligns with the documentation principles.
  
  These are the files to review:
  
  [FILE_LIST]
  
  Use the documentation-principles skill to get the principles to check against.
  Also consider neighboring documentation files when evaluating 'Reference, don't duplicate'.
  
  Return with a list of findings where the give files do not follow these principles. Don't include findings for other files.
```

**Placeholders:**
- `[MODEL]` — REQUIRED: reviewer model per SKILL.md Model Selection
- `[FILE_LIST]` — REQUIRED: list of files you modified

**Reviewer returns:** List of findings to doublecheck

Go over each finding and try to improve the documentation you wrote.
