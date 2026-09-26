"use client";

import { useState } from "react";
import { Box, Download, Upload } from "lucide-react";
import type { Sandbox } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { optionalFetcher } from "@/lib/utils";

const UNSUPPORTED = "This Sandbox backend doesn't support file transfer";

type Status = { ok: boolean; text: string } | null;

/**
 * Moves a file into or out of the Workspace's Sandbox directly, without the
 * model. Renders nothing when the Workspace has no Sandbox.
 */
export const SandboxCard = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const backendUrl = useBackendUrl();
  const scope = { orgId, workspaceId };
  const { data: sandbox } = useScopedSWR<Sandbox | null>("sandbox", scope, {
    fetcher: optionalFetcher,
  });
  const { data: backendsData } = useScopedSWR<{
    results: { backend: string; name: string }[];
  }>("sandbox-backends", { orgId });

  const [file, setFile] = useState<File | null>(null);
  const [dir, setDir] = useState("");
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [downloadPath, setDownloadPath] = useState("");

  if (!sandbox || !backendUrl) return null;

  const fileUrl = scopedUrl(backendUrl, "sandbox/file", scope);
  const backendName =
    backendsData?.results?.find((b) => b.backend === sandbox.backend)?.name ??
    sandbox.backend;

  const upload = async (path: string, overwrite: boolean) => {
    if (!file) return;
    setUploading(true);
    setStatus(null);
    const query = new URLSearchParams({ path });
    if (overwrite) query.set("overwrite", "true");
    const result = await writeAt(`${fileUrl}?${query}`, {
      method: "PUT",
      data: file,
    });
    setUploading(false);
    if (result.outcome === "conflict" && !overwrite) {
      setConflictPath(path);
      return;
    }
    setConflictPath(null);
    setStatus(
      result.outcome === "success"
        ? { ok: true, text: `Uploaded ${path}` }
        : { ok: false, text: result.message },
    );
  };

  const uploadPath = () => {
    const base = dir.trim().replace(/\/+$/, "");
    return base ? `${base}/${file!.name}` : file!.name;
  };

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Box className="size-4" /> Sandbox
        </CardTitle>
        <span className="text-sm text-muted-foreground">{backendName}</span>
      </CardHeader>
      <CardContent className="grid gap-6 px-4 md:grid-cols-2">
        <div className="space-y-2">
          {sandbox.transfer.upload ? (
            <>
              <Label htmlFor="sandbox-upload-file">File</Label>
              <Input
                id="sandbox-upload-file"
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <Label htmlFor="sandbox-upload-dir">Destination directory</Label>
              <div className="flex gap-2">
                <Input
                  id="sandbox-upload-dir"
                  placeholder="Workspace root"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!file || uploading}
                  onClick={() => upload(uploadPath(), false)}
                >
                  <Upload /> {uploading ? "Uploading..." : "Upload"}
                </Button>
              </div>
              {status && (
                <p
                  role="status"
                  className={
                    status.ok
                      ? "text-sm text-muted-foreground"
                      : "text-sm text-destructive"
                  }
                >
                  {status.text}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{UNSUPPORTED}</p>
          )}
        </div>
        <div className="space-y-2">
          {sandbox.transfer.download ? (
            <>
              <Label htmlFor="sandbox-download-path">Path</Label>
              <div className="flex gap-2">
                <Input
                  id="sandbox-download-path"
                  placeholder="output/report.pdf"
                  value={downloadPath}
                  onChange={(e) => setDownloadPath(e.target.value)}
                />
                {downloadPath.trim() ? (
                  <Button variant="outline" asChild>
                    <a
                      href={`${fileUrl}?${new URLSearchParams({ path: downloadPath.trim() })}`}
                    >
                      <Download /> Download
                    </a>
                  </Button>
                ) : (
                  <Button variant="outline" disabled>
                    <Download /> Download
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{UNSUPPORTED}</p>
          )}
        </div>
      </CardContent>
      <ConfirmDialog
        open={conflictPath !== null}
        onOpenChange={(open) => !open && setConflictPath(null)}
        title={`Overwrite ${conflictPath}?`}
        description="A file already exists at this path. Uploading replaces it."
        confirmLabel="Overwrite"
        confirmVariant="destructive"
        loading={uploading}
        onConfirm={() => conflictPath && upload(conflictPath, true)}
      />
    </Card>
  );
};
