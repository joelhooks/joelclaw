import { ImageResponse } from "next/og";
import { getPost, getPostSlugs } from "../../lib/posts";
import { clawSvg } from "../../lib/claw";

export const alt = "JoelClaw";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export async function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPost(slug);
  const title = post?.meta.title ?? slug;

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
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            flex: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: 56,
              fontWeight: 700,
              color: "#e5e5e5",
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
              maxWidth: "900px",
            }}
          >
            {title}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
          }}
        >
          {clawSvg(40)}
          <div style={{ fontSize: 24, fontWeight: 600, color: "#737373" }}>
            joelclaw.com
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
