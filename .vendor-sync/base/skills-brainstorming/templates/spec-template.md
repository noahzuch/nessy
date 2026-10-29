# <TITLE>

> **Decision Journal:** Rationale, rejected alternatives, and implicit knowledge
> are documented in `decisions.md` (same directory).
> On ambiguity: **check there FIRST** before choosing your own interpretation.

## Goal

<!-- What this design achieves. One paragraph. -->

## Context

<!-- Why this exists now. What triggered it. What constraints apply. -->

## Design

<!-- The solution. Sections scaled to complexity. Each section covers one concern. -->

## Acceptance Criteria

<!-- Use RFC-2119 keywords for obligation level:
       SHALL / SHALL NOT = mandatory / forbidden   SHOULD = recommended (deviation needs a reason)
       MAY = optional
     Write behaviour criteria in EARS form:
       Ubiquitous:  The system SHALL <response>.
       Event:       When <trigger>, the system SHALL <response>.
       State:       While <state>, the system SHALL <response>.
       Unwanted:    If <condition>, the system SHALL <response>.
     Each AC carries a DoD line that is an EXECUTABLE or OBSERVABLE pass/fail check —
     a command, a test, or a concrete observation — not a prose claim someone must believe.
       - AC-1: When <trigger>, the system SHALL <response>.
         DoD: <check that returns pass/fail, e.g. `grep -c getUser src/` = 0> -->

## Boundaries

<!-- Rules the implementer MUST hold. Fed mainly by Pre-Mortem mitigations.
     Distinct from "Out of Scope": that section excludes FEATURES; this one forbids ACTIONS
     and names when to stop.
     - ALWAYS:    invariants that hold for every change.
     - ASK FIRST: situations where the implementer STOPS and escalates instead of guessing.
     - NEVER:     explicitly forbidden actions (the anti-requirements). -->

## Out of Scope

<!-- Explicitly excluded features/work. Prevents scope creep during implementation. -->
