import { afterEach, describe, expect, test } from "bun:test";
import { __discoveryCaptureTestUtils } from "./discovery-capture";

const { buildDiscoveryCapturedEventData, shouldQueueDiscoveryCaptured } = __discoveryCaptureTestUtils;
const priorQueuePilots = process.env.QUEUE_PILOTS;

afterEach(() => {
  if (priorQueuePilots === undefined) {
    delete process.env.QUEUE_PILOTS;
    return;
  }

  process.env.QUEUE_PILOTS = priorQueuePilots;
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
