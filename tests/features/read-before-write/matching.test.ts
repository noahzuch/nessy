import { describe, it, expect } from "vitest";
import { matchRules, unionRequires } from "src/features/read-before-write/lib/matching.js";
import type { Rule } from "src/shared/config.js";

describe("matchRules", () => {
  // Test 1: single glob hits — src/** matches src/foo.ts
  it("returns matching rule for single glob hit", () => {
    const rule: Rule = { name: "r", match: ["src/**"], require: ["x"] };
    const result = matchRules("src/foo.ts", [rule]);
    expect(result).toEqual([rule]);
  });

  // Test 2: no-match miss — src/** does not match README.md
  it("returns empty array when no rule matches", () => {
    const rule: Rule = { name: "r", match: ["src/**"], require: ["x"] };
    const result = matchRules("README.md", [rule]);
    expect(result).toEqual([]);
  });

  // Test 3: negation honored — !src/generated/** excludes generated files
  // Note: ignore requires a non-directory glob (e.g. **/*.ts) before negation works,
  // because gitignore cannot re-include a file whose parent dir is excluded by src/**
  it("respects negation patterns to exclude paths", () => {
    const rule: Rule = { name: "r", match: ["**/*.ts", "!src/generated/**"], require: ["x"] };
    const result = matchRules("src/generated/foo.ts", [rule]);
    expect(result).toEqual([]);
  });

  // Test 4: scalar-as-1-array — single-element array still matches
  it("accepts single-element match array", () => {
    const rule: Rule = { name: "r", match: ["src/**"], require: ["x"] };
    const result = matchRules("src/foo.ts", [rule]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(rule);
  });

  // Test 5: multi-rule union — both rules match; also verify unionRequires deduplicates
  it("returns all matching rules and unionRequires deduplicates require entries", () => {
    const rule1: Rule = { name: "r1", match: ["src/**"], require: ["x", "y"] };
    const rule2: Rule = { name: "r2", match: ["src/**"], require: ["y", "z"] };
    const matched = matchRules("src/foo.ts", [rule1, rule2]);
    expect(matched).toHaveLength(2);
    const required = unionRequires(matched);
    expect(required).toHaveLength(3);
    expect(required).toContain("x");
    expect(required).toContain("y");
    expect(required).toContain("z");
  });

  // Test 6: *.md matches root files — README.md matched by *.md glob
  it("matches root-level files with *.md glob", () => {
    const rule: Rule = { name: "r", match: ["*.md"], require: ["x"] };
    const result = matchRules("README.md", [rule]);
    expect(result).toEqual([rule]);
  });

  // Test 7: backslash-to-slash normalization — Windows-style paths normalized before matching
  it("normalizes backslashes to forward slashes before matching", () => {
    const rule: Rule = { name: "r", match: ["src/**"], require: ["x"] };
    const result = matchRules("src\\foo.ts", [rule]);
    expect(result).toEqual([rule]);
  });
});
