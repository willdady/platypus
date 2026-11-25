export function formFieldIds(
  name: string,
  { description, error }: { description?: unknown; error?: unknown },
) {
  const descriptionId = `${name}-description`;
  const errorId = `${name}-error`;
  const describedBy = [description && descriptionId, error && errorId]
    .filter(Boolean)
    .join(" ");
  return {
    descriptionId,
    errorId,
    describedBy: describedBy || undefined,
  };
}
