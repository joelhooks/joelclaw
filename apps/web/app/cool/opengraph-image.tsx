import { ImageResponse } from "next/og";
import { CLAW_COLOR, clawSvg } from "@/lib/claw";
import { getAllDiscoveries } from "@/lib/discoveries";

export const alt = "Cool Finds — JoelClaw";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TAG_COLORS: Record<string, string> = {
  repo: "#60a5fa",
  article: "#4ade80",
  tool: "#c084fc",
  ai: "#facc15",
  cli: "#fb923c",
  typescript: "#38bdf8",
  go: "#22d3ee",
  pattern: "#f472b6",
  agents: CLAW_COLOR,
  infrastructure: "#a78bfa",
  "agent-loops": CLAW_COLOR,
};

export default async function Image() {
  const discoveries = await getAllDiscoveries();
  const total = discoveries.length;
  const recent = discoveries.slice(0, 4);

  // Aggregate top tags across all discoveries
  const tagCounts: Record<string, number> = {};
  for (const d of discoveries) {
    for (const t of d.tags) {
      tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);

  return new ImageResponse(
    (
      <div
        style={{
          background: "#0a0a0a",
          width: "100%",
          height: "100%",
          display: "flex",
          padding: "56px 72px",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
            <div
              style={{
                fontSize: 56,
                fontWeight: 700,
                color: "#e5e5e5",
                letterSpacing: "-0.03em",
                display: "flex",
              }}
            >
              Cool Finds
            </div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: CLAW_COLOR,
                padding: "6px 18px",
                borderRadius: "9999px",
                border: `1.5px solid ${CLAW_COLOR}`,
                background: "rgba(255, 20, 147, 0.08)",
                display: "flex",
              }}
            >
              {total}
            </div>
          </div>
          <div
            style={{
              fontSize: 22,
              color: "#525252",
              display: "flex",
              lineHeight: 1.4,
            }}
          >
            Repos, tools, articles, and ideas — captured by agents
          </div>

          {/* Tag cloud */}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {topTags.map(([tag, count]) => {
              const color = TAG_COLORS[tag] ?? "#737373";
              return (
                <div
                  key={tag}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "5px 14px",
                    borderRadius: "6px",
                    border: `1px solid ${color}33`,
                    background: `${color}0d`,
                  }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: color,
                      display: "flex",
                    }}
                  />
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      display: "flex",
                    }}
                  >
                    {tag}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: "#525252",
                      display: "flex",
                    }}
                  >
                    {count}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent discoveries */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {recent.map((d, i) => {
            const title =
              d.title.length > 48 ? d.title.slice(0, 45) + "..." : d.title;
            return (
              <div
                key={d.slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "14px",
                  padding: "10px 16px",
                  borderRadius: "8px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "6px",
                    background: `linear-gradient(135deg, ${CLAW_COLOR}44, ${CLAW_COLOR}11)`,
                    border: `1px solid ${CLAW_COLOR}33`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    color: CLAW_COLOR,
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </div>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    color: "#d4d4d4",
                    display: "flex",
                    flex: 1,
                  }}
                >
                  {title}
                </div>
                {d.tags[0] && (
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: TAG_COLORS[d.tags[0]] ?? "#737373",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      display: "flex",
                      flexShrink: 0,
                    }}
                  >
                    {d.tags[0]}
                  </div>
                )}
              </div>
            );
          })}
          {total > 4 && (
            <div
              style={{
                fontSize: 14,
                color: "#404040",
                paddingLeft: "16px",
                display: "flex",
              }}
            >
              +{total - 4} more finds
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 17, color: "#404040", display: "flex" }}>
            Discovered in conversation · investigated by agents
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
            }}
          >
            {clawSvg(36)}
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: "#737373",
                display: "flex",
              }}
            >
              joelclaw.com
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
