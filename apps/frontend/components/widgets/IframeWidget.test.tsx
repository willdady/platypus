import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Widget } from "@platypus/schemas";
import { IframeWidget } from "./IframeWidget";

const iframeWidget: Widget = {
  id: "widget-iframe",
  dashboardId: "dashboard-1",
  type: "iframe",
  title: "Service status",
  data: { url: "https://status.example.com/embed" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("IframeWidget", () => {
  it("renders the embed with fixed isolation attributes", () => {
    render(
      <IframeWidget widget={iframeWidget} editing={false} onSave={vi.fn()} />,
    );

    const iframe = screen.getByTitle("Service status");
    expect(iframe).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-forms allow-popups",
    );
    // Spelled out separately: with this flag the frame is same-origin with the
    // app for a URL on its own origin, and can remove the sandbox itself.
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe).toHaveAttribute("src", "https://status.example.com/embed");
  });

  it("shows an empty state when no URL has been configured", () => {
    render(
      <IframeWidget
        widget={{ ...iframeWidget, data: null }}
        editing={false}
        onSave={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Add an HTTPS URL to embed a page"),
    ).toBeInTheDocument();
  });

  it("shows the empty state instead of rendering a persisted non-HTTPS URL", () => {
    render(
      <IframeWidget
        widget={{ ...iframeWidget, data: { url: "http://status.example.com" } }}
        editing={false}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryByTitle("Service status")).not.toBeInTheDocument();
    expect(
      screen.getByText("Add an HTTPS URL to embed a page"),
    ).toBeInTheDocument();
  });

  it("shows the blocked-embed hint and saves edited values", () => {
    const onSave = vi.fn();
    render(
      <IframeWidget widget={iframeWidget} editing={true} onSave={onSave} />,
    );

    expect(
      screen.getByText(
        "Some sites don't allow embedding and will appear blank.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Embed URL"), {
      target: { value: "https://grafana.example.com/d/overview" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Operations" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(
      { url: "https://grafana.example.com/d/overview" },
      "Operations",
    );
  });

  it("shows a field error and blocks saving until the URL uses HTTPS", () => {
    const onSave = vi.fn();
    render(
      <IframeWidget widget={iframeWidget} editing={true} onSave={onSave} />,
    );

    const urlInput = screen.getByLabelText("Embed URL");
    fireEvent.change(urlInput, {
      target: { value: "http://grafana.example.com/d/overview" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Embed URL must use HTTPS",
    );
    expect(urlInput).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(urlInput, {
      target: { value: "https://grafana.example.com/d/overview" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      { url: "https://grafana.example.com/d/overview" },
      "Service status",
    );
  });
});
