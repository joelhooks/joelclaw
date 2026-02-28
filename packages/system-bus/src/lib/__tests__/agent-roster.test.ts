import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAgentDefinitionCache, loadAgentDefinition } from "../agent-roster";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

let tempRoot = "";
let projectDir = "";
let userHome = "";

function writeProjectAgent(name: string, content: string) {
  const dir = join(projectDir, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, "utf-8");
}

function writeUserAgent(name: string, content: string) {
  const dir = join(userHome, ".pi", "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, "utf-8");
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "agent-roster-"));
  projectDir = join(tempRoot, "project");
  userHome = join(tempRoot, "home");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  process.env.HOME = userHome;
  process.env.USERPROFILE = userHome;

  clearAgentDefinitionCache();
});

afterEach(() => {
  clearAgentDefinitionCache();

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  rmSync(tempRoot, { recursive: true, force: true });
});

describe("loadAgentDefinition", () => {
  test("loads from project .pi/agents directory", () => {
    writeProjectAgent(
      "designer",
      [
        "---",
        "name: designer",
        "description: Frontend design with taste",
        "model: claude-sonnet-4-6",
        "thinking: high",
        "tools: read, bash, edit, write",
        "skill: frontend-design, ui-animation",
        "extensions: local-extension",
        "---",
        "You are a design-focused agent.",
      ].join("\n"),
    );

    const definition = loadAgentDefinition("designer", projectDir);

    expect(definition).not.toBeNull();
    expect(definition).toMatchObject({
      name: "designer",
      source: "project",
      model: "claude-sonnet-4-6",
      thinking: "high",
      tools: ["read", "bash", "edit", "write"],
      skills: ["frontend-design", "ui-animation"],
      extensions: ["local-extension"],
      systemPrompt: "You are a design-focused agent.",
    });
  });

  test("loads from user ~/.pi/agent/agents directory", () => {
    writeUserAgent(
      "designer",
      [
        "---",
        "name: designer",
        "model: claude-sonnet-4-6",
        "tools:",
        "  - read",
        "  - bash",
        "---",
        "User scope agent.",
      ].join("\n"),
    );

    const definition = loadAgentDefinition("designer", projectDir);

    expect(definition).not.toBeNull();
    expect(definition?.source).toBe("user");
    expect(definition?.tools).toEqual(["read", "bash"]);
    expect(definition?.systemPrompt).toBe("User scope agent.");
  });

  test("project definition overrides user definition", () => {
    writeUserAgent(
      "designer",
      [
        "---",
        "name: designer",
        "model: user-model",
        "---",
        "From user.",
      ].join("\n"),
    );
    writeProjectAgent(
      "designer",
      [
        "---",
        "name: designer",
        "model: project-model",
        "---",
        "From project.",
      ].join("\n"),
    );

    const definition = loadAgentDefinition("designer", projectDir);

    expect(definition?.source).toBe("project");
    expect(definition?.model).toBe("project-model");
    expect(definition?.systemPrompt).toBe("From project.");
  });

  test("returns cached definition on subsequent reads", () => {
    const original = [
      "---",
      "name: designer",
      "model: first-model",
      "---",
      "Original prompt.",
    ].join("\n");
    const updated = [
      "---",
      "name: designer",
      "model: second-model",
      "---",
      "Updated prompt.",
    ].join("\n");

    writeProjectAgent("designer", original);
    const first = loadAgentDefinition("designer", projectDir);

    writeProjectAgent("designer", updated);
    const second = loadAgentDefinition("designer", projectDir);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.model).toBe("first-model");
    expect(second?.systemPrompt).toBe("Original prompt.");
  });

  test("returns null for missing agents", () => {
    expect(loadAgentDefinition("missing", projectDir)).toBeNull();
  });

  test("returns null for malformed frontmatter", () => {
    writeProjectAgent(
      "broken",
      [
        "---",
        "name: [designer",
        "model: claude-sonnet-4-6",
        "---",
        "Invalid yaml should fail.",
      ].join("\n"),
    );

    expect(loadAgentDefinition("broken", projectDir)).toBeNull();
  });
});
