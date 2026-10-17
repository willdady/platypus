import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  KeyValueRowsEditor,
  newRow,
  recordToRows,
  rowsToRecord,
  type KeyValueRow,
} from "./key-value-rows-editor";

function Harness({ initial }: { initial: KeyValueRow[] }) {
  const [rows, setRows] = useState(initial);
  return (
    <KeyValueRowsEditor
      rows={rows}
      onChange={setRows}
      keyPlaceholder="KEY"
      valuePlaceholder="value"
      addLabel="Add variable"
    />
  );
}

describe("KeyValueRowsEditor", () => {
  it("keeps the following rows' typed values and inputs when a middle row is removed", () => {
    render(<Harness initial={[newRow("A", "1"), newRow("B", "2")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByLabelText("KEY 3"), {
      target: { value: "C" },
    });
    fireEvent.change(screen.getByLabelText("value 3"), {
      target: { value: "3" },
    });
    const thirdKey = screen.getByLabelText("KEY 3");

    fireEvent.click(screen.getByRole("button", { name: "Remove row 2" }));

    expect(screen.getByLabelText("KEY 1")).toHaveValue("A");
    expect(screen.getByLabelText("KEY 2")).toHaveValue("C");
    expect(screen.getByLabelText("value 2")).toHaveValue("3");
    // The same DOM node moved up: keyed by id, not by index.
    expect(screen.getByLabelText("KEY 2")).toBe(thirdKey);
    expect(screen.queryByLabelText("KEY 3")).not.toBeInTheDocument();
  });
});

describe("recordToRows / rowsToRecord", () => {
  it("round-trips a record, with a distinct id per row", () => {
    const rows = recordToRows({ A: "1", B: "2" });
    expect(rows.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rowsToRecord(rows, null)).toEqual({ A: "1", B: "2" });
  });

  it("reads null or undefined as no rows", () => {
    expect(recordToRows(null)).toEqual([]);
    expect(recordToRows(undefined)).toEqual([]);
  });

  it("trims keys, keeps values as typed, and drops keyless rows", () => {
    expect(
      rowsToRecord([newRow(" A ", " 1 "), newRow("  ", "x")], undefined),
    ).toEqual({ A: " 1 " });
  });

  it("returns the caller's empty value when no row has a key", () => {
    expect(rowsToRecord([], null)).toBeNull();
    expect(rowsToRecord([newRow()], undefined)).toBeUndefined();
    expect(rowsToRecord([], {})).toEqual({});
  });
});
