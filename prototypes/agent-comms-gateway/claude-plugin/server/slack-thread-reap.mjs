#!/usr/bin/env bun
import { createSlackThreadTools } from "./slack-thread-tools.mjs";

const tools = createSlackThreadTools();
const recovered = [];
for (const session of await tools.active()) {
  if (session.currentTurn?.state !== "launched" || !session.paneId) continue;
  const status = await tools.status({
    channelId: session.channelId,
    threadTs: session.threadTs,
  });
  const agentStatus = status?.pane?.result?.pane?.agent_status;
  if (!new Set(["idle", "done", "blocked"]).has(agentStatus)) continue;
  const result = await tools.read({
    channelId: session.channelId,
    threadTs: session.threadTs,
    sourceEventId: session.currentTurn.sourceEventId,
  });
  recovered.push(result.resultEventId);
}
const result = await tools.reap();
process.stdout.write(`${JSON.stringify({ ...result, recovered })}\n`);
