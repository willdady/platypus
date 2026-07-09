"use client";

import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import {
  type CSSProperties,
  type ElementType,
  type JSX,
  memo,
  useMemo,
} from "react";

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

// Cache motion components per element type. motion.create() must not run during
// render (it would create a new component each time); caching keeps the
// resulting component stable across renders. Typed as a generic HTML motion
// component (motion.div) so it accepts the common HTML motion props used below.
const motionComponentCache = new Map<ElementType, typeof motion.div>();

const getMotionComponent = (component: ElementType) => {
  let motionComponent = motionComponentCache.get(component);
  if (!motionComponent) {
    motionComponent = motion.create(
      component as keyof JSX.IntrinsicElements,
    ) as typeof motion.div;
    motionComponentCache.set(component, motionComponent);
  }
  return motionComponent;
};

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  // getMotionComponent returns a stable, module-cached component (keyed by the
  // `as` element type, which never changes for a mounted instance), so it is
  // not a new component created during render despite the rule's heuristic.
  const MotionComponent = getMotionComponent(Component);

  return (
    // eslint-disable-next-line react-hooks/static-components -- MotionComponent is module-cached and stable per `as` value
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: "linear",
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
