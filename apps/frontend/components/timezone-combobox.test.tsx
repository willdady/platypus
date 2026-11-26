import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimezoneCombobox } from "./timezone-combobox";
import { TIMEZONES } from "@/lib/timezones";

const FIRST_PAGE = 50;

function renderCombobox(value: string | null, onChange = vi.fn()) {
  render(
    <>
      <label htmlFor="timezone">Timezone</label>
      <TimezoneCombobox id="timezone" value={value} onChange={onChange} />
    </>,
  );
  return { user: userEvent.setup(), onChange };
}

async function openCombobox(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Timezone" }));
  return screen.getByPlaceholderText("Search timezones...");
}

describe("TimezoneCombobox", () => {
  it("mounts only a page of options, not the whole IANA list", async () => {
    expect(TIMEZONES.length).toBeGreaterThan(FIRST_PAGE);
    const { user } = renderCombobox(null);

    await openCombobox(user);

    expect(await screen.findAllByRole("option")).toHaveLength(FIRST_PAGE);
    expect(
      screen.getByText(`Showing ${FIRST_PAGE} of ${TIMEZONES.length}.`),
    ).toBeInTheDocument();
  });

  it("reveals further zones a page at a time with Show more", async () => {
    const { user } = renderCombobox(null);
    await openCombobox(user);

    await user.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getAllByRole("option")).toHaveLength(FIRST_PAGE * 2);
    expect(
      screen.getByRole("option", { name: TIMEZONES[FIRST_PAGE] }),
    ).toBeInTheDocument();
  });

  it("finds and picks a zone past the first page by searching", async () => {
    const zone = TIMEZONES[TIMEZONES.length - 1];
    const { user, onChange } = renderCombobox(null);
    const input = await openCombobox(user);

    await user.type(input, zone);
    await user.click(screen.getByRole("option", { name: zone }));

    expect(onChange).toHaveBeenCalledWith(zone);
  });

  it("keeps the selected zone on screen before the user searches", async () => {
    const zone = TIMEZONES[TIMEZONES.length - 1];
    const { user } = renderCombobox(zone);

    await openCombobox(user);

    expect(screen.getByRole("option", { name: zone })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(FIRST_PAGE);
  });

  it("says so when the search matches no zone", async () => {
    const { user } = renderCombobox(null);
    const input = await openCombobox(user);

    await user.type(input, "Not/AZone");

    expect(screen.getByText("No timezones found.")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("clears the search when the list closes", async () => {
    const zone = TIMEZONES[TIMEZONES.length - 1];
    const { user } = renderCombobox(null);
    const input = await openCombobox(user);
    await user.type(input, zone);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("combobox", { name: "Timezone" }));

    expect(screen.getByPlaceholderText("Search timezones...")).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(FIRST_PAGE);
  });

  it("ties an invalid picker to its error text", () => {
    render(
      <>
        <label htmlFor="timezone">Timezone</label>
        <TimezoneCombobox
          id="timezone"
          value={null}
          onChange={vi.fn()}
          invalid
          describedBy="timezone-error"
        />
        <p id="timezone-error">Pick a zone</p>
      </>,
    );

    const combobox = screen.getByRole("combobox", { name: "Timezone" });
    expect(combobox).toHaveAttribute("aria-invalid", "true");
    expect(combobox).toHaveAttribute("aria-describedby", "timezone-error");
  });
});
