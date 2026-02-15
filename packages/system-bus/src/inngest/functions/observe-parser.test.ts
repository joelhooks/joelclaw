import { describe, expect, test } from "bun:test";
import { optimizeForContext, parseObserverOutput } from "./observe-parser";

describe("parseObserverOutput", () => {
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
      currentTask: "Stabilize queue processing",
      suggestedResponse: "I identified the bottleneck and will apply the fix next.",
      parsed: true,
    });
  });

  test("Partial XML: observations-only input sets optional fields to null", () => {
    const input = "<observations>  🔴 Only observations present  </observations>";

    expect(parseObserverOutput(input)).toEqual({
      observations: "🔴 Only observations present",
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
      currentTask: null,
      suggestedResponse: null,
      parsed: true,
    });
  });

  test("Malformed text: no XML and no markers returns parsed=false with raw observations", () => {
    const input = "unstructured status update without parser signals";

    expect(parseObserverOutput(input)).toEqual({
      observations: input,
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    });
  });

  test("Empty input: returns empty observations and parsed=false", () => {
    expect(parseObserverOutput("")).toEqual({
      observations: "",
      currentTask: null,
      suggestedResponse: null,
      parsed: false,
    });
  });
});

describe("optimizeForContext", () => {
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
