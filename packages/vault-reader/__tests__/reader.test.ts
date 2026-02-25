import { describe, expect, test } from "vitest";
import { extractVaultIntent } from "../src";

describe("extractVaultIntent", () => {
  test("returns path kind for explicit paths", () => {
    expect(extractVaultIntent("Please read /Users/joel/Vault/docs/decisions/adr-0120.md")).toEqual({
      kind: "path",
      value: "/Users/joel/Vault/docs/decisions/adr-0120.md",
    });
  });

  test("returns adr kind for ADR references", () => {
    expect(extractVaultIntent("Can you open ADR 123?")).toEqual({
      kind: "adr",
      value: "123",
    });

    expect(extractVaultIntent("Can you open adr-123?")).toEqual({
      kind: "adr",
      value: "123",
    });
  });

  test("returns fuzzy kind for plain text", () => {
    expect(extractVaultIntent("read about project launch planning")).toEqual({
      kind: "fuzzy",
      value: "about project launch planning",
    });
  });

  test("returns null for empty input", () => {
    expect(extractVaultIntent("\n   ")).toBeNull();
  });
});
