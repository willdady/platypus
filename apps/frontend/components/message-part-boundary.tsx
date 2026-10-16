"use client";

import { Component, type ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { reportClientError } from "@/lib/error-reporting";

type Props = {
  /**
   * Renders the part. A function rather than children so a throw while
   * building the part's elements is caught here too, not only one inside them.
   */
  render: () => ReactNode;
  /**
   * The part itself. A new value (the part streaming on) clears a caught
   * error and tries again, since the part may now be whole.
   */
  resetKey: unknown;
};

type State = { failed: boolean };

const RenderPart = ({ render }: { render: () => ReactNode }) => <>{render()}</>;

/**
 * Wraps one Chat message part, so a part that fails to render — a malformed
 * tool result, an input no renderer expected — costs only that part, not
 * the whole message or the Chat around it.
 */
export class MessagePartBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  /**
   * The last failure reported. A part that stays malformed while it streams
   * throws the same error on every chunk; it is reported once, not per chunk.
   */
  private lastReported: string | null = null;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    const signature = error instanceof Error ? error.message : String(error);
    if (signature === this.lastReported) return;
    this.lastReported = signature;
    reportClientError(error, { source: "message-part" });
  }

  override componentDidUpdate(prevProps: Props) {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (this.state.failed) {
      return (
        <div className="flex items-center gap-1.5 pl-8 text-xs text-muted-foreground">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          <span>Couldn&apos;t render this part</span>
        </div>
      );
    }
    return <RenderPart render={this.props.render} />;
  }
}
