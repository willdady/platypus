import { describe, it, expect } from "vitest";
import {
  canSubmitForm,
  parseValidationErrors,
  retractExactKeys,
  retractFieldError,
  type FormErrors,
} from "./form-errors";

describe("parseValidationErrors", () => {
  it("should parse validation errors correctly", () => {
    const errorData = {
      error: [
        { path: ["name"], message: "Name is required" },
        { path: ["email"], message: "Invalid email" },
      ],
    };
    const result = parseValidationErrors(errorData);
    expect(result).toEqual({
      name: "Name is required",
      email: "Invalid email",
    });
  });

  it("should return empty object for invalid input", () => {
    expect(parseValidationErrors(null)).toEqual({});
    expect(parseValidationErrors({})).toEqual({});
    expect(parseValidationErrors({ error: "string" })).toEqual({});
  });

  // A rule over a list reports the row it failed on. Keyed on the first path
  // segment alone, every row's message landed on the same key and all but one
  // was lost — two bad rows meant one message and one fix per round-trip.
  it("keys an error inside a list on its full path", () => {
    const result = parseValidationErrors({
      error: [
        { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
        { path: ["modelIds", 2, "alias"], message: "Alias 'DUP' duplicates" },
      ],
    });

    expect(result["modelIds.1.alias"]).toBe("Alias 'dup' duplicates");
    expect(result["modelIds.2.alias"]).toBe("Alias 'DUP' duplicates");
  });

  // Not every form knows about paths. Each issue also reports under its
  // top-level field so a form that only reads flat names still shows something
  // rather than failing silently.
  it("also reports a nested error under its top-level field", () => {
    const result = parseValidationErrors({
      error: [{ path: ["modelIds", 1, "alias"], message: "Alias duplicates" }],
    });

    expect(result.modelIds).toBe("Alias duplicates");
  });

  // An error against the list itself is the better message for the list's own
  // slot, whichever order the two arrive in.
  it("prefers an error on the field itself over one derived from a row", () => {
    const rowFirst = parseValidationErrors({
      error: [
        { path: ["modelIds", 0, "alias"], message: "Row message" },
        { path: ["modelIds"], message: "Field message" },
      ],
    });

    expect(rowFirst.modelIds).toBe("Field message");
    expect(rowFirst["modelIds.0.alias"]).toBe("Row message");
  });

  it("keeps the first message when one field has several", () => {
    const result = parseValidationErrors({
      error: [
        { path: ["name"], message: "Too short" },
        { path: ["name"], message: "Also invalid" },
      ],
    });

    expect(result.name).toBe("Too short");
  });
});

describe("retractFieldError", () => {
  it("drops the field's own error", () => {
    expect(
      retractFieldError({ name: "Required", apiKey: "Bad" }, "name"),
    ).toEqual({ apiKey: "Bad" });
  });

  // The edit that fixes a row is an edit to the field the row lives in, so the
  // rows' errors have to go with it. A form gating Submit on the error map
  // stays stuck forever otherwise.
  it("drops errors nested under the field", () => {
    const errors = {
      "modelIds.1.alias": "Duplicate",
      "modelIds.2.alias": "Duplicate",
      modelIds: "Duplicate",
      name: "Required",
    };

    expect(retractFieldError(errors, "modelIds")).toEqual({
      name: "Required",
    });
  });

  it("leaves a field whose name merely prefixes the edited one", () => {
    const errors = { modelIdsExtra: "Bad" };

    expect(retractFieldError(errors, "modelIds")).toEqual(errors);
  });

  it("returns the same object when nothing matches, so state does not churn", () => {
    const errors = { name: "Required" };

    expect(retractFieldError(errors, "apiKey")).toBe(errors);
  });
});

describe("retractExactKeys", () => {
  it("drops exactly the given keys", () => {
    const errors = { name: "Required", "headers.X-Foo": "Too long" };

    expect(retractExactKeys(errors, ["name"])).toEqual({
      "headers.X-Foo": "Too long",
    });
  });

  // Unlike retractFieldError, a row-scoped clear must not sweep siblings
  // sharing the same top-level field name.
  it("leaves sibling rows under the same top-level field alone", () => {
    const errors = {
      "headers.X-Foo": "Too long",
      "headers.X-Bar": "Too long",
    };

    expect(retractExactKeys(errors, ["headers", "headers.X-Foo"])).toEqual({
      "headers.X-Bar": "Too long",
    });
  });

  it("returns the same object when nothing matches, so state does not churn", () => {
    const errors = { name: "Required" };

    expect(retractExactKeys(errors, ["apiKey"])).toBe(errors);
  });
});

describe("canSubmitForm", () => {
  it("allows submit when there are no errors", () => {
    expect(canSubmitForm({}, ["name", "url"])).toBe(true);
  });

  it("blocks submit while a retractable field's error is outstanding", () => {
    expect(canSubmitForm({ name: "Required" }, ["name", "url"])).toBe(false);
  });

  it("blocks submit on a row-level error under a retractable field", () => {
    expect(
      canSubmitForm({ "headers.X-Foo": "Too long" }, ["name", "headers"]),
    ).toBe(false);
  });

  // The #571 invariant: a server-returned error keyed to a field the form
  // never declared has no way to be retracted by editing, so it must never
  // gate Save — the only escape from that would be reloading the page.
  it("never blocks submit on an error whose key no field can retract", () => {
    expect(canSubmitForm({ events: "At least one event required" }, [])).toBe(
      true,
    );
    expect(canSubmitForm({ someServerOnlyRule: "Nope" }, ["name", "url"])).toBe(
      true,
    );
  });

  // Regression for #559: a Webhook save rejected on `events` — a field the
  // form declares — must leave Save usable once `events` is edited (i.e. once
  // its error is retracted), not disabled forever.
  it("mirrors the #559 webhook round trip: retract, then submit is allowed again", () => {
    const retractable = ["name", "url", "enabled", "events", "headers"];
    let errors: FormErrors = { events: "At least one event is required" };

    expect(canSubmitForm(errors, retractable)).toBe(false);

    errors = retractFieldError(errors, "events");

    expect(errors).toEqual({});
    expect(canSubmitForm(errors, retractable)).toBe(true);
  });
});
