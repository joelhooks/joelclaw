import { afterEach, describe, expect, test } from "bun:test";
import { __discoveryCaptureTestUtils } from "./discovery-capture";

const { buildDiscoveryCapturedEventData, buildFallbackDiscoveryNote, discoveryGenerateTimeoutMs, shouldQueueDiscoveryCaptured } = __discoveryCaptureTestUtils;
const priorQueuePilots = process.env.QUEUE_PILOTS;

afterEach(() => {
  if (priorQueuePilots === undefined) {
    delete process.env.QUEUE_PILOTS;
    return;
  }

  process.env.QUEUE_PILOTS = priorQueuePilots;
});

describe("discovery capture generation helpers", () => {
  test("uses a five-minute generation budget before falling back", () => {
    expect(discoveryGenerateTimeoutMs).toBe(300_000);
  });

  test("builds a source-grounded fallback note when model generation degrades", () => {
    const note = buildFallbackDiscoveryNote({
      url: "https://www.evennia.com",
      context: "Joel flagged this as an interesting substrate for agents.",
      sourceType: "article",
      sourceContent: "Evennia is an open-source Python MUD/MU* creation system.",
      today: "2026-06-01",
      site: "joelclaw",
      visibility: "public",
      captureId: "evt-1",
    });
    const repeated = buildFallbackDiscoveryNote({
      url: "https://www.evennia.com",
      context: "Joel flagged this as an interesting substrate for agents.",
      sourceType: "article",
      sourceContent: "Evennia is an open-source Python MUD/MU* creation system.",
      today: "2026-06-01",
      site: "joelclaw",
      visibility: "public",
      captureId: "evt-2",
    });

    expect(note.noteName).toMatch(/^Evennia [a-f0-9]{8}$/);
    expect(note.slug).toMatch(/^evennia-[a-f0-9]{8}$/);
    expect(note.markdown).toContain("captureStatus: degraded");
    expect(note.markdown).toContain("Joel flagged this as an interesting substrate for agents.");
    expect(note.markdown).toContain("[Evennia](https://www.evennia.com)");
    expect(repeated.noteName).not.toBe(note.noteName);
  });
});

describe("discovery capture queue pilot helpers", () => {
  test("queues discovery/captured when the dedicated pilot is enabled", () => {
    process.env.QUEUE_PILOTS = "github,discovery-captured";

    expect(shouldQueueDiscoveryCaptured()).toBe(true);
  });

  test("does not queue discovery/captured when the pilot is disabled", () => {
    process.env.QUEUE_PILOTS = "github,discovery";

    expect(shouldQueueDiscoveryCaptured()).toBe(false);
  });

  test("builds discovery/captured payload with trimmed optional metadata", () => {
    expect(
      buildDiscoveryCapturedEventData({
        vaultPath: "/tmp/discovery.md",
        topic: "Example",
        slug: "example",
        site: " joelclaw ",
        visibility: " public ",
        finalLink: " https://joelclaw.com/cool/example ",
        url: " https://example.com ",
        title: " Example Title ",
        captureStatus: "degraded",
        degradedReason: " model timed out ",
      }),
    ).toEqual({
      vaultPath: "/tmp/discovery.md",
      topic: "Example",
      slug: "example",
      site: "joelclaw",
      visibility: "public",
      finalLink: "https://joelclaw.com/cool/example",
      url: "https://example.com",
      title: "Example Title",
      captureStatus: "degraded",
      degradedReason: "model timed out",
    });
  });

  test("omits blank optional metadata from discovery/captured payload", () => {
    expect(
      buildDiscoveryCapturedEventData({
        vaultPath: "/tmp/discovery.md",
        topic: "Example",
        slug: "example",
        site: "joelclaw",
        visibility: "public",
        finalLink: "https://joelclaw.com/cool/example",
        url: "  ",
        title: "",
      }),
    ).toEqual({
      vaultPath: "/tmp/discovery.md",
      topic: "Example",
      slug: "example",
      site: "joelclaw",
      visibility: "public",
      finalLink: "https://joelclaw.com/cool/example",
    });
  });
});
