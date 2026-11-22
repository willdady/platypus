"use client";

import { useRef, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { ARTIFACT_CONTENT_MAX_BYTES, type Artifact } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { useMutation } from "@/hooks/use-mutation";
import { writeEntity } from "@/lib/api-write";
import {
  artifactUploadFromFileName,
  decodeArtifactText,
} from "@/lib/artifact-file";
import { workspaceRoutes } from "@/lib/routes";
import { Button } from "./ui/button";

/**
 * The Artifacts page's Upload action. The browser reads the picked file, so
 * the refusal for a file over the limit or one that is not text lands without
 * a request; the create route checks both again, so a client that skipped the
 * checks cannot store a truncated or mangled document either. On success the
 * User lands on the new Artifact's page.
 */
export function ArtifactUploadButton({
  orgId,
  workspaceId,
  variant = "outline",
  onUploaded,
}: {
  orgId: string;
  workspaceId: string;
  variant?: ComponentProps<typeof Button>["variant"];
  /** Run after a successful create, before leaving for the new Artifact. */
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const routes = workspaceRoutes(orgId, workspaceId);

  const { run: upload, pending } = useMutation(async (file: File) => {
    const tooLarge = `${file.name} is larger than ${ARTIFACT_CONTENT_MAX_BYTES / 1024} KB`;
    if (file.size > ARTIFACT_CONTENT_MAX_BYTES) {
      toast.error(tooLarge);
      return;
    }

    const content = decodeArtifactText(
      new Uint8Array(await file.arrayBuffer()),
    );
    if (content === undefined) {
      toast.error(`${file.name} is not a text file`);
      return;
    }

    const { title, type, language } = artifactUploadFromFileName(file.name);
    const outcome = await writeEntity<"artifacts", Artifact>(
      backendUrl,
      "artifacts",
      { orgId, workspaceId },
      { data: { title, type, language, content } },
    );

    if (outcome.outcome !== "success") {
      toast.error(outcome.message);
      return;
    }

    toast.success("Artifact created");
    onUploaded();
    router.push(routes.artifacts.detail(outcome.data.id));
  });

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        aria-label="Choose a file to upload"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        variant={variant}
        onClick={() => inputRef.current?.click()}
        disabled={pending}
      >
        <Upload /> {pending ? "Uploading..." : "Upload"}
      </Button>
    </>
  );
}
