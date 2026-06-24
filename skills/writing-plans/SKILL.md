---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write a comprehensive implementation plan. You can assume the engineer has the following context:

* CLAUDE.md file
* File/Folder specific guidelines: !`nessy config rules`

Assume the engineer follows information provided from the above sources but don't expect the engineer to have more context. Also expect him to have questionable taste outside the above specified guidelines. Document everything they need to know: which files to touch for each task, important code snippets, test scenarios (prosa), docs and ADR they might need to read. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If working in an isolated worktree, it should have been created via the `superpowers:using-git-worktrees` skill at execution time.

**Save plans to:** !`nessy config writingPlans.outputFile`

## Input

As a first action, check if your human partner has provided you one or more design specification files to work from. If not, ask him to provide them. It is also possible that your human partner provides you the information inline via the prompt. Then however consider if the information is thorough enough or if an actual design document should be drafted from it. If this seems even slightly reasonable to you, ask if you should use the brainstorming skill.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.


## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is a small unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use nessy:subagent-driven-development (recommended) or nessy:executing-plans to implement this plan task-by-task. Acceptance criteria and Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [New Key technologies/libraries, if any]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

**Global Guidelines:**

[List guideline files (claude.md files, documentation, adrs, best practice files) that are important for every task in the plan and should be read no matter which task gets implemented.]

---
```

## Task Structure

````markdown
### Task N: [Task Name]

**Files:**

[List which files are touched by this task]

**Guidelines:**

[List guideline files (claude.md files, documentation, adrs, best practice files) that are important for the current task]

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

**Acceptance criteria / Tests:**  

[
List all acceptance criteria that have to be met for this task to count as completed as checkbox items. There are two types of acceptance criteria:

- Tests: For these criterias, a programmatic testcase should be written. Document each test in prosa by specifying given, when and then in a complete test scenario.
- Other criterias: If it does not make sense to write a testcase for an AC, like File A should be moved to Folder B or a specific formater should be configured, write down in prosa what should work and a way to test it manually for the implementation agent.
]
  
**Implementation steps**:

[Give a complete list of steps that have to be done to fulfill the above criterias as ordered checkbox items. Describe what file has to touched in each step, what to do in prosa and special edge cases to consider. Don't always include the complete code the step should write, but if helpful provide code snippets for complex logic]

````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the implementation" (without actual complete test scenarios)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete acceptance criteria in every step. If no criteria exist, the engineer won't implement it.
- Exact commands with expected output
- DRY, YAGNI, TDD

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task and in there acceptance criteria that covers it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After saving the plan, offer execution choice:

**"Plan complete and saved to !`nessy config writingPlans.outputFile`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?"**

**If Subagent-Driven chosen:**
- **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development
- Fresh subagent per task + two-stage review

**If Inline Execution chosen:**
- **REQUIRED SUB-SKILL:** Use superpowers:executing-plans
- Batch execution with checkpoints for review

## Extra project-specific information

If provided, also consider the following project-specific information for writing implementation plans:

!`nessy config writingPlans.extraContext`