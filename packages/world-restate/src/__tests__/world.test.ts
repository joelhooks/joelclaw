import { describe, it, expect } from "bun:test";
import { RestateWorld } from "../index";

describe("RestateWorld", () => {
  it("constructor creates an instance", () => {
    const world = new RestateWorld();
    expect(world).toBeDefined();
    expect(world).toBeInstanceOf(RestateWorld);
  });

  it("runs.list returns empty array initially", () => {
    const world = new RestateWorld();
    const runs = world.runs.list();
    expect(runs).toEqual([]);
  });

  it("events.create with null runId creates a new run", () => {
    const world = new RestateWorld();
    const event = world.events.create({
      id: "evt-1",
      type: "test",
      payload: {},
      runId: null,
    });
    expect(event).toBeDefined();
    expect(event.runId).not.toBeNull();
    expect(world.runs.list()).toHaveLength(1);
  });

  it("writeToStream and readFromStream round-trip data", async () => {
    const world = new RestateWorld();
    const event = world.events.create({
      id: "evt-2",
      type: "test",
      payload: { key: "value" },
      runId: null,
    });

    const chunks: Buffer[] = [];
    const writable = {
      write: (chunk: Buffer) => chunks.push(chunk),
      end: () => {},
    };

    await world.writeToStream(writable as any);

    const readable = {
      read: (() => {
        let index = 0;
        return () => (index < chunks.length ? chunks[index++] : null);
      })(),
    };

    const restored = await RestateWorld.readFromStream(readable as any);
    expect(restored.runs.list()).toHaveLength(1);
  });
});
