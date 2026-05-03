"use client";

import { use, useState, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useSWR from "swr";
import Link from "next/link";
import { ResponsiveGridLayout } from "react-grid-layout";
import type { LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { fetcher, joinUrl, cn } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import {
  type Dashboard,
  type Widget,
  type WidgetType,
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
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronDown,
  ImageIcon,
  InfoIcon,
  Pencil,
  Plus,
  Settings,
  Trash2,
  X,
  Check,
  LayoutDashboard,
  Hash,
  AlignLeft,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ─── Widget display components ──────────────────────────────────────────────

function MetricWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as
    | { value: number; label: string; unit?: string; change?: string }
    | null
    | undefined;
  const [title, setTitle] = useState(widget.title);
  const [value, setValue] = useState(String(data?.value ?? ""));
  const [label, setLabel] = useState(data?.label ?? "");
  const [unit, setUnit] = useState(data?.unit ?? "");
  const [change, setChange] = useState(data?.change ?? "");

  useEffect(() => {
    setTitle(widget.title);
  }, [widget.title]);

  useEffect(() => {
    setValue(String(data?.value ?? ""));
    setLabel(data?.label ?? "");
    setUnit(data?.unit ?? "");
    setChange(data?.change ?? "");
  }, [data?.value, data?.label, data?.unit, data?.change]);

  if (editing) {
    return (
      <div className="flex flex-col gap-2 p-3 h-full overflow-auto">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Value</Label>
            <Input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-7 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Unit</Label>
            <Input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="%, $, …"
              className="h-7 text-sm"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Label</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Change indicator</Label>
          <Input
            value={change}
            onChange={(e) => setChange(e.target.value)}
            placeholder="+5% vs last week"
            className="h-7 text-sm"
          />
        </div>
        <Button
          size="sm"
          className="mt-auto"
          onClick={() =>
            onSave(
              {
                value: Number(value),
                label,
                ...(unit && { unit }),
                ...(change && { change }),
              },
              title,
            )
          }
        >
          <Check className="h-3 w-3" /> Save
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col justify-center items-start p-4 h-full"
      style={{ containerType: "size" }}
    >
      {data ? (
        <>
          <div className="font-bold text-[60cqh] leading-none">
            {data.value}
            {data.unit && (
              <span
                className={cn(
                  "font-normal",
                  data.unit === "°"
                    ? "ml-[0.05em] text-[60cqh] align-top"
                    : "ml-[0.3em] text-[36cqh]",
                )}
              >
                {data.unit}
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground mt-1">{data.label}</div>
          {data.change && (
            <div className="text-xs text-muted-foreground mt-1">
              {data.change}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground italic">No data yet</p>
      )}
    </div>
  );
}

function TextWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as { content: string } | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [content, setContent] = useState(data?.content ?? "");

  useEffect(() => {
    setTitle(widget.title);
  }, [widget.title]);

  useEffect(() => {
    setContent(data?.content ?? "");
  }, [data?.content]);

  if (editing) {
    return (
      <div className="flex flex-col gap-2 p-3 h-full">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Markdown content…"
          className="flex-1 min-h-0 resize-none text-sm font-mono"
        />
        <Button size="sm" onClick={() => onSave({ content }, title)}>
          <Check className="h-3 w-3" /> Save
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 h-full overflow-auto prose prose-sm dark:prose-invert max-w-none">
      {data?.content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {data.content}
        </ReactMarkdown>
      ) : (
        <p className="text-sm text-muted-foreground italic">No content yet</p>
      )}
    </div>
  );
}

function ImageWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as { url: string } | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [url, setUrl] = useState(data?.url ?? "");

  useEffect(() => {
    setTitle(widget.title);
  }, [widget.title]);

  useEffect(() => {
    setUrl(data?.url ?? "");
  }, [data?.url]);

  if (editing) {
    return (
      <div className="flex flex-col gap-2 p-3 h-full">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Image URL</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or data:image/…"
            className="h-7 text-sm"
          />
        </div>
        <Button
          size="sm"
          className="mt-auto"
          onClick={() => onSave({ url }, title)}
        >
          <Check className="h-3 w-3" /> Save
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-2">
      {data?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.url}
          alt={widget.title}
          className="w-full h-full object-contain"
        />
      ) : (
        <p className="text-sm text-muted-foreground italic">No image yet</p>
      )}
    </div>
  );
}

const widgetTypeIcon = {
  metric: Hash,
  text: AlignLeft,
  image: ImageIcon,
} as const;

const widgetTypeComponent = {
  metric: MetricWidget,
  text: TextWidget,
  image: ImageWidget,
} as const;

// ─── Main page ───────────────────────────────────────────────────────────────

const DashboardPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; dashboardId: string }>;
}) => {
  const { orgId, workspaceId, dashboardId } = use(params);
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

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

  const dashUrl =
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}`,
        )
      : null;

  const { data: dashboard, mutate: mutateDashboard } = useSWR<Dashboard>(
    dashUrl,
    fetcher,
    { refreshInterval: editMode ? 0 : 5000 },
  );

  const { data: widgetsData, mutate: mutateWidgets } = useSWR<{
    results: Widget[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}/widgets`,
        )
      : null,
    fetcher,
    { refreshInterval: editMode ? 0 : 5000 },
  );

  // Also fetch all dashboards for the dropdown switcher
  const { data: allDashboardsData } = useSWR<{ results: Dashboard[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards`,
        )
      : null,
    fetcher,
    { refreshInterval: editMode ? 0 : 5000 },
  );

  const widgets = (widgetsData?.results ?? []).filter(
    (w) => !pendingDeletions.has(w.id),
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
      await Promise.all(
        [...pendingAdditions].map((widgetId) =>
          fetch(
            joinUrl(
              backendUrl,
              `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}/widgets/${widgetId}`,
            ),
            { method: "DELETE", credentials: "include" },
          ),
        ),
      );
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
    await Promise.all(
      [...pendingDeletions].map((widgetId) =>
        fetch(
          joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}/widgets/${widgetId}`,
          ),
          { method: "DELETE", credentials: "include" },
        ),
      ),
    );
    await fetch(
      joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}`,
      ),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          desktopLayout: stagedDesktop,
          mobileLayout: stagedMobile,
        }),
      },
    );
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
    const res = await fetch(
      joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}/widgets`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ type: newWidgetType, title: newWidgetTitle }),
      },
    );
    if (res.status === 409) {
      const body = await res.json();
      setAddWidgetError(body.error);
      return;
    }
    if (!res.ok) return;
    const widget: Widget = await res.json();

    // Track as pending so Cancel can delete it from the API.
    setPendingAdditions((prev) => new Set([...prev, widget.id]));

    // Fetch the updated widget list first so the child element exists in the
    // DOM before we add the layout item — if the layout item appears with no
    // matching child the grid discards it and assigns a default (tiny) size.
    await mutateWidgets();

    // rowHeight=30 — each unit is 30px + 10px margin = 40px effective.
    // h values are ~1.5× the old rowHeight=60 defaults to keep similar visual sizes:
    //   metric h=5  → 5×30 + 4×10 = 190px  (≈ old h=3 at 200px)
    //   text   h=7  → 7×30 + 6×10 = 270px  (≈ old h=4 at 270px)
    // All h values must be >= 3 (the global minH enforced by withMinH).
    const defaultSize: Record<string, { w: number; h: number }> = {
      metric: { w: 3, h: 5 },
      text: { w: 6, h: 7 },
      image: { w: 4, h: 7 },
    };
    const { w: dw, h: dh } = defaultSize[newWidgetType] ?? { w: 4, h: 3 };

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

  // Stage a widget deletion — only committed to the API when the user clicks Done
  const handleDeleteWidget = (widgetId: string) => {
    setPendingDeletions((prev) => new Set([...prev, widgetId]));
    setStagedDesktop((prev) => prev.filter((item) => item.i !== widgetId));
    setStagedMobile((prev) => prev.filter((item) => item.i !== widgetId));
    setEditingWidgetId((prev) => (prev === widgetId ? null : prev));
  };

  // Save widget data inline
  const handleSaveWidgetData = async (
    widget: Widget,
    data: object,
    title: string,
  ) => {
    if (!backendUrl) return;
    await fetch(
      joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/dashboards/${dashboardId}/widgets/${widget.id}`,
      ),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ type: widget.type, data, title }),
      },
    );
    await mutateWidgets();
    setEditingWidgetId(null);
  };

  // Stamp minH onto every layout item at render time. This is a constant
  // constraint (the widget header alone occupies ~1 row) so we don't store it
  // in the DB — we inject it here so the grid enforces it during resize.
  const withMinH = (items: RglLayoutItem[]) =>
    items.map((item) => ({ ...item, minH: 3 }));

  // Compute the effective layout for display
  const effectiveDesktopLayout = withMinH(
    editMode ? stagedDesktop : (dashboard?.desktopLayout ?? []),
  );

  // For mobile fallback: sort by desktop y if mobileLayout is empty
  const rawMobileLayout = editMode
    ? stagedMobile
    : (dashboard?.mobileLayout ?? []);
  const effectiveMobileLayout = withMinH(
    rawMobileLayout.length > 0
      ? rawMobileLayout
      : [...effectiveDesktopLayout]
          .sort((a, b) => a.y - b.y)
          .map((item, idx) => ({ ...item, x: 0, y: idx * 5, w: 2, h: 5 })),
  );

  const activeLayout = isMobileViewport
    ? effectiveMobileLayout
    : effectiveDesktopLayout;
  const editableLayout =
    layoutTab === "desktop" ? effectiveDesktopLayout : effectiveMobileLayout;

  // When editing the mobile layout on a desktop viewport, render a narrow
  // phone-shaped preview so the 2-column sm grid is clearly visible.
  const isMobilePreview = editMode && layoutTab === "mobile";

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
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="col-span-1 h-32 rounded-lg" />
            <Skeleton className="col-span-1 h-32 rounded-lg" />
            <Skeleton className="col-span-1 h-32 rounded-lg" />
            <Skeleton className="col-span-2 h-48 rounded-lg" />
            <Skeleton className="col-span-1 h-48 rounded-lg" />
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
                <Plus className="h-4 w-4" /> Add Widget
              </Button>
              <Button variant="outline" size="sm" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button size="sm" onClick={saveEdit}>
                Done
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
              layouts={{
                lg: editMode
                  ? layoutTab === "desktop"
                    ? effectiveDesktopLayout
                    : effectiveMobileLayout
                  : activeLayout,
                sm: effectiveMobileLayout,
              }}
              // lg: 736 = 768 (desired breakpoint) - 32 (p-4 wrapper padding).
              // See the "Sizing chain" comment above effectiveGridWidth.
              breakpoints={{ lg: 736, sm: 0 }}
              cols={{ lg: 12, sm: 2 }}
              containerPadding={[0, 0]}
              rowHeight={30}
              dragConfig={{
                enabled: editMode && !isMobileViewport,
                handle: ".widget-drag-handle",
              }}
              resizeConfig={{ enabled: editMode && !isMobileViewport }}
              onDragStart={() => setIsInteracting(true)}
              onDragStop={(layout) => {
                setIsInteracting(false);
                syncLayout(layout);
              }}
              onResizeStart={() => setIsInteracting(true)}
              onResizeStop={(layout) => {
                setIsInteracting(false);
                syncLayout(layout);
              }}
            >
              {widgets.map((widget) => {
                const isEditing = editingWidgetId === widget.id;
                return (
                  <div
                    key={widget.id}
                    className={cn(
                      "rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden flex flex-col",
                      editMode && "ring-1 ring-border",
                    )}
                  >
                    {/* Widget header */}
                    <div
                      className={cn(
                        "widget-drag-handle flex items-center justify-between px-3 pt-1.5 pb-0.5 bg-muted/30 shrink-0",
                        editMode && "cursor-grab active:cursor-grabbing",
                      )}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {(() => {
                          const Icon =
                            widgetTypeIcon[
                              widget.type as keyof typeof widgetTypeIcon
                            ];
                          return Icon ? (
                            <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : null;
                        })()}
                        <span className="text-xs font-medium truncate">
                          {widget.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Tooltip delayDuration={500}>
                          <TooltipTrigger
                            asChild
                            onMouseDown={(e) => e.stopPropagation()}
                          >
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
                            <div>
                              Created:{" "}
                              {new Date(widget.createdAt).toLocaleString(
                                "sv-SE",
                                {
                                  year: "numeric",
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </div>
                            <div>
                              Updated:{" "}
                              {new Date(widget.updatedAt).toLocaleString(
                                "sv-SE",
                                {
                                  year: "numeric",
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                        {editMode && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() =>
                                setEditingWidgetId(isEditing ? null : widget.id)
                              }
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-destructive hover:text-destructive"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() => handleDeleteWidget(widget.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Widget body */}
                    <div className="flex-1 min-h-0">
                      {(() => {
                        const WidgetComponent =
                          widgetTypeComponent[
                            widget.type as keyof typeof widgetTypeComponent
                          ];
                        return WidgetComponent ? (
                          <WidgetComponent
                            widget={widget}
                            editing={isEditing}
                            onSave={(data, title) =>
                              handleSaveWidgetData(widget, data, title)
                            }
                          />
                        ) : null;
                      })()}
                    </div>
                  </div>
                );
              })}
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
                  <SelectItem value="metric">Metric</SelectItem>
                  <SelectItem value="text">Text / Markdown</SelectItem>
                  <SelectItem value="image">Image</SelectItem>
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
    </div>
  );
};

export default DashboardPage;
