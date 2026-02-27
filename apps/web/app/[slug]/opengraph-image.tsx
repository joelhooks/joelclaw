import { ImageResponse } from "next/og";
import { CLAW_COLOR, clawSvg } from "@/lib/claw";
import { formatDateStatic } from "@/lib/date";
import type { ContentType } from "@/lib/posts";
import { getPost, getPostSlugs } from "@/lib/posts";

export const alt = "JoelClaw";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TYPE_COLORS: Record<ContentType, string> = {
  article: CLAW_COLOR,
  essay: "#f59e0b",
  tutorial: "#22c55e",
  note: "#3b82f6",
};

const TYPE_LABELS: Record<ContentType, string> = {
  article: "Article",
  essay: "Essay",
  tutorial: "Tutorial",
  note: "Note",
};

export async function generateStaticParams() {
  const slugs = await getPostSlugs();
  return slugs.map((slug) => ({ slug }));
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);
  const title = post?.meta.title ?? slug;
  const type = post?.meta.type ?? "article";
  const tags = post?.meta.tags ?? [];
  const date = post?.meta.date ?? "";
  const accentColor = TYPE_COLORS[type];

  const formattedDate = date
    ? formatDateStatic(date, { monthStyle: "short", includeYear: true })
    : "";

  return new ImageResponse(
    (
      <div
        style={{
          background: "#0a0a0a",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "row",
        }}
      >
        {/* Accent bar */}
        <div
          style={{
            width: "6px",
            height: "100%",
            background: `linear-gradient(180deg, ${accentColor}, ${accentColor}44)`,
            display: "flex",
            flexShrink: 0,
          }}
        />

        {/* Content */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "56px 72px 48px 64px",
            flex: 1,
          }}
        >
          {/* Top: type badge + date */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 16px",
                borderRadius: "6px",
                border: `1.5px solid ${accentColor}`,
                background: `${accentColor}15`,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: accentColor,
                  display: "flex",
                }}
              />
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: accentColor,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  display: "flex",
                }}
              >
                {TYPE_LABELS[type]}
              </div>
            </div>
            {formattedDate && (
              <div
                style={{
                  fontSize: 16,
                  color: "#525252",
                  display: "flex",
                }}
              >
                {formattedDate}
              </div>
            )}
          </div>

          {/* Middle: title */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "24px",
              flex: 1,
              justifyContent: "center",
            }}
          >
            <div
              style={{
                fontSize: title.length > 60 ? 44 : 52,
                fontWeight: 700,
                color: "#e5e5e5",
                letterSpacing: "-0.025em",
                lineHeight: 1.15,
                maxWidth: "950px",
              }}
            >
              {title}
            </div>

            {/* Tags */}
            {tags.length > 0 && (
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {tags.slice(0, 4).map((tag) => (
                  <div
                    key={tag}
                    style={{
                      display: "flex",
                      padding: "4px 12px",
                      borderRadius: "4px",
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.04)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#737373",
                        display: "flex",
                      }}
                    >
                      {tag}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer: claw + site */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "14px",
            }}
          >
            {clawSvg(36)}
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: "#525252",
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
