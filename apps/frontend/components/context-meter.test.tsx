import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AnimatePresence, MotionGlobalConfig } from "motion/react";

import {
  ContextMeter,
  ContextMeterEntrance,
  ContextWindowHint,
} from "./context-meter";

const motionPreference = vi.hoisted(() => ({
  isMobile: true,
  reducedMotion: false,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => motionPreference.isMobile,
}));

vi.mock("motion/react", async (importOriginal) => {
  const motion = await importOriginal<typeof import("motion/react")>();
  return {
    ...motion,
    useReducedMotion: () => motionPreference.reducedMotion,
  };
});

afterEach(() => {
  MotionGlobalConfig.instantAnimations = false;
  motionPreference.isMobile = true;
  motionPreference.reducedMotion = false;
});

describe("ContextMeterEntrance", () => {
  const renderPresence = (visible: boolean, label = "meter") =>
    render(
      <AnimatePresence initial={false}>
        {visible && (
          <ContextMeterEntrance key="context-meter">
            <span>{label}</span>
          </ContextMeterEntrance>
        )}
      </AnimatePresence>,
    );

  const entranceFor = (label: string) => screen.getByText(label).closest("div");

  it("shows a meter present on the first render at its natural height", () => {
    renderPresence(true);

    const entrance = entranceFor("meter");
    expect(entrance).toHaveStyle({ height: "auto", opacity: "1" });
    expect(entrance).toHaveClass(
      "shrink-0",
      "overflow-hidden",
      "-mb-3",
      "sm:mb-0",
    );
  });

  it("animates a mobile meter that becomes available without restarting on rerender", async () => {
    // why: the tween is Motion's; where it starts and lands is ours
    MotionGlobalConfig.instantAnimations = true;
    const view = renderPresence(false);

    view.rerender(
      <AnimatePresence initial={false}>
        <ContextMeterEntrance key="context-meter">
          <span>meter</span>
        </ContextMeterEntrance>
      </AnimatePresence>,
    );

    const entrance = entranceFor("meter");
    // why: 0.75rem of bleed reports as 12px in the computed style
    expect(entrance).toHaveStyle({ height: "12px", opacity: "0" });

    await waitFor(() =>
      expect(entrance).toHaveStyle({ height: "auto", opacity: "1" }),
    );

    view.rerender(
      <AnimatePresence initial={false}>
        <ContextMeterEntrance key="context-meter">
          <span>updated meter</span>
        </ContextMeterEntrance>
      </AnimatePresence>,
    );
    expect(entranceFor("updated meter")).toHaveStyle({
      height: "auto",
      opacity: "1",
    });
  });

  it.each([
    { name: "desktop", isMobile: false, reducedMotion: false },
    { name: "reduced motion", isMobile: true, reducedMotion: true },
  ])("shows a newly available meter immediately on $name", (preference) => {
    motionPreference.isMobile = preference.isMobile;
    motionPreference.reducedMotion = preference.reducedMotion;
    const view = renderPresence(false);

    view.rerender(
      <AnimatePresence initial={false}>
        <ContextMeterEntrance key="context-meter">
          <span>meter</span>
        </ContextMeterEntrance>
      </AnimatePresence>,
    );

    expect(entranceFor("meter")).toHaveStyle({
      height: "auto",
      opacity: "1",
    });
  });
});

describe("ContextWindowHint", () => {
  it("says long Chats are not condensed and points at Provider settings", () => {
    render(
      <ContextWindowHint href="/org1/workspace/ws1/settings/providers/p1" />,
    );

    expect(screen.getByText(/No Context window set/)).toBeInTheDocument();
    expect(screen.getByText(/long Chats aren't condensed/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Provider settings/ }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/settings/providers/p1");
  });
});

describe("ContextMeter", () => {
  it("renders nothing when no Context window is declared", () => {
    const { container } = render(<ContextMeter occupancy={42_000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when occupancy is unknown", () => {
    for (const occupancy of [undefined, null]) {
      const { container } = render(
        <ContextMeter occupancy={occupancy} contextWindow={128_000} />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("shows the percentage and both token figures", () => {
    render(<ContextMeter occupancy={42_000} contextWindow={128_000} />);

    expect(screen.getByText(/42K/)).toBeInTheDocument();
    expect(screen.getByText(/128K/)).toBeInTheDocument();
    expect(screen.getByText(/33%/)).toBeInTheDocument();
    // why: a progressbar's value is aria-valuenow, which toHaveValue can't read
    // eslint-disable-next-line jest-dom/prefer-to-have-value
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "33",
    );
  });

  it("clamps the bar and the percentage but not the figures when occupancy exceeds the window", () => {
    render(<ContextMeter occupancy={150_000} contextWindow={128_000} />);

    // eslint-disable-next-line jest-dom/prefer-to-have-value
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(screen.getByText(/100%/)).toBeInTheDocument();
    expect(screen.queryByText(/117%/)).not.toBeInTheDocument();
    expect(screen.getByText(/150K/)).toBeInTheDocument();
    expect(screen.getByText(/128K/)).toBeInTheDocument();
  });

  // why: unit choice is formatTokens' business, and it is tested there
  it("writes both figures in units", () => {
    render(<ContextMeter occupancy={1_100} contextWindow={2_000_000} />);

    expect(screen.getByText(/1\.1K\/2M/)).toBeInTheDocument();
    expect(screen.queryByText(/1,100/)).not.toBeInTheDocument();
  });

  it("rounds a nearly-empty window to a percentage rather than hiding", () => {
    render(<ContextMeter occupancy={12} contextWindow={128_000} />);

    expect(screen.getByText(/0%/)).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });
});
