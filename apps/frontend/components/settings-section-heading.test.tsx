import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SettingsSectionHeading,
  settingsSectionHeadingClass,
} from "./settings-section-heading";

describe("SettingsSectionHeading", () => {
  it("renders a section heading in the one settings-page style", () => {
    render(<SettingsSectionHeading>Access</SettingsSectionHeading>);

    expect(
      screen.getByRole("heading", { level: 2, name: "Access" }),
    ).toHaveClass(settingsSectionHeadingClass);
  });

  it("keeps a caller's extra spacing", () => {
    render(
      <SettingsSectionHeading className="mt-8">
        Importing in workspaces
      </SettingsSectionHeading>,
    );

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Importing in workspaces",
      }),
    ).toHaveClass(settingsSectionHeadingClass, "mt-8");
  });
});
