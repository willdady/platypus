export function buildResourceUrl(
  frontendUrl: string,
  orgId: string,
  workspaceId: string,
  resourcePath: string,
): string {
  const base = frontendUrl.replace(/\/+$/, "");
  return `${base}/${orgId}/workspace/${workspaceId}/${resourcePath}`;
}
