import { ImageResponse } from "next/og";
import { getAllAdrs } from "../../lib/adrs";
import { clawSvg, CLAW_COLOR } from "../../lib/claw";

export const alt = "Architecture Decision Records — JoelClaw";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const STATUS_COLORS: Record<string, string> = {
  accepted: "#4ade80",
  proposed: "#facc15",
  superseded: "#a3a3a3",
  implemented: CLAW_COLOR,
  deprecated: "#f87171",
};

export default async function Image() {
  const adrs = getAllAdrs();
  const total = adrs.length;

  const counts = adrs.reduce(
    (acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const statusEntries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const recent = adrs.slice(0, 5);

  return new ImageResponse(
    (
      <div
        style={{
          background: "#0a0a0a",
          width: "100%",
          height: "100%",
          display: "flex",
          padding: "60px 80px",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div
            style={{
              fontSize: 52,
              fontWeight: 700,
              color: "#e5e5e5",
              letterSpacing: "-0.02em",
              display: "flex",
            }}
          >
            Architecture Decision Records
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            {statusEntries.map(([status, count]) => (
              <div
                key={status}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 16px",
                  borderRadius: "9999px",
                  border: `1.5px solid ${STATUS_COLORS[status] ?? "#525252"}`,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLORS[status] ?? "#525252",
                    display: "flex",
                  }}
                />
                <div
                  style={{
                    fontSize: 18,
                    color: STATUS_COLORS[status] ?? "#a3a3a3",
                    fontWeight: 600,
                    display: "flex",
                  }}
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </div>
                <div
                  style={{
                    fontSize: 18,
                    color: "#737373",
                    fontWeight: 500,
                    display: "flex",
                  }}
                >
                  {count}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {recent.map((adr) => {
            const label = adr.title.replace(/^ADR-\d+:\s*/, "");
            const short = label.length > 38 ? label.slice(0, 35) + "..." : label;
            return (
              <div
                key={adr.number}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 14px",
                  borderRadius: "8px",
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: STATUS_COLORS[adr.status] ?? "#a3a3a3",
                    display: "flex",
                  }}
                >
                  {adr.number}
                </div>
                <div
                  style={{
                    fontSize: 15,
                    color: "#a3a3a3",
                    display: "flex",
                  }}
                >
                  {short}
                </div>
              </div>
            );
          })}
          {total > 5 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "8px 14px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
                fontSize: 15,
                color: "#525252",
              }}
            >
              +{total - 5} more
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 20, color: "#525252", display: "flex" }}>
            {total} decisions documented
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
