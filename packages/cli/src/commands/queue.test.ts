import { describe, expect, it } from "bun:test";
import { queueCmd } from "./queue";

describe("Queue CLI Command", () => {
  it("wires the queue command with the expected subcommands", () => {
    expect(queueCmd).toBeDefined();
    expect(queueCmd.descriptor._tag).toBe("Subcommands");

    const subcommandNames = queueCmd.descriptor.children.map((child) => child.command.command.name);
    expect(subcommandNames).toEqual(["emit", "depth", "list", "inspect"]);
  });

  // Integration tests would require Redis and are better suited for E2E.
  // These structural tests verify the command tree is wired correctly.
});
