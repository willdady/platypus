import { useEffect, useRef } from "react";

const BLINK_MS = 600;

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
      // White with a dark ring: the icon's own background is the theme teal.
      const ring = size * 0.06;
      const r = size * 0.18;
      ctx.beginPath();
      ctx.arc(size - r - ring / 2, size - r - ring / 2, r, 0, 2 * Math.PI);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = ring;
      ctx.strokeStyle = "#134e4a";
      ctx.stroke();
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
