/**
 * The ids a `Form*Field` gives its description and error, and the
 * `aria-describedby` that ties both to the control — so a screen reader reads
 * the help text and the error with the field, not only `aria-invalid`.
 */
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
