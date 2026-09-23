import {
  widgetTypeRegistry,
  type Dashboard,
  type RglLayoutItem,
  type WidgetType,
  type WidgetTypeDefinition,
} from "@platypus/schemas";
import type { WriteOutcome } from "./api-write";

/**
 * Editing a Dashboard (issue #973): stage widget additions, deletions and
 * layout moves, then commit them with Save or undo them with Cancel.
 *
 * Neither commit is atomic — each is several writes, any of which can fail on
 * its own. So the session records which widget DELETEs have landed, and each
 * plan only returns what is still outstanding: a retry re-attempts what failed
 * and never re-sends a DELETE the server already applied.
 *
 * An added widget is created on the server immediately, so it is tracked here
 * only so Cancel can delete it again.
 */

export type Layouts = Pick<Dashboard, "desktopLayout" | "mobileLayout">;

export type LayoutTab = "desktop" | "mobile";

export type EditSession = Layouts & {
  /** Widgets the user trashed, plus any whose DELETE has landed. */
  readonly deletions: ReadonlySet<string>;
  /** Widgets created during this session. */
  readonly additions: ReadonlySet<string>;
  /** Widgets whose DELETE has landed on the server. */
  readonly deleted: ReadonlySet<string>;
};

const DEFAULT_MIN_W = 1;
const DEFAULT_MIN_H = 3;
/** Column count of the grid's `sm` breakpoint, i.e. a full-width mobile tile. */
const MOBILE_COLS = 2;
/** Mobile height for a layout item whose widget type is unknown. */
const FALLBACK_MOBILE_H = 5;

function definitionOf(
  type: WidgetType | undefined,
): WidgetTypeDefinition | undefined {
  return type ? widgetTypeRegistry[type] : undefined;
}

// Shared by the fallback and add-placement so a tile gets one height however
// it arrived in the mobile layout.
function mobileHeight(type: WidgetType | undefined): number {
  const definition = definitionOf(type);
  return Math.max(
    definition?.defaultSize.h ?? FALLBACK_MOBILE_H,
    definition?.minSize?.h ?? DEFAULT_MIN_H,
  );
}

const bottomOf = (items: readonly RglLayoutItem[]) =>
  items.reduce((max, item) => Math.max(max, item.y + item.h), 0);

/** A full-width stack of the desktop items, in desktop reading order. */
function mobileFallback(
  desktop: readonly RglLayoutItem[],
  widgetTypeById: ReadonlyMap<string, WidgetType>,
): RglLayoutItem[] {
  let y = 0;
  return [...desktop]
    .sort((a, b) => a.y - b.y)
    .map(({ i }) => {
      const h = mobileHeight(widgetTypeById.get(i));
      const placed = { i, x: 0, y, w: MOBILE_COLS, h };
      y += h;
      return placed;
    });
}

// Stamp the registry's per-type minimum onto each layout item at render time.
// Values are not stored in the DB; they are injected so the grid enforces them
// during resize. An absent type or axis falls back to the global minimum.
function withMinSize(
  items: readonly RglLayoutItem[],
  widgetTypeById: ReadonlyMap<string, WidgetType>,
): RglLayoutItem[] {
  return items.map((item) => {
    const minSize = definitionOf(widgetTypeById.get(item.i))?.minSize;
    return {
      ...item,
      minH: minSize?.h ?? DEFAULT_MIN_H,
      minW: minSize?.w ?? DEFAULT_MIN_W,
    };
  });
}

export function startEditSession(server: Layouts): EditSession {
  return {
    desktopLayout: server.desktopLayout,
    mobileLayout: server.mobileLayout,
    deletions: new Set(),
    additions: new Set(),
    deleted: new Set(),
  };
}

/**
 * Place a just-created widget at the bottom of both layouts. An empty mobile
 * layout means "follow the fallback", so it is materialised first — otherwise
 * the new widget would become the only item and the rest would lose their
 * mobile placement.
 */
export function stageAddition(
  session: EditSession,
  widget: { id: string; type: WidgetType },
  widgetTypeById: ReadonlyMap<string, WidgetType>,
): EditSession {
  const { w, h } = widgetTypeRegistry[widget.type].defaultSize;
  const mobile =
    session.mobileLayout.length > 0
      ? session.mobileLayout
      : mobileFallback(session.desktopLayout, widgetTypeById);
  return {
    ...session,
    desktopLayout: [
      ...session.desktopLayout,
      { i: widget.id, x: 0, y: bottomOf(session.desktopLayout), w, h },
    ],
    mobileLayout: [
      ...mobile,
      {
        i: widget.id,
        x: 0,
        y: bottomOf(mobile),
        w: MOBILE_COLS,
        h: mobileHeight(widget.type),
      },
    ],
    additions: new Set([...session.additions, widget.id]),
  };
}

export function stageDeletion(
  session: EditSession,
  widgetId: string,
): EditSession {
  return {
    ...session,
    desktopLayout: session.desktopLayout.filter((m) => m.i !== widgetId),
    mobileLayout: session.mobileLayout.filter((m) => m.i !== widgetId),
    deletions: new Set([...session.deletions, widgetId]),
  };
}

export function stageMove(
  session: EditSession,
  tab: LayoutTab,
  items: RglLayoutItem[],
): EditSession {
  return tab === "desktop"
    ? { ...session, desktopLayout: items }
    : { ...session, mobileLayout: items };
}

/**
 * Record a widget DELETE's outcome. `notFound` counts as landed: the goal —
 * the widget is gone — holds either way. A landed DELETE also leaves the
 * layouts, so a later Save does not persist an item for a widget that is gone.
 */
export function recordDeletion(
  session: EditSession,
  widgetId: string,
  outcome: WriteOutcome<unknown>["outcome"],
): EditSession {
  if (outcome !== "success" && outcome !== "notFound") return session;
  return {
    ...stageDeletion(session, widgetId),
    deleted: new Set([...session.deleted, widgetId]),
  };
}

/** Save's outstanding writes: these DELETEs, then the layout PUT. */
export function commitPlan(session: EditSession): {
  deletions: string[];
  layout: Layouts;
} {
  return {
    deletions: [...session.deletions].filter((id) => !session.deleted.has(id)),
    layout: {
      desktopLayout: session.desktopLayout,
      mobileLayout: session.mobileLayout,
    },
  };
}

/** Cancel's outstanding writes: a DELETE for each addition still on the server. */
export function cancelPlan(session: EditSession): string[] {
  return [...session.additions].filter((id) => !session.deleted.has(id));
}

/**
 * Deletions that landed during a Save which then failed. Cancel cannot undo
 * them (there is no undelete), so it has to say so. Undone additions are not
 * among them — removing those is what Cancel is for.
 */
export function savedDeletions(session: EditSession): string[] {
  return [...session.deleted].filter((id) => !session.additions.has(id));
}

/**
 * The layouts to render: the session's while editing, otherwise the server's,
 * with an empty mobile layout replaced by the fallback and each item's
 * registry minimum stamped on.
 */
export function effectiveLayouts(
  session: EditSession | null,
  server: Layouts,
  widgetTypeById: ReadonlyMap<string, WidgetType>,
): { desktop: RglLayoutItem[]; mobile: RglLayoutItem[] } {
  const { desktopLayout, mobileLayout } = session ?? server;
  return {
    desktop: withMinSize(desktopLayout, widgetTypeById),
    mobile: withMinSize(
      mobileLayout.length > 0
        ? mobileLayout
        : mobileFallback(desktopLayout, widgetTypeById),
      widgetTypeById,
    ),
  };
}
