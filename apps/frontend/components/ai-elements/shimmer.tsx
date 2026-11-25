"use client";

import { cn } from "@/lib/utils";
import { motion, useReducedMotion } from "motion/react";
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

// why: motion.create() during render would make a new component on every pass
const motionComponentCache = new Map<ElementType, typeof motion.div>();

function getMotionComponent(component: ElementType) {
  let motionComponent = motionComponentCache.get(component);
  if (!motionComponent) {
    motionComponent = motion.create(
      component as keyof JSX.IntrinsicElements,
    ) as typeof motion.div;
    motionComponentCache.set(component, motionComponent);
  }
  return motionComponent;
}

function ShimmerComponent({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  const MotionComponent = getMotionComponent(Component);
  // why: under reduced motion the text stays put but muted, so it reads as working
  const reduceMotion = useReducedMotion();
  if (reduceMotion) {
    return (
      <Component className={cn("text-muted-foreground", className)}>
        {children}
      </Component>
    );
  }

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
}

export const Shimmer = memo(ShimmerComponent);
