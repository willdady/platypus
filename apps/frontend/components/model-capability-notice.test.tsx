import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelCapabilityNotice } from "./model-capability-notice";

describe("ModelCapabilityNotice", () => {
  it("warns when the model accepts no file types natively", () => {
    render(<ModelCapabilityNotice passthroughFileTypes={[]} />);
    expect(
      screen.getByText(/doesn't natively accept file attachments/i),
    ).toBeInTheDocument();
  });

  it("renders nothing when the model accepts at least one file type natively", () => {
    const { container } = render(
      <ModelCapabilityNotice passthroughFileTypes={["image/*"]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
