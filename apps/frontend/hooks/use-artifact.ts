import type { ArtifactRead } from "@platypus/schemas";
import type { Scope } from "@/lib/api-write";
import { errorStatus } from "@/lib/utils";
import { useScopedSWR } from "./use-scoped-swr";

/**
 * The read key for one Artifact at a named version, or at its latest when no
 * version is named. Exported so a caller that pre-seeds or invalidates the
 * cache uses the same spelling the viewer reads.
 */
export function artifactEntity(artifactId: string, version?: number): string {
  return `artifacts/${artifactId}${
    version === undefined ? "" : `?version=${version}`
  }`;
}

/**
 * Reads one Artifact with one version. `scope: null` or no id withholds the
 * read — a streaming Tool card has no id yet, and a Chat with no Workspace
 * scope cannot read one.
 */
export function useArtifact(
  scope: Scope | null,
  artifactId: string | undefined,
  version?: number,
) {
  return useScopedSWR<ArtifactRead>(
    artifactEntity(artifactId ?? "", version),
    artifactId ? scope : null,
  );
}

/**
 * A 404 is a deleted Artifact, not a failed read: the Card and the viewer both
 * say so rather than showing an error. Every other failure stays an error.
 */
export function isArtifactDeleted(error: unknown): boolean {
  return errorStatus(error) === 404;
}
