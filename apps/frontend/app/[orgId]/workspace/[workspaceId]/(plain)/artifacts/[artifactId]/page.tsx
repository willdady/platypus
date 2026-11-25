import type { Metadata } from "next";
import { ArtifactViewer } from "@/components/artifact-viewer";

export const metadata: Metadata = { title: "Artifact" };

async function ArtifactPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; artifactId: string }>;
}) {
  const { orgId, workspaceId, artifactId } = await params;

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <ArtifactViewer
        orgId={orgId}
        workspaceId={workspaceId}
        artifactId={artifactId}
        className="min-h-0 flex-1 rounded-lg border"
      />
    </div>
  );
}

export default ArtifactPage;
