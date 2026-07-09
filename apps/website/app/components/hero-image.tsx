"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";

// Max backward tilt (degrees around the X axis) when the window first enters the
// viewport. It eases to 0° (flat, facing the viewer) as it scrolls up into view,
// producing a "standing up to face you" reveal.
const MAX_TILT = 46;

export function HeroImage() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const frame = frameRef.current;
    if (!wrapper || !frame) return;

    // Honour reduced-motion: render flat and skip the scroll listener.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      frame.style.transform = "rotateX(0deg)";
      return;
    }

    let raf = 0;
    const apply = () => {
      raf = 0;
      // No tilt on mobile (<md). The CSS class below also flattens it pre-hydration
      // to avoid a flash; here we just clear any inline transform and bail.
      if (window.innerWidth < 768) {
        frame.style.transform = "";
        return;
      }
      const rect = wrapper.getBoundingClientRect();
      const vh = window.innerHeight;
      // progress: 0 when the wrapper's top sits at the viewport bottom, 1 once
      // it has risen to ~35% from the top. Tilt is full at 0, gone at 1.
      const start = vh;
      const end = vh * 0.35;
      const progress = Math.min(
        1,
        Math.max(0, (start - rect.top) / (start - end)),
      );
      frame.style.transform = `rotateX(${(1 - progress) * MAX_TILT}deg)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={wrapperRef} style={{ perspective: "1600px" }}>
      <div
        ref={frameRef}
        className="overflow-hidden rounded-xl border border-border shadow-2xl shadow-black/40 max-md:[transform:none!important]"
        // Initial inline transform so the first paint is already tilted (close
        // to the on-load computed value), avoiding a flash before the effect runs.
        style={{
          transform: `rotateX(${MAX_TILT / 2}deg)`,
          transformOrigin: "center center",
          willChange: "transform",
        }}
      >
        {/* Pseudo-browser app bar: traffic-light window controls. */}
        <div className="flex items-center gap-1.5 border-b border-border bg-[oklch(0.15_0.004_220)] px-3 py-2 sm:gap-2 sm:px-4 sm:py-3">
          <span
            className="size-1.5 rounded-full sm:size-3 bg-[#ff5f57]"
            aria-hidden="true"
          />
          <span
            className="size-1.5 rounded-full sm:size-3 bg-[#febc2e]"
            aria-hidden="true"
          />
          <span
            className="size-1.5 rounded-full sm:size-3 bg-[#28c840]"
            aria-hidden="true"
          />
        </div>
        <Image
          src="/hero.png"
          alt="The Platypus workspace dashboard showing agents, boards, and triggers"
          width={3024}
          height={1652}
          priority
          className="block h-auto w-full"
        />
      </div>
    </div>
  );
}
