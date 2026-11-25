import type { ArtifactRead, ArtifactVersionList } from "@platypus/schemas";
import { scopedUrl, type Scope, type Serialized } from "@/lib/api-write";
import { errorStatus, fetcher } from "@/lib/utils";
import { useScopedSWR } from "./use-scoped-swr";

export function artifactEntity(artifactId: string, version?: number): string {
  return `artifacts/${artifactId}${
    version === undefined ? "" : `?version=${version}`
  }`;
}

export function artifactVersionsEntity(artifactId: string): string {
  return `artifacts/${artifactId}/versions`;
}

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

export function useArtifactVersions(
  scope: Scope | null,
  artifactId: string | undefined,
) {
  return useScopedSWR<ArtifactVersionList>(
    artifactVersionsEntity(artifactId ?? ""),
    artifactId ? scope : null,
  );
}

export function useStoredArtifact(
  stored: { id: string; version: number } | undefined,
  scope?: Scope | null,
) {
  const { data, error } = useArtifact(
    stored ? (scope ?? null) : null,
    stored?.id,
    stored?.version,
  );
  return { data, deleted: stored !== undefined && isArtifactDeleted(error) };
}

export function isArtifactDeleted(error: unknown): boolean {
  return errorStatus(error) === 404;
}

export function readArtifact(
  backendUrl: string,
  scope: Scope,
  artifactId: string,
  version?: number,
): Promise<Serialized<ArtifactRead>> {
  return fetcher<Serialized<ArtifactRead>>(
    scopedUrl(backendUrl, artifactEntity(artifactId, version), scope),
  );
}
