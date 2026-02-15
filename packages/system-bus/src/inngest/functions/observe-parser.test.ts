import { describe, expect, test } from "bun:test";
import {
  formatSegmentsForLog,
  optimizeForContext,
  parseObserverOutput,
  parseSegments,
} from "./observe-parser";

describe("parseSegments", () => {
  test("Segment XML: extracts narrative and fact bullets into DistilledSegment[]", () => {
    const input = `
<segment>
  <narrative>
    Segment one narrative
  </narrative>
  <facts>
    - 🔴 P0 issue found
    - 🟡 follow up item
  </facts>
</segment>
<segment>
  <narrative>Segment two narrative</narrative>
  <facts>
    * 🔴 second red flag
    • plain fact
  </facts>
</segment>
`;

    expect(parseSegments(input)).toEqual([
      {
        narrative: "Segment one narrative",
        facts: ["🔴 P0 issue found", "🟡 follow up item"],
      },
      {
        narrative: "Segment two narrative",
        facts: ["🔴 second red flag", "plain fact"],
      },
    ]);
  });

  test("No segment tags: returns empty array", () => {
    const input = `
<narrative>Standalone narrative</narrative>
<facts>
- 🔴 Not inside segment
</facts>
`;

    expect(parseSegments(input)).toEqual([]);
  });
});

describe("parseObserverOutput", () => {
  test("Segment format in observations: populates segments array", () => {
    const input = `
<observations>
<segment>
  <narrative>Queue latency increased</narrative>
  <facts>
    - 🔴 Worker A stalled
    - 🟡 retry trend rising
  </facts>
</segment>
</observations>
<current-task>Investigate queue worker</current-task>
<suggested-response>Checking worker logs now.</suggested-response>
`;

    expect(parseObserverOutput(input)).toEqual({
      observations: `<segment>
  <narrative>Queue latency increased</narrative>
  <facts>
    - 🔴 Worker A stalled
    - 🟡 retry trend rising
  </facts>
</segment>`,
      segments: [
        {
          narrative: "Queue latency increased",
          facts: ["🔴 Worker A stalled", "🟡 retry trend rising"],
        },
      ],
      currentTask: "Investigate queue worker",
      suggestedResponse: "Checking worker logs now.",
      parsed: true,
    });
  });

  test("XML extraction: all three tags are extracted and trimmed", () => {
    const input = `
<observations>
  🔴 Primary issue detected
  🟡 Secondary signal
</observations>
<current-task>
  Stabilize queue processing
</current-task>
<suggested-response>
  I identified the bottleneck and will apply the fix next.
</suggested-response>
`;

    expect(parseObserverOutput(input)).toEqual({
      observations: "🔴 Primary issue detected\n  🟡 Secondary signal",
      segments: [],
      currentTask: "Stabilize queue processing",
      suggestedResponse: "I identified the bottleneck and will apply the fix next.",
      parsed: true,
    });
  });

  test("Partial XML: observations-only input sets optional fields to null", () => {
    const input = "<observations>  🔴 Only observations present  </observations>";

    expect(parseObserverOutput(input)).toEqual({
      observations: "🔴 Only observations present",
      segments: [],
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    });
  });

  test("Fallback: no XML but emoji marker lines returns parsed=true with raw observations", () => {
    const input = [
      "Date: 2026-02-15",
      "🔴 Critical blocker remains",
      "🟡 Follow-up needed",
      "🟢 Informational note",
    ].join("\n");

    expect(parseObserverOutput(input)).toEqual({
      observations: input,
      segments: [],
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    });
  });

  test("Malformed text: no XML and no markers returns parsed=false with raw observations", () => {
    const input = "unstructured status update without parser signals";

    expect(parseObserverOutput(input)).toEqual({
      observations: input,
      segments: [],
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    });
  });

  test("Empty input: returns empty observations and parsed=false", () => {
    expect(parseObserverOutput("")).toEqual({
      observations: "",
      segments: [],
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    });
  });

  test("Flat observations format remains backward compatible with empty segments", () => {
    const input = [
      "<observations>",
      "Date: 2026-02-15",
      "🔴 Critical blocker remains",
      "🟡 Follow-up needed",
      "</observations>",
    ].join("\n");

    expect(parseObserverOutput(input)).toEqual({
      observations: ["Date: 2026-02-15", "🔴 Critical blocker remains", "🟡 Follow-up needed"].join(
        "\n"
      ),
      segments: [],
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    });
  });
});

describe("optimizeForContext", () => {
  test("Segment format: keeps narratives and only 🔴 facts", () => {
    const input = `
<segment>
  <narrative>Segment A summary</narrative>
  <facts>
    - 🔴 Incident remains unresolved
    - 🟡 Monitor again tomorrow
  </facts>
</segment>
<segment>
  <narrative>Segment B summary</narrative>
  <facts>
    - 🟢 Cleanup complete
    - 🔴 Escalation required
  </facts>
</segment>
`;

    expect(optimizeForContext(input)).toBe(
      ["Segment A summary", "🔴 Incident remains unresolved", "Segment B summary", "🔴 Escalation required"].join(
        "\n"
      )
    );
  });

  test("Mixed priorities: keeps only 🔴 and Date: lines", () => {
    const input = [
      "Date: 2026-02-14",
      "🔴 Fix failing worker heartbeat",
      "plain note that should be removed",
      "🟡 Watch queue depth trend",
      "🟢 Cleanup completed",
      "Date: 2026-02-15",
      "🔴 Escalate stuck deployment",
    ].join("\n");

    expect(optimizeForContext(input)).toBe(
      [
        "Date: 2026-02-14",
        "🔴 Fix failing worker heartbeat",
        "Date: 2026-02-15",
        "🔴 Escalate stuck deployment",
      ].join("\n")
    );
  });

  test("Empty input: returns empty string", () => {
    expect(optimizeForContext("")).toBe("");
  });
});

describe("formatSegmentsForLog", () => {
  test("Formats segments as markdown with italic narratives and bullet facts", () => {
    expect(
      formatSegmentsForLog([
        {
          narrative: "First segment story",
          facts: ["🔴 Primary blocker", "🟡 Secondary signal"],
        },
        {
          narrative: "Second segment story",
          facts: ["🔴 Another blocker"],
        },
      ])
    ).toBe(
      [
        "*First segment story*",
        "- 🔴 Primary blocker",
        "- 🟡 Secondary signal",
        "",
        "*Second segment story*",
        "- 🔴 Another blocker",
      ].join("\n")
    );
  });

  test("Empty segments: returns empty string", () => {
    expect(formatSegmentsForLog([])).toBe("");
  });
});
