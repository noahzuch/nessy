import { describe, it, expect } from "vitest";
import { isUnderNessyDir } from "src/features/block-nessy-dir-writes/lib/guards.js";

describe("isUnderNessyDir", () => {
  it("direct child of .nessy/ returns true", () => {
    expect(isUnderNessyDir("/p/.nessy/config.yml", "/p")).toBe(true);
  });

  it("deep descendant returns true", () => {
    expect(isUnderNessyDir("/p/.nessy/cache/sid/__root__.json", "/p")).toBe(true);
  });

  it(".nessy itself returns true", () => {
    expect(isUnderNessyDir("/p/.nessy", "/p")).toBe(true);
  });

  it("sibling .nessy-old is NOT flagged", () => {
    expect(isUnderNessyDir("/p/.nessy-old/foo", "/p")).toBe(false);
  });

  it("normal src/foo.ts is NOT flagged", () => {
    expect(isUnderNessyDir("/p/src/foo.ts", "/p")).toBe(false);
  });

  it("target outside project root is NOT flagged", () => {
    expect(isUnderNessyDir("/other/file", "/p")).toBe(false);
  });

  it("relative-with-. inputs normalized — absolute paths with .. segments", () => {
    expect(isUnderNessyDir("/p/foo/../.nessy/x", "/p")).toBe(true);
  });
});
