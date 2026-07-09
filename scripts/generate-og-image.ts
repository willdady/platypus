/**
 * Generates the Open Graph share image (1200x630) used as `og:image` by every
 * page in apps/website and apps/docs.
 *
 * This is a STATIC, committed asset — it is NOT regenerated at build time (that
 * would force every Cloudflare/OpenNext deploy to install Chromium). Re-run it
 * manually whenever the hero text, app screenshot, or branding changes:
 *
 *     pnpm gen:og
 *
 * It renders an HTML template in real Chromium (via Playwright) so we get
 * pixel-accurate fonts, shadows, and object-fit cropping that Satori (next/og)
 * can't do, then writes the identical PNG into both apps' public/ directories.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const WIDTH = 1200;
const HEIGHT = 630;

// Brand greens, matching apps/frontend (ADR-0011). `--primary-bright` is the
// lighter text-on-dark variant the website uses for coloured copy.
const BRAND = "hsl(166, 100%, 26%)";
const BRAND_BRIGHT = "oklch(0.72 0.18 180)";

// Headline is one weight with only "AI agents" in green — exactly like the
// website's hero <h1>.
const HERO_PRE = "Build and manage";
const HERO_ACCENT = "AI agents";
const HERO_POST = "on your own terms";
const URL_TEXT = "platypus.chat";

// Assets live in the website's public dir; we embed them as data URIs so the
// template has no filesystem/network dependency for local images.
const assetsDir = join(repoRoot, "apps/website/public");
const heroPng = readFileSync(join(assetsDir, "hero.png")).toString("base64");

const html = /* html */ `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Geist:wght@500;800&display=swap");

      * { margin: 0; padding: 0; box-sizing: border-box; }

      html, body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        overflow: hidden;
      }

      body {
        display: flex;
        align-items: center;
        background: #0a0a0a;
        color: #fafafa;
        font-family: "Geist", sans-serif;
        position: relative;
      }

      /* Brand glow behind the composition. */
      body::before {
        content: "";
        position: absolute;
        top: -220px;
        right: -160px;
        width: 720px;
        height: 720px;
        background: radial-gradient(circle, hsla(166, 90%, 50%, 0.5), transparent 64%);
        pointer-events: none;
      }

      .left {
        position: relative;
        z-index: 2;
        width: 500px;
        flex-shrink: 0;
        padding: 0 0 0 80px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        height: 100%;
      }

      .headline {
        font-size: 74px;
        font-weight: 800;
        line-height: 1.04;
        letter-spacing: -0.02em;
      }
      .headline .accent { color: ${BRAND_BRIGHT}; }

      .url {
        margin-top: 32px;
        font-size: 40px;
        font-weight: 500;
        color: ${BRAND_BRIGHT};
      }

      /* Screenshot bleeds off the right/bottom edge in a browser frame. */
      .shot {
        position: absolute;
        z-index: 1;
        top: 84px;
        left: 516px;
        width: 1040px;
        border-radius: 14px;
        overflow: hidden;
        border: 1px solid hsl(220, 8%, 22%);
        box-shadow:
          0 0 50px 0 hsla(166, 90%, 55%, 0.28),
          0 40px 90px rgba(0, 0, 0, 0.55);
      }
      .titlebar {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 9px 14px;
        background: oklch(0.15 0.004 220);
        border-bottom: 1px solid hsl(220, 8%, 22%);
      }
      .dot { width: 10px; height: 10px; border-radius: 9999px; }
      .shot img { display: block; width: 100%; height: auto; }
    </style>
  </head>
  <body>
    <div class="left">
      <div class="headline">
        ${HERO_PRE} <span class="accent">${HERO_ACCENT}</span> ${HERO_POST}
      </div>
      <div class="url">${URL_TEXT}</div>
    </div>

    <div class="shot">
      <div class="titlebar">
        <span class="dot" style="background:#ff5f57"></span>
        <span class="dot" style="background:#febc2e"></span>
        <span class="dot" style="background:#28c840"></span>
      </div>
      <img src="data:image/png;base64,${heroPng}" alt="" />
    </div>
  </body>
</html>`;

const outputs = [
  join(repoRoot, "apps/website/public/og.png"),
  join(repoRoot, "apps/docs/public/og.png"),
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  const png = await page.screenshot({
    type: "png",
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  });

  for (const out of outputs) {
    writeFileSync(out, png);
    console.log(`Wrote ${out}`);
  }
} finally {
  await browser.close();
}
