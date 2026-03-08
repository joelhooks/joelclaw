import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildAdrRouteSlugs,
  parseAdrRouteAlias,
  resolveAdrSourceSlug,
  toAdrRouteSlug,
} from "../adr-route";

describe("adr-route helpers", () => {
  test("builds short public ADR route slugs from ADR numbers", () => {
    assert.equal(toAdrRouteSlug("0217"), "adr-0217");
    assert.equal(toAdrRouteSlug("0004"), "adr-0004");
  });

  test("parses shorthand ADR route aliases", () => {
    assert.equal(parseAdrRouteAlias("adr-0217"), "0217");
    assert.equal(parseAdrRouteAlias("0217"), "0217");
    assert.equal(parseAdrRouteAlias("0217-event-routing-queue-discipline"), null);
  });

  test("builds static params with canonical and shorthand ADR routes", () => {
    assert.deepEqual(
      buildAdrRouteSlugs([
        { slug: "0217-event-routing-queue-discipline", number: "0217" },
        { slug: "0207-restate-durable-execution-engine", number: "0207" },
      ]),
      [
        "0217-event-routing-queue-discipline",
        "adr-0217",
        "0207-restate-durable-execution-engine",
        "adr-0207",
      ],
    );
  });

  test("resolves shorthand ADR routes back to the Convex source slug", () => {
    const adrs = [
      { slug: "0217-event-routing-queue-discipline", number: "0217" },
      { slug: "0207-restate-durable-execution-engine", number: "0207" },
    ];

    assert.equal(
      resolveAdrSourceSlug("adr-0217", adrs),
      "0217-event-routing-queue-discipline",
    );
    assert.equal(
      resolveAdrSourceSlug("0207", adrs),
      "0207-restate-durable-execution-engine",
    );
    assert.equal(
      resolveAdrSourceSlug("0217-event-routing-queue-discipline", adrs),
      "0217-event-routing-queue-discipline",
    );
  });
});
