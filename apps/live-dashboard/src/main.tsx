import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../convex/_generated/api";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!convexUrl) throw new Error("VITE_CONVEX_URL is required");
const client = new ConvexReactClient(convexUrl);

type Tier = "private" | "guest" | "public" | "synthetic";
type Session = {
  _id: string; room: string; tier: Tier; callerHash: string; startedAt: number; endedAt?: number;
  hangupReason?: string; lastHeartbeat: number; turnCount: number; transcriptTail: string[];
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function ActiveCall({ session, now }: { session: Session; now: number }) {
  return <article className="active-call">
    <span className="live-dot" />
    <div><strong>{session.room}</strong><span className={`tier ${session.tier}`}>{session.tier}</span></div>
    <output>{duration(now - session.startedAt)}</output>
    <small>{session.turnCount} turns · caller {session.callerHash}</small>
  </article>;
}

function SessionCard({ session }: { session: Session }) {
  const [expanded, setExpanded] = useState(false);
  const detail = useQuery(api.calls.sessionDetail, expanded ? { room: session.room } : "skip");
  const stats = useMemo(() => {
    const turns = detail?.turns ?? [];
    const average = (key: "eouDelayMs" | "llmTtftMs" | "ttsTtfbMs") => {
      const values = turns.flatMap((turn) => typeof turn[key] === "number" ? [turn[key]] : []);
      return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    };
    return { eou: average("eouDelayMs"), llm: average("llmTtftMs"), tts: average("ttsTtfbMs") };
  }, [detail]);
  const endedAt = session.endedAt ?? session.lastHeartbeat;
  return <article className="session-card">
    <button type="button" className="card-heading" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span><strong>{session.room}</strong><span className={`tier ${session.tier}`}>{session.tier}</span></span>
      <span className="summary">{duration(endedAt - session.startedAt)} · {session.turnCount} turns <b>{expanded ? "−" : "+"}</b></span>
    </button>
    {expanded ? <div className="details">
      <div className="metrics">
        <Metric label="EOU delay" value={stats.eou} />
        <Metric label="LLM TTFT" value={stats.llm} />
        <Metric label="TTS TTFB" value={stats.tts} />
      </div>
      {detail?.analysis ? <div className="analysis">
        <span>quality</span>
        {detail.analysis.scores
          ? <>
              <strong>
                {detail.analysis.scores.mean !== undefined
                  ? `${detail.analysis.scores.mean}/5 · ${detail.analysis.scores.label ?? "judged"}`
                  : `${detail.analysis.scores.coherence}/5 coherence · ${detail.analysis.scores.warmth}/5 warmth`}
              </strong>
              {detail.analysis.scores.dimensions?.length
                ? <>
                    <p>{detail.analysis.scores.dimensions.map((dimension) => `${dimension.key}: ${dimension.score ?? "N/O"}`).join(" · ")}</p>
                    <details>
                      <summary>score receipts</summary>
                      {detail.analysis.scores.dimensions.map((dimension) => <p key={dimension.key}>
                        <strong>{dimension.key}: {dimension.score ?? "N/O"}</strong>{" "}{dimension.justification}
                        {dimension.quote ? <> <q>{dimension.quote}</q></> : null}
                      </p>)}
                    </details>
                  </>
                : null}
              {detail.analysis.scores.taxonomyTags?.length
                ? <p>tags: {detail.analysis.scores.taxonomyTags.join(", ")}</p>
                : null}
              {detail.analysis.scores.hardFails && Object.values(detail.analysis.scores.hardFails).some(Boolean)
                ? <p>hard fails: {Object.entries(detail.analysis.scores.hardFails).filter(([, flagged]) => flagged).map(([flag]) => flag).join(", ")}{detail.analysis.scores.hardFailEvidence ? ` · ${Object.values(detail.analysis.scores.hardFailEvidence).filter(Boolean).join(" · ")}` : ""}</p>
                : null}
              {detail.analysis.scores.confidence !== undefined ? <p>confidence: {Math.round(detail.analysis.scores.confidence * 100)}%</p> : null}
              {detail.analysis.scores.modelTier
                ? <p>judge: {detail.analysis.scores.modelTier}{detail.analysis.scores.escalationReason ? ` · ${detail.analysis.scores.escalationReason}` : ""}</p>
                : null}
              {detail.analysis.scores.warnings?.length ? <p>warnings: {detail.analysis.scores.warnings.join(" · ")}</p> : null}
              {detail.analysis.scores.reviewRequired ? <p>NEEDS JOEL: max-tier judgment remains uncertain.</p> : null}
            </>
          : <strong>judge pending</strong>}
        {detail.analysis.scores?.notes ? <p>{detail.analysis.scores.notes}</p> : null}
      </div> : null}
      <div className="transcript">
        <span>transcript tail</span>
        {session.transcriptTail.length ? session.transcriptTail.map((line, index) => <p key={`${index}-${line}`}>{line}</p>) : <p className="muted">No transcript lines captured.</p>}
      </div>
      {session.hangupReason ? <p className="reason">Ended: {session.hangupReason}</p> : null}
    </div> : null}
  </article>;
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return <div><span>{label}</span><strong>{value === null ? "—" : `${value}ms`}</strong></div>;
}

function Dashboard() {
  const now = useNow();
  const active = useQuery(api.calls.activeSessions) as Session[] | undefined;
  const recent = useQuery(api.calls.recentSessions, { limit: 40 }) as Session[] | undefined;
  return <main>
    <header><div><span className="eyebrow">VOICE / LIVE VIEW</span><h1>Call tracker</h1></div><div className="status"><span /> Convex live</div></header>
    <section className="active-section">
      <div className="section-title"><h2>On the line</h2><span>{active?.length ?? 0} active</span></div>
      <div className="active-grid">
        {active === undefined ? <p className="muted">Connecting…</p> : active.length ? active.map((session) => <ActiveCall key={session._id} session={session} now={now} />) : <p className="quiet">Nobody's talking to the rat right now.</p>}
      </div>
    </section>
    <section>
      <div className="section-title"><h2>Recent calls</h2><span>rolling 7 days</span></div>
      <div className="session-list">
        {recent === undefined ? <p className="muted">Loading calls…</p> : recent.length ? recent.map((session) => <SessionCard key={session._id} session={session} />) : <p className="quiet">No calls captured yet.</p>}
      </div>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><ConvexProvider client={client}><Dashboard /></ConvexProvider></StrictMode>);
