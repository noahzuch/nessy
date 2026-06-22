import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "src/lib/config.js";

describe("parseConfig", () => {
  // Test 1: minimal valid config with empty rules
  it("accepts minimal config with empty rules", () => {
    const cfg = parseConfig(`version: 1\nrules: []\n`);
    expect(cfg.version).toBe(1);
    expect(cfg.hints).toBe(true);
    expect(cfg.log_level).toBe("info");
    expect(cfg.rules).toEqual([]);
  });

  // Test 2: defaults applied when omitted, even with rules present
  it("applies defaults for hints and log_level when omitted", () => {
    const cfg = parseConfig(`
version: 1
rules:
  - name: r1
    match: "src/**"
    require:
      - read_file
`);
    expect(cfg.hints).toBe(true);
    expect(cfg.log_level).toBe("info");
  });

  // Test 3: scalar match normalized to array
  it("normalizes scalar match to array", () => {
    const cfg = parseConfig(`
version: 1
rules:
  - name: r1
    match: "src/**"
    require:
      - read_file
`);
    expect(cfg.rules[0].match).toEqual(["src/**"]);
  });

  // Test 4: array match accepted as-is
  it("accepts array match as-is", () => {
    const cfg = parseConfig(`
version: 1
rules:
  - name: r1
    match:
      - "a"
      - "b"
    require:
      - read_file
`);
    expect(cfg.rules[0].match).toEqual(["a", "b"]);
  });

  // Test 5: malformed YAML → ConfigError mentioning "YAML parse error"
  it("throws ConfigError for malformed YAML", () => {
    const badYaml = `version: 1\n  bad indent:\n - broken: [`;
    expect(() => parseConfig(badYaml)).toThrow(ConfigError);
    expect(() => parseConfig(badYaml)).toThrow(/YAML parse error/i);
  });

  // Test 5b: malformed YAML with filePath → error includes "(in <path>)"
  it("includes file path in YAML parse error when provided", () => {
    const badYaml = `version: 1\n  bad indent:\n - broken: [`;
    expect(() => parseConfig(badYaml, "/some/config.yml")).toThrow(/in \/some\/config\.yml/);
  });

  // Test 6: missing version → throws with "version" in message
  it("throws when version is missing", () => {
    expect(() => parseConfig(`rules: []\n`)).toThrow(/version/i);
  });

  // Test 7: unknown version: 2 → throws (Zod literal mismatch)
  it("throws for unknown version: 2", () => {
    expect(() => parseConfig(`version: 2\nrules: []\n`)).toThrow(/version/i);
  });

  // Test 8: non-boolean hints → throws with "hints" in message
  it("throws for non-boolean hints", () => {
    expect(() => parseConfig(`version: 1\nhints: "yes"\nrules: []\n`)).toThrow(/hints/i);
  });

  // Test 9: invalid log_level → throws with "log_level" in message
  it("throws for invalid log_level", () => {
    expect(() => parseConfig(`version: 1\nlog_level: verbose\nrules: []\n`)).toThrow(/log_level/i);
  });

  // Test 10: missing rule name → throws with "name" in message
  it("throws when rule name is missing", () => {
    const yaml = `
version: 1
rules:
  - match: "src/**"
    require:
      - read_file
`;
    expect(() => parseConfig(yaml)).toThrow(/name/i);
  });

  // Test 11: duplicate rule names → throws with /duplicate.*r1/i
  it("throws for duplicate rule names", () => {
    const yaml = `
version: 1
rules:
  - name: r1
    match: "src/**"
    require:
      - read_file
  - name: r1
    match: "lib/**"
    require:
      - read_file
`;
    expect(() => parseConfig(yaml)).toThrow(/duplicate.*r1/i);
  });

  // Test 12: empty require: [] → throws with "require" in message
  it("throws for empty require array", () => {
    const yaml = `
version: 1
rules:
  - name: r1
    match: "src/**"
    require: []
`;
    expect(() => parseConfig(yaml)).toThrow(/require/i);
  });

  // Test 13: file path included in error when validation fails
  it("includes file path in validation error when provided", () => {
    expect(() => parseConfig(`rules: []\n`, "/some/path.yml")).toThrow(/\/some\/path\.yml/);
  });
});
