import { ImageResponse } from "next/og";
import { clawSvg, CLAW_COLOR } from "../../lib/claw";

export const alt = "Network — JoelClaw";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const STATUS_COLORS: Record<string, string> = {
  Active: "#4ade80",
  Planned: "#facc15",
  Dormant: "#737373",
};

const nodes = [
  {
    name: "Hub",
    status: "Active",
    spec: "M4 Pro · 64 GB",
    role: "Control plane, events, vector search",
  },
  {
    name: "Library",
    status: "Active",
    spec: "Linux",
    role: "700 docs · 393k chunks",
  },
  {
    name: "Archive",
    status: "Active",
    spec: "64 TB NAS",
    role: "Video, books, backups",
  },
  {
    name: "Studio",
    status: "Planned",
    spec: "M4 Max · 128 GB",
    role: "Local LLM inference (70B–235B)",
  },
  {
    name: "Forge",
    status: "Dormant",
    spec: "2× RTX PRO 4500 · 48 GB VRAM",
    role: "CUDA batch processing",
  },
];

const stats = [
  { label: "Unified Memory", value: "192+ GB" },
  { label: "GPU Compute", value: "60-core + Blackwell" },
  { label: "Storage", value: "64+ TB" },
  { label: "Nodes", value: "5" },
];

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#0a0a0a",
          width: "100%",
          height: "100%",
          display: "flex",
          padding: "52px 72px",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div
            style={{
              fontSize: 48,
              fontWeight: 700,
              color: "#e5e5e5",
              letterSpacing: "-0.02em",
              display: "flex",
            }}
          >
            Network
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", gap: "16px" }}>
            {stats.map((stat) => (
              <div
                key={stat.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 16px",
                  borderRadius: "9999px",
                  border: `1.5px solid rgba(255, 20, 147, 0.3)`,
                  background: "rgba(255, 20, 147, 0.06)",
                }}
              >
                <div
                  style={{
                    fontSize: 16,
                    color: CLAW_COLOR,
                    fontWeight: 600,
                    display: "flex",
                  }}
                >
                  {stat.value}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: "#737373",
                    fontWeight: 500,
                    display: "flex",
                  }}
                >
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Nodes */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {nodes.map((node) => (
            <div
              key={node.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "16px",
                padding: "10px 16px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              {/* Status dot */}
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: STATUS_COLORS[node.status] ?? "#525252",
                  display: "flex",
                  flexShrink: 0,
                }}
              />
              {/* Name */}
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#e5e5e5",
                  width: "90px",
                  display: "flex",
                  flexShrink: 0,
                }}
              >
                {node.name}
              </div>
              {/* Spec */}
              <div
                style={{
                  fontSize: 14,
                  color: "#a3a3a3",
                  fontFamily: "monospace",
                  width: "280px",
                  display: "flex",
                  flexShrink: 0,
                }}
              >
                {node.spec}
              </div>
              {/* Role */}
              <div
                style={{
                  fontSize: 14,
                  color: "#525252",
                  display: "flex",
                }}
              >
                {node.role}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 18, color: "#525252", display: "flex" }}>
            Personal AI compute fabric · Encrypted mesh
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
