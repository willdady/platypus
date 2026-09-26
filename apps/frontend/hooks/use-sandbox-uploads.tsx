"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import type { SandboxUpload } from "@platypus/schemas";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { writeAt } from "@/lib/api-write";

/**
 * Places a message's Sandbox uploads in the Sandbox before the message is sent
 * (ADR-0028). Each file lands at the Sandbox root under its own name. A taken
 * path asks the User before overwriting; a cancel or any other failure rejects,
 * so the Send stops and the chips stay.
 *
 * A file that landed is remembered by its `File` object, which its chip holds
 * across retries, so a retried Send uploads only what has not landed and never
 * asks to overwrite a file it just uploaded.
 */
export const useSandboxUploads = (fileUrl: string) => {
  const landed = useRef(new WeakMap<File, SandboxUpload>());
  const running = useRef(false);
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
    // A second Send while the first is still uploading would put the same
    // files again, and ask to overwrite what the first just placed.
    if (running.current) throw new Error("Sandbox uploads already running");
    running.current = true;
    try {
      return await uploadEach(files);
    } finally {
      running.current = false;
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
        record = { path, filename: file.name, size: file.size };
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

  return { upload, dialog };
};
