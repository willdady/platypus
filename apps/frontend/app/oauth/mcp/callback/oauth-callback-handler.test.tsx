import { describe, it, expect, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { stubAcceptedSave, stubRejectedSave } from "@/test/test-utils";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

import { OAuthCallbackHandler } from "./oauth-callback-handler";

describe("OAuthCallbackHandler", () => {
  it("posts the single-use code once, even under StrictMode", async () => {
    const fetchMock = stubRejectedSave("Invalid state", 400);

    render(
      <StrictMode>
        <OAuthCallbackHandler code="c1" state="s1" />
      </StrictMode>,
    );

    await screen.findByText("Invalid state");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("names the provider's error instead of a missing code", () => {
    const fetchMock = stubAcceptedSave({});

    render(
      <OAuthCallbackHandler
        state="s1"
        error="access_denied"
        errorDescription="The user denied access"
      />,
    );

    expect(screen.getByText(/The user denied access/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Missing authorization code/),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the provider's error code when it gives no description", () => {
    render(<OAuthCallbackHandler state="s1" error="access_denied" />);

    expect(screen.getByText(/access_denied/)).toBeInTheDocument();
  });

  it("still reports a missing code when the provider sent no error", async () => {
    render(<OAuthCallbackHandler state="s1" />);

    expect(
      await screen.findByText("Missing authorization code or state parameter."),
    ).toBeInTheDocument();
  });
});
