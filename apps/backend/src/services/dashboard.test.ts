import { describe, it, expect, beforeEach } from "vitest";
import { asDb, createMockDb, type MockDb } from "../test-utils.ts";
import { ValidationError } from "../errors.ts";

import { updateWidget } from "./dashboard.ts";

const workspaceId = "ws-1";
const dashboardId = "dash-1";
const widgetId = "widget-1";

/**
 * The `type`/`data` pairing asserted against the shared update path itself,
 * not through a surface.
 *
 * The Agent tool set and the REST route both reach this function, and the
 * guarantee is that neither can write a payload belonging to another Widget
 * type. Pinning it here is what keeps the check in the one place both callers
 * pass through: move it up into a route or a tool and this fails, even while
 * that surface's own tests still pass.
 */
describe("updateWidget", () => {
  let db: MockDb;

  const arrange = (storedType: string) => {
    db = createMockDb();
    db.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
    db.limit.mockResolvedValueOnce([
      { id: widgetId, dashboardId, type: storedType },
    ]);
  };

  const update = (type: string, data: unknown) =>
    updateWidget(asDb(db), dashboardId, widgetId, workspaceId, {
      type: type as "metric",
      data,
    });

  beforeEach(() => {
    db = createMockDb();
  });

  it("refuses a payload belonging to another widget type and writes nothing", async () => {
    arrange("metric");

    // Thrown, not returned: the rule has two callers, so it cannot answer in
    // one caller's response shape (ADR-0010). The route lets `onError` map it
    // to 400 and the Tool adapter turns it into its `{ error }` result.
    await expect(update("metric", { content: "hello" })).rejects.toThrow(
      ValidationError,
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("writes the payload as the named type's own schema resolved it", async () => {
    arrange("metric");
    db.returning.mockResolvedValueOnce([{ id: widgetId }]);

    await update("metric", { value: 1, label: "Revenue", stowaway: true });

    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ data: { value: 1, label: "Revenue" } }),
    );
  });
});
