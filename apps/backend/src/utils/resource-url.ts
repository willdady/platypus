/**
 * A link back into the web app for a resource a tool just wrote. `frontendUrl`
 * is `FRONTEND_URL` (`frontendBaseUrl()`), a required deployment setting, so a
 * link always exists.
 */
export function buildResourceUrl(
  frontendUrl: string,
  orgId: string,
  workspaceId: string,
  resourcePath: string,
): string {
  const base = frontendUrl.replace(/\/+$/, "");
  return `${base}/${orgId}/workspace/${workspaceId}/${resourcePath}`;
}
