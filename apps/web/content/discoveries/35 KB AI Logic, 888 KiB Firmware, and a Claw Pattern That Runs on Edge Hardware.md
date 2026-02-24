---
type: discovery
slug: 35-kb-ai-logic-888-kib-firmware-and-a-claw-pattern-that-runs-on-edge-hardware
source: "https://github.com/tnm/zclaw"
discovered: "2026-02-24"
tags: [repo, tool, ai, infrastructure, embedded, c, iot, edge-computing, pattern]
relevance: "This pattern is directly relevant to Joel's system as a concrete model for hardware edge nodes that can execute scheduled actions, maintain local state, and stay inside a hard resource budget when remote services are unavailable."
---

# 35 KB AI Logic, 888 KiB Firmware, and a Claw Pattern That Runs on Edge Hardware

[35 KB assistant logic](https://github.com/tnm/zclaw) inside a **<= 888 KiB all-in firmware target** is the part that changes how you think about AI infrastructure. The repo runs on [ESP32](https://www.espressif.com/en/products/socs/esp32) with [C](https://en.wikipedia.org/wiki/C_(programming_language)) on top of [ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/) and [FreeRTOS](https://www.freertos.org/), and keeps the total build under the budget after Wi-Fi, TLS/crypto, and cert overhead. That is not just a neat spec sheet, it's a discipline lesson: the stack is a systems problem, not a model problem.

The feature surface reads like a miniature operations plane. You get [Telegram](https://telegram.org) or web-relay chat, timezone-aware [scheduling](https://zclaw.dev/use-cases.html), user-defined and built-in tools, [GPIO](https://en.wikipedia.org/wiki/General-purpose_input/output) controls with bulk read support, persistent flash memory, and provider support for [Anthropic](https://www.anthropic.com/), [OpenAI](https://openai.com/), [OpenRouter](https://openrouter.ai/), and [Ollama](https://ollama.com/). It feels less like a chatbot and more like a constrained assistant service: one that acts on hardware and state instead of pretending all value is in prompts.

The scripts in the same repo (`install.sh`, `provision-dev.sh`, `flash.sh`, `web-relay.sh`, `benchmark.sh`) signal this was built for reuse, not a one-off demo. For a platform like [joelclaw](https://joelclaw.com), this is a useful reference point for an [event-driven edge node](https://en.wikipedia.org/wiki/Edge_computing) layer that keeps local scheduling and actuation close to hardware while preserving the same compositional assistant pattern.

## Key Ideas

- **Hard limits force architecture clarity**: explicit firmware accounting makes size, TLS overhead, and cert costs visible instead of hidden, which helps avoid fantasy features that only run in demos.
- **Same assistant pattern, smaller substrate**: [tool composition](https://github.com/tnm/zclaw), scheduling, and memory are shipped together in a firmware-first form factor.
- **Actionable interface parity**: [Telegram](https://telegram.org) chat and a web relay mean control paths remain familiar while the execution target is still an [ESP32](https://www.espressif.com/en/products/socs/esp32).
- **Physical world integration is first-class**: [GPIO](https://en.wikipedia.org/wiki/General-purpose_input/output) and persistent state in the same loop turn AI from an information tool into a control tool.
- **Local dev posture matters**: the bootstrap, provision, flash, monitor, and benchmark scripts compress the feedback loop you usually lose in embedded work.

## Links

- [zclaw source repository](https://github.com/tnm/zclaw)
- [zclaw documentation](https://zclaw.dev)
- [zclaw changelog](https://zclaw.dev/changelog.html)
- [zclaw architecture docs](https://zclaw.dev/architecture.html)
- [zclaw use cases](https://zclaw.dev/use-cases.html)
- [zclaw getting started docs](https://zclaw.dev/getting-started.html)
- [zclaw local dev and hacking guide](https://zclaw.dev/local-dev.html)
- [ESP-IDF documentation](https://docs.espressif.com/projects/esp-idf/en/latest/)
- [ESP32-C3 board used by the project](https://www.espressif.com/en/products/socs/esp32/esp32-c3)
- [Seeed XIAO ESP32-C3 starter board](https://www.seeedstudio.com/Seeed-XIAO-ESP32C3-p-5431.html)
- [joelclaw system events page](https://joelclaw.com/system/events)
- [joelclaw system dashboard](https://joelclaw.com/system)
