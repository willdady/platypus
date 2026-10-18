import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Notice for the 3.x line; this whole route goes in v4.0.0 (#1430).
export default function DashboardsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-4 pt-4">
        <Alert>
          <TriangleAlert />
          <AlertTitle>Dashboards are deprecated</AlertTitle>
          <AlertDescription>
            Dashboards and their data are removed in the next major release,
            v4.0.0. Agents using the Dashboards tool set lose the{" "}
            <code>listDashboards</code>, <code>listWidgets</code> and{" "}
            <code>updateWidgetData</code> tools.
          </AlertDescription>
        </Alert>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
