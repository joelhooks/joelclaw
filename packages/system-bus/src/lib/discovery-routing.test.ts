import { describe, expect, test } from "bun:test";
import {
  buildDiscoveryFinalLink,
  discoveryPublishesToJoelclaw,
  resolveDiscoveryRouting,
} from "./discovery-routing";

describe("resolveDiscoveryRouting", () => {
  test("defaults to a public joelclaw discovery when metadata is absent", () => {
    const routing = resolveDiscoveryRouting({ slug: "example" });

    expect(routing.site).toBe("joelclaw");
    expect(routing.visibility).toBe("public");
    expect(routing.publishTargets).toEqual(["joelclaw"]);
    expect(routing.joelclawPath).toBe("/cool/example");
    expect(routing.defaultedSite).toBe(true);
    expect(routing.defaultedVisibility).toBe(true);
  });

  test("treats private as an override even when visibility says public", () => {
    const routing = resolveDiscoveryRouting({
      slug: "example",
      privateFlag: true,
      site: "joelclaw",
      visibility: "public",
    });

    expect(routing.visibility).toBe("private");
    expect(discoveryPublishesToJoelclaw(routing)).toBe(false);
    expect(routing.joelclawUrl).toBeNull();
  });

  test("keeps wizardshit-only discoveries off joelclaw", () => {
    const routing = resolveDiscoveryRouting({
      slug: "example",
      site: "wizardshit",
      visibility: "public",
    });

    expect(routing.publishTargets).toEqual(["wizardshit"]);
    expect(discoveryPublishesToJoelclaw(routing)).toBe(false);
    expect(routing.joelclawUrl).toBeNull();
  });
});

describe("buildDiscoveryFinalLink", () => {
  test("prefers the public joelclaw URL when one exists", () => {
    const routing = resolveDiscoveryRouting({ slug: "example" });

    expect(buildDiscoveryFinalLink({
      slug: "example",
      noteName: "Example Note",
      routing,
    })).toBe("https://joelclaw.com/cool/example");
  });

  test("falls back to a vault link for non-public or off-site discoveries", () => {
    const routing = resolveDiscoveryRouting({
      slug: "example",
      site: "wizardshit",
      visibility: "private",
    });

    expect(buildDiscoveryFinalLink({
      slug: "example",
      noteName: "Example Note",
      routing,
    })).toBe("vault:Resources/discoveries/Example Note.md");
  });
});
