import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "37aa349b89692d657d276a40e0e47a15";
const GQL_URL = `${INNGEST_URL}/v0/gql`;
const EVENT_API = `${INNGEST_URL}/e/${INNGEST_EVENT_KEY}`;
const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_S = 300;
const COMPLETED_LINGER_MS = 15_000;
const WIDGET_KEY = "inngest-monitor";

type TrackedRunStatus = "polling" | "running" | "completed" | "failed" | "cancelled" | "timeout";

interface TrackedRun {
	eventId: string;
	eventName: string;
	eventData: unknown;
	runId: string;
	functionName: string;
	status: TrackedRunStatus;
	startedAt: number;
	finishedAt: number | null;
	steps: { name: string; status: string }[];
	currentStep: string | null;
	output: string | null;
	error: string | null;
	pollTimer: ReturnType<typeof setInterval> | null;
	lingerTimer: ReturnType<typeof setTimeout> | null;
	pollInFlight: boolean;
}

interface SendEventResponse {
	ids?: string[];
	status?: number;
}

interface InngestFunction {
	id: string;
	name: string;
}

interface RunNode {
	id: string;
	status: string;
	functionID: string;
	startedAt?: string;
	endedAt?: string;
	output?: unknown;
}

interface TraceSpan {
	name?: string;
	status?: string;
	attempts?: number;
	duration?: number;
	isRoot?: boolean;
	startedAt?: string;
	endedAt?: string;
	stepOp?: string;
	stepID?: string;
	outputID?: string;
	childrenSpans?: TraceSpan[];
}

interface SpanOutputResponse {
	runTraceSpanOutputByID?: {
		data?: unknown;
		error?: {
			message?: string;
			name?: string;
			stack?: string;
		};
	};
}

interface RunQueryResponse {
	run?: RunNode;
	runTrace?: TraceSpan;
}

interface FunctionsQueryResponse {
	functions?: InngestFunction[];
}

interface InngestCompletionMessage {
	runId: string;
	eventName: string;
	functionName: string;
	status: TrackedRunStatus;
	elapsedMs: number;
	steps: { name: string; status: string }[];
	output: string | null;
	error: string | null;
}

const InngestSendParams = Type.Object({
	event: Type.String({ description: 'Event name, e.g. "video/download"' }),
	data: Type.Optional(Type.String({ description: "JSON payload string. Defaults to {}" })),
	follow: Type.Optional(Type.Boolean({ description: "Follow run lifecycle. Defaults to true" })),
	timeout: Type.Optional(Type.Number({ description: "Follow timeout in seconds. Defaults to 300" })),
});

const InngestRunsParams = Type.Object({
	run_id: Type.Optional(Type.String({ description: "Specific run ID for detailed view" })),
});

const TERMINAL_STATUSES = new Set<TrackedRunStatus>(["completed", "failed", "cancelled", "timeout"]);

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function statusIcon(status: TrackedRunStatus): string {
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
		case "timeout":
			return "✗";
		case "cancelled":
			return "◌";
		case "running":
		case "polling":
		default:
			return "◆";
	}
}

function statusFromRun(apiStatus: string): TrackedRunStatus {
	switch (apiStatus) {
		case "COMPLETED":
			return "completed";
		case "FAILED":
			return "failed";
		case "CANCELLED":
			return "cancelled";
		case "RUNNING":
			return "running";
		case "QUEUED":
		default:
			return "polling";
	}
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	return `${totalSeconds}s`;
}

function flattenSpans(root: TraceSpan | undefined): TraceSpan[] {
	if (!root) return [];
	const out: TraceSpan[] = [];
	const visit = (span: TraceSpan) => {
		if (!span.isRoot) out.push(span);
		for (const child of span.childrenSpans ?? []) visit(child);
	};
	for (const child of root.childrenSpans ?? []) visit(child);
	return out;
}

function summarizeError(error: string | null): string | null {
	if (!error) return null;
	const compact = error.replace(/\s+/g, " ").trim();
	return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

export default function inngestMonitorExtension(pi: ExtensionAPI) {
	const trackedRuns = new Map<string, TrackedRun>();
	const functionNameMap = new Map<string, string>();
	let functionMapReady = false;
	let lastCtx: ExtensionContext | undefined;
	let widgetTui: { requestRender(): void } | null = null;
	let widgetTheme: any = null;

	const activePollingCount = (): number => {
		let count = 0;
		for (const run of trackedRuns.values()) {
			if (run.pollTimer) count++;
		}
		return count;
	};

	const clearRunPolling = (run: TrackedRun) => {
		if (run.pollTimer) {
			clearInterval(run.pollTimer);
			run.pollTimer = null;
		}
		run.pollInFlight = false;
	};

	const maybePruneRuns = () => {
		const now = Date.now();
		for (const [runId, run] of trackedRuns.entries()) {
			if (!TERMINAL_STATUSES.has(run.status)) continue;
			if (!run.finishedAt) continue;
			if (now - run.finishedAt <= COMPLETED_LINGER_MS) continue;
			if (run.lingerTimer) {
				clearTimeout(run.lingerTimer);
				run.lingerTimer = null;
			}
			trackedRuns.delete(runId);
		}
	};

	const visibleRuns = (): TrackedRun[] => {
		maybePruneRuns();
		const now = Date.now();
		return [...trackedRuns.values()]
			.filter((run) => {
				if (!TERMINAL_STATUSES.has(run.status)) return true;
				return run.finishedAt ? now - run.finishedAt <= COMPLETED_LINGER_MS : false;
			})
			.sort((a, b) => a.startedAt - b.startedAt);
	};

	const refreshWidget = () => {
		widgetTui?.requestRender();
	};

	const renderWidget = (theme: any): string[] => {
		const runs = visibleRuns();
		if (runs.length === 0) return [];
		const now = Date.now();
		return runs.map((run) => {
			const end = run.finishedAt ?? now;
			const elapsed = formatElapsed(end - run.startedAt);
			const icon =
				run.status === "completed" ? theme.fg("success", "✓")
				: run.status === "failed" || run.status === "timeout" ? theme.fg("error", "✗")
				: run.status === "cancelled" ? theme.fg("warning", "◌")
				: theme.fg("warning", "◆");
			if (run.status === "running" || run.status === "polling") {
				const step = run.currentStep ? `step: ${run.currentStep}` : "";
				return `${icon} ${theme.fg("text", run.functionName)} ${theme.fg("dim", elapsed)} ${theme.fg("muted", step)}`;
			}
			if (run.status === "completed") {
				return `${icon} ${theme.fg("text", run.functionName)} ${theme.fg("dim", elapsed + " · " + run.steps.length + " steps")}`;
			}
			if (run.status === "cancelled") {
				return `${icon} ${theme.fg("text", run.functionName)} ${theme.fg("dim", elapsed)} ${theme.fg("warning", "cancelled")}`;
			}
			const errSnippet = summarizeError(run.error) ?? "Unknown error";
			return `${icon} ${theme.fg("text", run.functionName)} ${theme.fg("dim", elapsed)} ${theme.fg("error", errSnippet)}`;
		});
	};

	const sendCompletionMessage = (run: TrackedRun) => {
		const elapsedMs = (run.finishedAt ?? Date.now()) - run.startedAt;
		const details: InngestCompletionMessage = {
			runId: run.runId,
			eventName: run.eventName,
			functionName: run.functionName,
			status: run.status,
			elapsedMs,
			steps: run.steps,
			output: run.output,
			error: run.error,
		};
		const isError = run.status === "failed" || run.status === "timeout";
		const shouldTriggerTurn = isError || activePollingCount() === 0;
		const text = `${statusIcon(run.status)} ${run.functionName} ${run.status} in ${formatElapsed(elapsedMs)}`;
		pi.sendMessage(
			{
				customType: "inngest-run-complete",
				content: text,
				display: false,
				details,
			},
			{ triggerTurn: shouldTriggerTurn, deliverAs: "followUp" },
		);
	};

	const gql = async <T>(query: string): Promise<T> => {
		const response = await fetch(GQL_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query }),
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Inngest GQL ${response.status}: ${body}`);
		}
		const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
		if (payload.errors && payload.errors.length > 0) {
			const first = payload.errors[0]?.message ?? "Unknown GraphQL error";
			throw new Error(first);
		}
		if (!payload.data) throw new Error("Inngest GQL response missing data");
		return payload.data;
	};

	const fetchFunctionNames = async (force = false) => {
		if (functionMapReady && !force) return;
		const data = await gql<FunctionsQueryResponse>("{ functions { id name } }");
		for (const fn of data.functions ?? []) {
			if (fn.id && fn.name) functionNameMap.set(fn.id, fn.name);
		}
		functionMapReady = true;
	};

	const functionNameFor = async (functionID: string): Promise<string> => {
		if (!functionMapReady) await fetchFunctionNames();
		let name = functionNameMap.get(functionID);
		if (!name) {
			await fetchFunctionNames(true);
			name = functionNameMap.get(functionID);
		}
		return name ?? functionID;
	};

	const fetchSpanError = async (outputID: string): Promise<string | null> => {
		const escaped = outputID.replaceAll('"', '\\"');
		const data = await gql<SpanOutputResponse>(
			`{ runTraceSpanOutputByID(outputID: "${escaped}") { data error { message name stack } } }`,
		);
		const error = data.runTraceSpanOutputByID?.error;
		if (error?.message) return error.message;
		const nested = data.runTraceSpanOutputByID?.data;
		if (typeof nested === "string") return nested;
		return null;
	};

	const markRunTerminal = (run: TrackedRun, status: TrackedRunStatus) => {
		run.status = status;
		run.finishedAt = Date.now();
		clearRunPolling(run);
		if (run.lingerTimer) clearTimeout(run.lingerTimer);
		run.lingerTimer = setTimeout(() => {
			run.lingerTimer = null;
			refreshWidget();
		}, COMPLETED_LINGER_MS);
	};

	const pollRun = async (run: TrackedRun, timeoutSeconds: number, ctx: ExtensionContext) => {
		if (run.pollInFlight || TERMINAL_STATUSES.has(run.status)) return;
		run.pollInFlight = true;
		try {
			if (Date.now() - run.startedAt > timeoutSeconds * 1000) {
				run.error = `Timed out after ${timeoutSeconds}s`;
				markRunTerminal(run, "timeout");
				refreshWidget();
				sendCompletionMessage(run);
				return;
			}

			const escapedRunId = run.runId.replaceAll('"', '\\"');
			const data = await gql<RunQueryResponse>(
				`{ run(runID: "${escapedRunId}") { id status functionID startedAt endedAt output } runTrace(runID: "${escapedRunId}") { name status attempts duration isRoot startedAt endedAt stepOp stepID outputID childrenSpans { name status attempts duration isRoot startedAt endedAt stepOp stepID outputID childrenSpans { name status attempts duration isRoot startedAt endedAt stepOp stepID outputID childrenSpans { name status attempts duration isRoot startedAt endedAt stepOp stepID outputID } } } } }`,
			);

			if (!data.run) {
				run.error = "Run not found";
				markRunTerminal(run, "failed");
				refreshWidget();
				sendCompletionMessage(run);
				return;
			}

			run.status = statusFromRun(data.run.status);
			run.output = data.run.output === undefined ? null : safeStringify(data.run.output);
			run.functionName = await functionNameFor(data.run.functionID);

			const spans = flattenSpans(data.runTrace);
			run.steps = spans.map((span) => ({ name: span.name ?? span.stepID ?? "(step)", status: span.status ?? "UNKNOWN" }));
			const activeStep = spans.find((span) => {
				const s = span.status ?? "";
				return s === "RUNNING" || s === "QUEUED";
			});
			run.currentStep = activeStep?.name ?? activeStep?.stepID ?? null;

			if (run.status === "failed") {
				const failedSpan = [...spans].reverse().find((span) => span.status === "FAILED" && span.outputID);
				if (failedSpan?.outputID) {
					try {
						run.error = await fetchSpanError(failedSpan.outputID);
					} catch {
						run.error = null;
					}
				}
				if (!run.error && run.output) run.error = run.output;
			}

			if (TERMINAL_STATUSES.has(run.status)) {
				markRunTerminal(run, run.status);
				sendCompletionMessage(run);
			}

			refreshWidget();
		} catch (error) {
			run.error = error instanceof Error ? error.message : String(error);
			markRunTerminal(run, "failed");
			refreshWidget();
			sendCompletionMessage(run);
		} finally {
			run.pollInFlight = false;
		}
	};

	const beginPolling = (run: TrackedRun, timeoutSeconds: number, ctx: ExtensionContext) => {
		run.pollTimer = setInterval(() => {
			void pollRun(run, timeoutSeconds, ctx);
		}, POLL_INTERVAL_MS);
		void pollRun(run, timeoutSeconds, ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				widgetTui = tui;
				widgetTheme = theme;
				return {
					render: () => renderWidget(theme),
					invalidate: () => {},
					dispose: () => {
						widgetTui = null;
						widgetTheme = null;
					},
				};
			});
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("session_shutdown", async () => {
		for (const run of trackedRuns.values()) {
			clearRunPolling(run);
			if (run.lingerTimer) {
				clearTimeout(run.lingerTimer);
				run.lingerTimer = null;
			}
		}
		trackedRuns.clear();
	});

	pi.registerTool({
		name: "inngest_send",
		label: "Inngest Send",
		description: "Send an Inngest event and optionally monitor created runs.",
		parameters: InngestSendParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const follow = params.follow ?? true;
			const timeoutSeconds = Math.max(1, Math.floor(params.timeout ?? DEFAULT_TIMEOUT_S));
			let parsedData: unknown = {};
			if (params.data) {
				try {
					parsedData = JSON.parse(params.data);
				} catch (error) {
					return {
						content: [{ type: "text", text: `Invalid JSON in data: ${error instanceof Error ? error.message : String(error)}` }],
						details: { ok: false, event: params.event, error: "invalid_json" },
					};
				}
			}

			const response = await fetch(EVENT_API, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: params.event, data: parsedData }),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Inngest event API ${response.status}: ${body}`);
			}

			const payload = (await response.json()) as SendEventResponse;
			const ids = payload.ids ?? [];
			const createdRuns: Array<Pick<TrackedRun, "runId" | "functionName" | "status">> = [];

			for (const runId of ids) {
				const run: TrackedRun = {
					eventId: runId,
					eventName: params.event,
					eventData: parsedData,
					runId,
					functionName: "(resolving)",
					status: "polling",
					startedAt: Date.now(),
					finishedAt: null,
					steps: [],
					currentStep: null,
					output: null,
					error: null,
					pollTimer: null,
					lingerTimer: null,
					pollInFlight: false,
				};
				trackedRuns.set(runId, run);
				createdRuns.push({ runId, functionName: run.functionName, status: run.status });
				if (follow) beginPolling(run, timeoutSeconds, ctx);
			}

			refreshWidget();

			const content =
				ids.length > 0
					? `Sent ${params.event} (${ids.length} run${ids.length === 1 ? "" : "s"})`
					: `Sent ${params.event} (no runs returned)`;

			return {
				content: [{ type: "text", text: content }],
				details: {
					ok: true,
					event: params.event,
					follow,
					timeoutSeconds,
					runIds: ids,
					runs: createdRuns,
				},
			};
		},
		renderCall(args, theme) {
			const data = args.data ? ` ${theme.fg("dim", args.data)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("inngest_send "))}${theme.fg("muted", args.event)}${data}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as
				| { ok?: boolean; event?: string; runIds?: string[]; runs?: Array<{ runId: string; functionName: string; status: string }> }
				| undefined;
			if (!details?.ok) {
				const text = result.content[0];
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "inngest_send failed"), 0, 0);
			}
			const firstRun = details.runs?.[0];
			if (!firstRun) return new Text(theme.fg("muted", `◆ ${details.event ?? "event"} queued`), 0, 0);
			return new Text(theme.fg("muted", `◆ ${firstRun.functionName} running · ${firstRun.runId}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "inngest_runs",
		label: "Inngest Runs",
		description: "Show tracked Inngest runs or details for a specific run.",
		parameters: InngestRunsParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<{ run?: TrackedRun; runs?: TrackedRun[] }>> {
			if (params.run_id) {
				const run = trackedRuns.get(params.run_id);
				if (!run) {
					return {
						content: [{ type: "text", text: `Run not tracked: ${params.run_id}` }],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: `${run.functionName} ${run.status}` }],
					details: { run },
				};
			}
			const runs = [...trackedRuns.values()].sort((a, b) => b.startedAt - a.startedAt);
			return {
				content: [{ type: "text", text: `${runs.length} tracked run${runs.length === 1 ? "" : "s"}` }],
				details: { runs },
			};
		},
		renderCall(args, theme) {
			const suffix = args.run_id ? ` ${theme.fg("muted", args.run_id)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("inngest_runs"))}${suffix}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { run?: TrackedRun; runs?: TrackedRun[] } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const runs = details.run ? [details.run] : (details.runs ?? []);
			if (runs.length === 0) return new Text(theme.fg("dim", "No tracked runs"), 0, 0);

			const lines: string[] = [];
			for (const run of runs.slice(0, expanded ? runs.length : 5)) {
				const elapsed = formatElapsed((run.finishedAt ?? Date.now()) - run.startedAt);
				lines.push(`${statusIcon(run.status)} ${run.functionName} ${run.status} · ${elapsed} · ${run.runId}`);
				if (expanded) {
					for (const step of run.steps) {
						lines.push(`  - ${step.status}: ${step.name}`);
					}
					if (run.error) lines.push(`  - error: ${summarizeError(run.error)}`);
				}
			}
			if (!expanded && runs.length > 5) lines.push(theme.fg("dim", `... ${runs.length - 5} more`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerMessageRenderer<InngestCompletionMessage>("inngest-run-complete", (message, { expanded }, theme) => {
		const details = message.details;
		if (!details) {
			const content = typeof message.content === "string" ? message.content : "Inngest run update";
			return new Text(content, 0, 0);
		}
		const icon = statusIcon(details.status);
		const statusColor = details.status === "completed" ? "success" : details.status === "cancelled" ? "warning" : "error";
		const root = new Container();
		root.addChild(
			new Text(
				`${theme.fg(statusColor, icon)} ${theme.fg("accent", details.functionName)} ${theme.fg("muted", details.status)} ${theme.fg("dim", formatElapsed(details.elapsedMs))}`,
				0,
				0,
			),
		);
		if (expanded) {
			root.addChild(new Spacer(1));
			root.addChild(new Text(theme.fg("muted", `run: ${details.runId}`), 0, 0));
			root.addChild(new Text(theme.fg("muted", `event: ${details.eventName}`), 0, 0));
			for (const step of details.steps) {
				root.addChild(new Text(theme.fg("dim", `- ${step.status}: ${step.name}`), 0, 0));
			}
			if (details.error) root.addChild(new Text(theme.fg("error", `error: ${details.error}`), 0, 0));
			if (details.output) root.addChild(new Text(theme.fg("dim", `output: ${details.output}`), 0, 0));
		}
		return root;
	});
}
