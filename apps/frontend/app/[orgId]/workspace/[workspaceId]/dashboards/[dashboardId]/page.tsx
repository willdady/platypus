"use client";

import { use, useState, useCallback, useEffect, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { Markdown } from "@/components/markdown";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import Link from "next/link";
import { toast } from "sonner";
import { ResponsiveGridLayout } from "react-grid-layout";
import type { LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { cn } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import { useBackendUrl } from "@/components/auth-provider";
import {
  widgetTypeRegistry,
  type Dashboard,
  type Widget,
  type WidgetType,
  type WidgetTypeDefinition,
  type RglLayoutItem,
} from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  ChevronDown,
  InfoIcon,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Settings,
  Trash2,
  LayoutDashboard,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { widgetTypeUi } from "@/components/widgets";

// The add-widget picker in registry order. `Object.entries` widens the keys to
// `string`, so they are put back at their real type here.
const widgetTypeEntries = Object.entries(widgetTypeRegistry) as [
  WidgetType,
  (typeof widgetTypeRegistry)[WidgetType],
][];

// Static grid configuration. Hoisted so the `layouts` object handed to the grid
// keeps a stable identity across renders.
const GRID_BREAKPOINTS = { lg: 736, sm: 0 };
const GRID_COLS = { lg: 12, sm: 2 };
const GRID_CONTAINER_PADDING: [number, number] = [0, 0];
const DEFAULT_MIN_W = 1;
const DEFAULT_MIN_H = 3;

const WIDGET_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

function formatWidgetTimestamp(value: Date | string | number): string {
  return new Date(value).toLocaleString("sv-SE", WIDGET_TIMESTAMP_FORMAT);
}

// Stamp the registry's per-type minimum onto each layout item at render time.
// Values are not stored in the DB; they are injected so the grid enforces them
// during resize. An absent type or axis falls back to the global minimum.
function withMinSize(
  items: RglLayoutItem[],
  widgetTypeById: Map<string, WidgetType>,
): RglLayoutItem[] {
  return items.map((item) => {
    const type = widgetTypeById.get(item.i);
    const definition = type
      ? (widgetTypeRegistry[type] as WidgetTypeDefinition)
      : undefined;
    const minSize = definition?.minSize;
    return {
      ...item,
      minH: minSize?.h ?? DEFAULT_MIN_H,
      minW: minSize?.w ?? DEFAULT_MIN_W,
    };
  });
}

type WidgetTileProps = {
  widget: Widget;
  editMode: boolean;
  isEditing: boolean;
  isExpanded: boolean;
  onEditToggle: (widgetId: string) => void;
  onDelete: (widgetId: string) => void;
  onExpand: (widgetId: string) => void;
  onSave: (widget: Widget, data: object, title: string) => void;
};

/**
 * The contents of one dashboard tile, memoised so that editing or dragging one
 * Widget — which only changes that tile's `isEditing`/`isExpanded` — does not
 * re-render the rest.
 *
 * It deliberately renders *inside* the grid item rather than being the grid
 * item: react-grid-layout clones its direct children to position them, handing
 * each a fresh `style` object on every render. A tile that received that prop
 * could never bail out of `memo`, so the cheap positioning wrapper stays in the
 * page and the expensive content lives here.
 */
const WidgetTile = memo(function WidgetTile({
  widget,
  editMode,
  isEditing,
  isExpanded,
  onEditToggle,
  onDelete,
  onExpand,
  onSave,
}: WidgetTileProps) {
  const { icon: Icon, component: WidgetComponent } = widgetTypeUi[widget.type];

  return (
    <>
      {/* Widget header */}
      <div
        className={cn(
          "widget-drag-handle flex items-center justify-between px-3 pt-1.5 pb-0.5 shrink-0",
          editMode && "cursor-grab active:cursor-grabbing",
        )}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium truncate">{widget.title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {widget.type === "text" && !editMode && (
            <button
              className="hidden md:flex items-center justify-center h-6 w-6 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onExpand(widget.id)}
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          )}
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild onMouseDown={(e) => e.stopPropagation()}>
              <button
                className={cn(
                  "hidden items-center justify-center h-6 w-6 text-muted-foreground/50 hover:text-muted-foreground transition-colors",
                  !editMode && "md:flex",
                )}
              >
                <InfoIcon className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-left">
              <div>Created: {formatWidgetTimestamp(widget.createdAt)}</div>
              <div>Updated: {formatWidgetTimestamp(widget.updatedAt)}</div>
            </TooltipContent>
          </Tooltip>
          {editMode && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onEditToggle(widget.id)}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive hover:text-destructive"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onDelete(widget.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Widget body */}
      <div className={cn("flex-1 min-h-0", isExpanded && "invisible")}>
        <WidgetComponent
          widget={widget}
          editing={isEditing}
          onSave={(data, title) => onSave(widget, data, title)}
        />
      </div>
    </>
  );
});

// ─── Main page ──────────────────────────────────────────────────────────────

const DashboardPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; dashboardId: string }>;
}) => {
  const { orgId, workspaceId, dashboardId } = use(params);
  const backendUrl = useBackendUrl();
  const scope = useMemo(() => ({ orgId, workspaceId }), [orgId, workspaceId]);
  const widgetsEntity = `dashboards/${dashboardId}/widgets`;

  const [gridContainerEl, setGridContainerEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [gridWidth, setGridWidth] = useState(0);
  const [gridMounted, setGridMounted] = useState(false);

  // Why a callback ref instead of useRef:
  // The component returns null while the dashboard is loading, so the container
  // div doesn't exist on the first render. useEffect with [] would fire against
  // a null ref and never re-run. A callback ref (useState setter) fires exactly
  // when the element mounts, regardless of when that happens.
  useEffect(() => {
    if (!gridContainerEl) return;
    const measure = () => {
      // We measure the *outer* container (no padding) so that gridWidth
      // represents the true available container width. The p-4 padding is
      // applied on an inner wrapper div, not here. This keeps gridWidth in
      // sync with CSS breakpoints (e.g. isMobileViewport fires at exactly
      // 768px, matching the Tailwind md breakpoint).
      setGridWidth(gridContainerEl.getBoundingClientRect().width);
      setGridMounted(true);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(gridContainerEl);
    return () => ro.disconnect();
  }, [gridContainerEl]);

  // Mirrors the grid's lg breakpoint (see effectiveGridWidth / breakpoints below).
  const isMobileViewport = gridWidth > 0 && gridWidth < 768;

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [layoutTab, setLayoutTab] = useState<"desktop" | "mobile">("desktop");
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [expandedWidgetId, setExpandedWidgetId] = useState<string | null>(null);
  const [isInteracting, setIsInteracting] = useState(false);
  const [pendingDeletions, setPendingDeletions] = useState<Set<string>>(
    new Set(),
  );
  const [pendingAdditions, setPendingAdditions] = useState<Set<string>>(
    new Set(),
  );

  // Staged layout (only committed on Done)
  const [stagedDesktop, setStagedDesktop] = useState<RglLayoutItem[]>([]);
  const [stagedMobile, setStagedMobile] = useState<RglLayoutItem[]>([]);

  // Add widget dialog
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [newWidgetType, setNewWidgetType] = useState<WidgetType>("metric");
  const [newWidgetTitle, setNewWidgetTitle] = useState("");

  const { data: dashboard, mutate: mutateDashboard } = useScopedSWR<Dashboard>(
    `dashboards/${dashboardId}`,
    scope,
    {
      refreshInterval: editMode ? 0 : 5000,
    },
  );

  const { data: widgetsData, mutate: mutateWidgets } = useScopedSWR<{
    results: Widget[];
  }>(widgetsEntity, scope, {
    refreshInterval: editMode ? 0 : 5000,
  });

  // Also fetch all dashboards for the dropdown switcher. Deliberately not
  // polled: it only backs a menu, and polling it re-rendered the whole page
  // every 5s for a list the user is not looking at.
  const { data: allDashboardsData } = useScopedSWR<{ results: Dashboard[] }>(
    "dashboards",
    scope,
  );

  const widgets = useMemo(
    () =>
      (widgetsData?.results ?? []).filter((w) => !pendingDeletions.has(w.id)),
    [widgetsData, pendingDeletions],
  );
  const allDashboards = allDashboardsData?.results ?? [];

  // Enter edit mode: snapshot layouts and clear any prior staged changes
  const enterEditMode = () => {
    setStagedDesktop(dashboard?.desktopLayout ?? []);
    setStagedMobile(dashboard?.mobileLayout ?? []);
    setPendingDeletions(new Set());
    setPendingAdditions(new Set());
    setEditMode(true);
    if (widgets.length === 0) {
      setAddWidgetOpen(true);
    }
  };

  // Cancel: undo pending additions and discard all other staged changes
  const cancelEdit = async () => {
    if (backendUrl && pendingAdditions.size > 0) {
      const outcomes = await Promise.all(
        [...pendingAdditions].map((widgetId) =>
          writeEntity(backendUrl, widgetsEntity, scope, { id: widgetId }),
        ),
      );
      if (outcomes.some((outcome) => outcome.outcome !== "success")) {
        toast.error("Failed to cancel dashboard changes");
        return;
      }
      await mutateWidgets();
    }
    setPendingDeletions(new Set());
    setPendingAdditions(new Set());
    setEditMode(false);
    setEditingWidgetId(null);
  };

  // Done: execute pending deletions then persist layouts
  const saveEdit = async () => {
    if (!backendUrl || !dashboard) return;
    const deleteOutcomes = await Promise.all(
      [...pendingDeletions].map((widgetId) =>
        writeEntity(backendUrl, widgetsEntity, scope, { id: widgetId }),
      ),
    );
    if (deleteOutcomes.some((outcome) => outcome.outcome !== "success")) {
      toast.error("Failed to save dashboard changes");
      return;
    }
    const layoutOutcome = await writeEntity(
      backendUrl,
      "dashboards",
      { orgId, workspaceId },
      {
        id: dashboardId,
        data: {
          desktopLayout: stagedDesktop,
          mobileLayout: stagedMobile,
        },
      },
    );
    if (layoutOutcome.outcome !== "success") {
      toast.error("Failed to save dashboard changes");
      return;
    }
    await Promise.all([mutateWidgets(), mutateDashboard()]);
    setPendingDeletions(new Set());
    setPendingAdditions(new Set());
    setEditMode(false);
    setEditingWidgetId(null);
  };

  // Sync layout only on user drag/resize stop to avoid the grid overwriting
  // explicit heights we set when adding new widgets.
  const syncLayout = useCallback(
    (layout: readonly LayoutItem[]) => {
      const items = layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
      if (layoutTab === "desktop") {
        setStagedDesktop(items);
      } else {
        setStagedMobile(items);
      }
    },
    [layoutTab],
  );

  // Add a widget
  const [addWidgetError, setAddWidgetError] = useState<string | null>(null);
  const handleAddWidget = async () => {
    if (!backendUrl || !newWidgetTitle.trim()) return;
    setAddWidgetError(null);
    const outcome = await writeEntity<Widget>(
      backendUrl,
      widgetsEntity,
      scope,
      { data: { type: newWidgetType, title: newWidgetTitle } },
    );
    if (outcome.outcome === "conflict") {
      setAddWidgetError(outcome.message);
      return;
    }
    if (outcome.outcome !== "success") {
      toast.error("Failed to add widget");
      return;
    }
    const widget = outcome.data;

    // Track as pending so Cancel can delete it from the API.
    setPendingAdditions((prev) => new Set([...prev, widget.id]));

    // Fetch the updated widget list first so the child element exists in the
    // DOM before we add the layout item — if the layout item appears with no
    // matching child the grid discards it and assigns a default (tiny) size.
    await mutateWidgets();

    const { w: dw, h: dh } = widgetTypeRegistry[newWidgetType].defaultSize;

    const maxY = stagedDesktop.reduce(
      (m, item) => Math.max(m, item.y + item.h),
      0,
    );
    setStagedDesktop((prev) => [
      ...prev,
      { i: widget.id, x: 0, y: maxY, w: dw, h: dh },
    ]);

    const maxYMobile = stagedMobile.reduce(
      (m, item) => Math.max(m, item.y + item.h),
      0,
    );
    setStagedMobile((prev) => [
      ...prev,
      { i: widget.id, x: 0, y: maxYMobile, w: 2, h: dh },
    ]);

    setAddWidgetOpen(false);
    setNewWidgetTitle("");
    setNewWidgetType("metric");
  };

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedWidgetId(null);
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, []);

  // Stage a widget deletion — only committed to the API when the user clicks Done
  const handleDeleteWidget = useCallback((widgetId: string) => {
    setPendingDeletions((prev) => new Set([...prev, widgetId]));
    setStagedDesktop((prev) => prev.filter((item) => item.i !== widgetId));
    setStagedMobile((prev) => prev.filter((item) => item.i !== widgetId));
    setEditingWidgetId((prev) => (prev === widgetId ? null : prev));
  }, []);

  const handleEditToggle = useCallback((widgetId: string) => {
    setEditingWidgetId((prev) => (prev === widgetId ? null : widgetId));
  }, []);

  const handleExpand = useCallback((widgetId: string) => {
    setExpandedWidgetId(widgetId);
  }, []);

  // Save widget data inline
  const handleSaveWidgetData = useCallback(
    async (widget: Widget, data: object, title: string) => {
      if (!backendUrl) return;
      const outcome = await writeEntity(backendUrl, widgetsEntity, scope, {
        id: widget.id,
        data: { type: widget.type, data, title },
      });
      if (outcome.outcome !== "success") {
        toast.error("Failed to save widget");
        return;
      }
      await mutateWidgets();
      setEditingWidgetId(null);
    },
    [backendUrl, scope, widgetsEntity, mutateWidgets],
  );

  // Per-type minimum sizes live in the registry (see `withMinSize`).
  const widgetTypeById = useMemo(
    () => new Map(widgets.map((w) => [w.id, w.type])),
    [widgets],
  );

  // Compute the effective layout for display
  const serverDesktopLayout = useMemo(
    () => dashboard?.desktopLayout ?? [],
    [dashboard],
  );
  const serverMobileLayout = useMemo(
    () => dashboard?.mobileLayout ?? [],
    [dashboard],
  );
  const effectiveDesktopLayout = useMemo(
    () =>
      withMinSize(
        editMode ? stagedDesktop : serverDesktopLayout,
        widgetTypeById,
      ),
    [editMode, stagedDesktop, serverDesktopLayout, widgetTypeById],
  );

  // For mobile fallback: sort by desktop y if mobileLayout is empty
  const rawMobileLayout = editMode ? stagedMobile : serverMobileLayout;
  const effectiveMobileLayout = useMemo(
    () =>
      withMinSize(
        rawMobileLayout.length > 0
          ? rawMobileLayout
          : [...effectiveDesktopLayout]
              .sort((a, b) => a.y - b.y)
              .map((item, idx) => ({ ...item, x: 0, y: idx * 5, w: 2, h: 5 })),
        widgetTypeById,
      ),
    [rawMobileLayout, effectiveDesktopLayout, widgetTypeById],
  );

  const activeLayout = isMobileViewport
    ? effectiveMobileLayout
    : effectiveDesktopLayout;
  // When editing the mobile layout on a desktop viewport, render a narrow
  // phone-shaped preview so the 2-column sm grid is clearly visible.
  const isMobilePreview = editMode && layoutTab === "mobile";

  // Memoised so the grid keeps a stable identity for this prop. `lg` is the
  // layout in view; `sm` always backs the mobile grid.
  const layouts = useMemo(
    () => ({
      lg: editMode
        ? layoutTab === "desktop"
          ? effectiveDesktopLayout
          : effectiveMobileLayout
        : activeLayout,
      sm: effectiveMobileLayout,
    }),
    [
      editMode,
      layoutTab,
      effectiveDesktopLayout,
      effectiveMobileLayout,
      activeLayout,
    ],
  );

  const handleInteractionStart = useCallback(() => setIsInteracting(true), []);
  const handleInteractionStop = useCallback(
    (layout: readonly LayoutItem[]) => {
      setIsInteracting(false);
      syncLayout(layout);
    },
    [syncLayout],
  );

  // Sizing chain (keep these in sync if you change padding):
  //
  //   gridWidth          — outer container width, no padding (raw measurement)
  //   effectiveGridWidth — width passed to <ResponsiveGridLayout width={...}>
  //
  // Normal layout:
  //   The grid renders inside a div with p-4 (16px each side = 32px total).
  //   We subtract that from gridWidth so the grid fills the padded area without
  //   overflowing the right edge.
  //   effectiveGridWidth = gridWidth - 32
  //
  //   The react-grid-layout `lg` breakpoint is set to 736 (not 768) because the
  //   grid compares its own width (effectiveGridWidth) against the breakpoint:
  //     gridWidth 768 → effectiveGridWidth 736 → uses lg  ✓
  //     gridWidth 767 → effectiveGridWidth 735 → uses sm  ✓
  //   This keeps the layout switch in sync with isMobileViewport (< 768) and
  //   the Tailwind md breakpoint (also 768px).
  //
  // Mobile preview:
  //   Phone container is 390px wide with p-4 padding, so the grid gets 358px.
  //   The grid width is below the lg breakpoint, so it always uses sm (2 cols).
  const MOBILE_GRID_WIDTH = 390 - 32; // 358px — phone container minus p-4
  const effectiveGridWidth = isMobilePreview
    ? MOBILE_GRID_WIDTH
    : Math.max(0, gridWidth - 32);

  if (!dashboard) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-8 w-16 rounded-md" />
        </div>
        <div className="flex-1 overflow-auto p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="md:col-span-2 h-48 rounded-lg" />
            <Skeleton className="h-48 rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 text-xl font-bold truncate hover:text-muted-foreground transition-colors cursor-pointer min-w-0 max-w-[300px]">
                <span className="truncate">{dashboard.name}</span>
                <ChevronDown className="h-4 w-4 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {allDashboards
                .filter((d) => d.id !== dashboardId)
                .map((d) => (
                  <DropdownMenuItem key={d.id} asChild>
                    <Link
                      href={`/${orgId}/workspace/${workspaceId}/dashboards/${d.id}`}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <LayoutDashboard className="h-4 w-4" />
                      <span className="truncate">{d.name}</span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link
                  href={`/${orgId}/workspace/${workspaceId}/dashboards/create`}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create new dashboard</span>
                </Link>
              </DropdownMenuItem>
              {allDashboards.filter((d) => d.id !== dashboardId).length ===
                0 && (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No other dashboards
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          {editMode ? (
            <>
              <Tabs
                value={layoutTab}
                onValueChange={(v) => setLayoutTab(v as "desktop" | "mobile")}
              >
                <TabsList>
                  <TabsTrigger value="desktop">Desktop</TabsTrigger>
                  <TabsTrigger value="mobile">Mobile</TabsTrigger>
                </TabsList>
              </Tabs>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAddWidgetOpen(true)}
              >
                <Plus className="h-4 w-4" /> Add widget
              </Button>
              <Button variant="outline" size="sm" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button size="sm" onClick={saveEdit}>
                Save
              </Button>
            </>
          ) : (
            <>
              {!isMobileViewport && (
                <Button variant="outline" size="sm" onClick={enterEditMode}>
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
              )}
              <Link
                href={`/${orgId}/workspace/${workspaceId}/dashboards/${dashboardId}/settings`}
                aria-label="Dashboard settings"
                className="p-2 hover:bg-muted rounded-md transition-colors shrink-0"
              >
                <Settings className="h-5 w-5 text-muted-foreground" />
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Grid */}
      <div
        ref={setGridContainerEl}
        className={cn(
          "flex-1 overflow-auto",
          isMobilePreview && "bg-black flex justify-center p-8",
          isInteracting && "select-none",
        )}
      >
        {widgets.length === 0 && !editMode ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4 p-4 text-muted-foreground">
            <LayoutDashboard className="h-12 w-12 opacity-30" />
            <p>No widgets yet. Click Edit to add some.</p>
          </div>
        ) : gridMounted ? (
          <div
            className={cn(
              isMobilePreview
                ? "w-[390px] shrink-0 bg-background rounded-3xl overflow-hidden shadow-2xl ring-1 ring-white/10 p-4 self-start"
                : "p-4",
            )}
          >
            <ResponsiveGridLayout
              width={effectiveGridWidth}
              className="layout"
              layouts={layouts}
              // lg: 736 = 768 (desired breakpoint) - 32 (p-4 wrapper padding).
              // See the "Sizing chain" comment above effectiveGridWidth.
              breakpoints={GRID_BREAKPOINTS}
              cols={GRID_COLS}
              containerPadding={GRID_CONTAINER_PADDING}
              rowHeight={30}
              dragConfig={{
                enabled: editMode && !isMobileViewport,
                handle: ".widget-drag-handle",
              }}
              resizeConfig={{ enabled: editMode && !isMobileViewport }}
              onDragStart={handleInteractionStart}
              onDragStop={handleInteractionStop}
              onResizeStart={handleInteractionStart}
              onResizeStop={handleInteractionStop}
            >
              {widgets.map((widget) => (
                <div
                  key={widget.id}
                  className={cn(
                    "rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden flex flex-col",
                    editMode && "ring-1 ring-border",
                  )}
                >
                  <WidgetTile
                    widget={widget}
                    editMode={editMode}
                    isEditing={editingWidgetId === widget.id}
                    isExpanded={expandedWidgetId === widget.id}
                    onEditToggle={handleEditToggle}
                    onDelete={handleDeleteWidget}
                    onExpand={handleExpand}
                    onSave={handleSaveWidgetData}
                  />
                </div>
              ))}
            </ResponsiveGridLayout>
          </div>
        ) : null}
      </div>

      {/* Add Widget Dialog */}
      <Dialog
        open={addWidgetOpen}
        onOpenChange={(open) => {
          setAddWidgetOpen(open);
          if (!open) setAddWidgetError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Widget</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={newWidgetType}
                onValueChange={(v) => setNewWidgetType(v as WidgetType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {widgetTypeEntries.map(([value, { label }]) => {
                    const Icon = widgetTypeUi[value].icon;
                    return (
                      <SelectItem key={value} value={value}>
                        <span className="flex items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          {label}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={newWidgetTitle}
                onChange={(e) => setNewWidgetTitle(e.target.value)}
                placeholder="Widget title"
              />
            </div>
          </div>
          {addWidgetError && (
            <p className="text-sm text-destructive">{addWidgetError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddWidgetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddWidget} disabled={!newWidgetTitle.trim()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Markdown widget expand overlay */}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {expandedWidgetId !== null &&
              (() => {
                const expandedWidget = widgets.find(
                  (w) => w.id === expandedWidgetId,
                );
                if (!expandedWidget) return null;
                const expandedData = expandedWidget.data as
                  { content: string } | null | undefined;
                return (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
                      onClick={() => setExpandedWidgetId(null)}
                    />
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.2 }}
                      className="relative w-full max-w-5xl h-full max-h-[80vh] bg-background rounded-lg border shadow-2xl flex flex-col p-4"
                    >
                      <div className="flex justify-between items-center mb-4 shrink-0">
                        <span className="text-sm font-medium">
                          {expandedWidget.title}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6 cursor-pointer text-muted-foreground"
                          onClick={() => setExpandedWidgetId(null)}
                        >
                          <Minimize2 className="size-3.5" />
                          <span className="sr-only">Collapse</span>
                        </Button>
                      </div>
                      <div className="flex-1 min-h-0 overflow-auto">
                        {expandedData?.content ? (
                          <Markdown>{expandedData.content}</Markdown>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">
                            No content yet
                          </p>
                        )}
                      </div>
                    </motion.div>
                  </div>
                );
              })()}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
};

export default DashboardPage;
