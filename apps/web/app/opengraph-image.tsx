import { ImageResponse } from "next/og";
import { clawSvg } from "@/lib/claw";

export const runtime = "edge";
export const alt = "JoelClaw";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#0a0a0a",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "32px",
        }}
      >
        {clawSvg(160)}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <div
            style={{
              fontSize: 64,
              fontWeight: 700,
              color: "#e5e5e5",
              letterSpacing: "-0.02em",
            }}
          >
            JoelClaw
          </div>
          <div style={{ fontSize: 24, color: "#737373" }}>
            My Bespoke OpenClaw-inspired Mac Mini
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
