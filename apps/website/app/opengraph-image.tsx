import { ImageResponse } from "next/og";

// Static metadata for the generated card.
export const alt =
  "Platypus — build and manage AI agents with tool support and multi-provider capabilities.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand green, matching apps/frontend `--primary` (ADR-0011): hsl(166 100% 26%).
const brand = "hsl(166, 100%, 26%)";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "80px",
        background: "#0a0a0a",
        color: "#fafafa",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
        <div
          style={{
            width: "56px",
            height: "56px",
            borderRadius: "14px",
            background: brand,
          }}
        />
        <div style={{ fontSize: "32px", fontWeight: 700, color: brand }}>
          Platypus
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <div style={{ fontSize: "84px", fontWeight: 800, lineHeight: 1.05 }}>
          Build and manage AI agents
        </div>
        <div
          style={{
            fontSize: "36px",
            color: "#a1a1aa",
            maxWidth: "900px",
            lineHeight: 1.3,
          }}
        >
          Self-hosted, multi-tenant, multi-provider. You bring the models —
          Platypus gives you everything around them.
        </div>
      </div>
      <div style={{ fontSize: "28px", color: brand, fontWeight: 600 }}>
        platypus.chat
      </div>
    </div>,
    { ...size },
  );
}
