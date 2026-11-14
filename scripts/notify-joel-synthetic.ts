import { notifyJoel } from "../packages/system-bus/src/lib/notify-joel";

// Operator-only proof: this script sends exactly one real notification. Do not retry blindly.
await notifyJoel({
  kind: "needs_joel",
  source: "capture-delivery-synthetic",
  message:
    "[TEST] synthetic backup escalation from capture delivery check: proving the live channel, no action needed",
});
console.log("Synthetic notification accepted by the live channel");
