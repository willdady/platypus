"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import type { SandboxUpload } from "@platypus/schemas";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { writeAt } from "@/lib/api-write";

export function useSandboxUploads(fileUrl: string) {
  const landed = useRef(new WeakMap<File, SandboxUpload>());
  const running = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState<{
    path: string;
    resolve: (overwrite: boolean) => void;
  } | null>(null);

  const put = (path: string, file: File, overwrite: boolean) => {
    const query = new URLSearchParams({ path });
    if (overwrite) query.set("overwrite", "true");
    return writeAt(`${fileUrl}?${query}`, { method: "PUT", data: file });
  };

  const confirmOverwrite = (path: string) =>
    new Promise<boolean>((resolve) =>
      setConflict({
        path,
        resolve: (overwrite) => {
          setConflict(null);
          resolve(overwrite);
        },
      }),
    );

  const upload = async (files: File[]): Promise<SandboxUpload[]> => {
    if (running.current) {
      toast.info("Still uploading to the Sandbox");
      throw new Error("Sandbox uploads already running");
    }
    if (!files.length) return [];
    running.current = true;
    setUploading(true);
    try {
      return await uploadEach(files);
    } finally {
      running.current = false;
      setUploading(false);
    }
  };

  const uploadEach = async (files: File[]): Promise<SandboxUpload[]> => {
    const uploads: SandboxUpload[] = [];
    for (const file of files) {
      let record = landed.current.get(file);
      if (!record) {
        const path = file.name;
        let result = await put(path, file, false);
        if (result.outcome === "conflict") {
          if (!(await confirmOverwrite(path))) {
            throw new Error(`Not overwriting ${path}`);
          }
          result = await put(path, file, true);
        }
        if (result.outcome !== "success") {
          toast.error(result.message);
          throw new Error(result.message);
        }
        record = { path, size: file.size };
        landed.current.set(file, record);
      }
      uploads.push(record);
    }
    return uploads;
  };

  const dialog = (
    <ConfirmDialog
      open={conflict !== null}
      onOpenChange={(open) => !open && conflict?.resolve(false)}
      title={`Overwrite ${conflict?.path}?`}
      description="A file already exists at this path in the Sandbox. Uploading replaces it."
      confirmLabel="Overwrite"
      confirmVariant="destructive"
      onConfirm={() => conflict?.resolve(true)}
    />
  );

  return { upload, uploading, dialog };
}
