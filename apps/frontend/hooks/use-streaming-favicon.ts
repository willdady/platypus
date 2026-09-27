import { useEffect, useRef } from "react";

const BLINK_MS = 1000;

/** The favicon with a solid dot in its bottom-right corner, or null if it can't be drawn. */
const drawDotFrame = (href: string): Promise<string | null> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = Math.max(img.width, img.height) || 32;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, size, size);
      // Punch a transparent gap through the icon, then sit the dot inside it,
      // so the dot stays distinct from the icon's own teal background.
      const gap = size * 0.14;
      const r = size * 0.18;
      const c = size * 0.72; // dot centre, independent of the gap
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(c, c, r + gap, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.arc(c, c, r, 0, 2 * Math.PI);
      ctx.fillStyle = "#4ade80";
      ctx.fill();
      try {
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null); // tainted canvas
      }
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });

/**
 * Blinks a dot on the tab favicon while `active`, restoring the original icon
 * exactly when it turns false or the caller unmounts. Uses `setInterval` rather
 * than `requestAnimationFrame`, which is paused in background tabs.
 */
export const useStreamingFavicon = (active: boolean) => {
  const dotFrame = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    if (!active) return;
    const links = [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
    ];
    if (links.length === 0) return;
    const originals = links.map((l) => l.getAttribute("href"));
    const restore = () =>
      links.forEach((l, i) => {
        const href = originals[i];
        if (href === null) l.removeAttribute("href");
        else l.setAttribute("href", href);
      });

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    dotFrame.current ??= drawDotFrame(links[0].href);
    void dotFrame.current.then((dot) => {
      if (cancelled || !dot) return;
      let on = false;
      timer = setInterval(() => {
        on = !on;
        if (on) links.forEach((l) => l.setAttribute("href", dot));
        else restore();
      }, BLINK_MS);
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      restore();
    };
  }, [active]);
};
