export type FormErrors = Record<string, string>;

function isFieldOrSubPath(key: string, fieldId: string): boolean {
  return key === fieldId || key.startsWith(`${fieldId}.`);
}

export function parseValidationErrors(errorData: unknown): FormErrors {
  const errors: FormErrors = {};

  if (
    !errorData ||
    typeof errorData !== "object" ||
    !("error" in errorData) ||
    !Array.isArray(errorData.error)
  ) {
    return errors;
  }

  const issues: Array<{ path: string[]; message: string }> = [];
  for (const issue of errorData.error as unknown[]) {
    if (
      issue &&
      typeof issue === "object" &&
      "path" in issue &&
      Array.isArray(issue.path) &&
      issue.path.length > 0 &&
      "message" in issue &&
      typeof issue.message === "string"
    ) {
      issues.push({ path: issue.path.map(String), message: issue.message });
    }
  }

  for (const { path, message } of issues) {
    const key = path.join(".");
    if (!(key in errors)) errors[key] = message;
  }
  for (const { path, message } of issues) {
    if (!(path[0] in errors)) errors[path[0]] = message;
  }

  return errors;
}

export function retractFieldError(
  errors: FormErrors,
  fieldId: string,
): FormErrors {
  const remaining = Object.entries(errors).filter(
    ([key]) => !isFieldOrSubPath(key, fieldId),
  );

  if (remaining.length === Object.keys(errors).length) return errors;
  return Object.fromEntries(remaining);
}

export function retractExactKeys(
  errors: FormErrors,
  keys: readonly string[],
): FormErrors {
  const toRemove = new Set(keys);
  const remaining = Object.entries(errors).filter(
    ([key]) => !toRemove.has(key),
  );

  if (remaining.length === Object.keys(errors).length) return errors;
  return Object.fromEntries(remaining);
}

export function canSubmitForm(
  errors: FormErrors,
  retractableFieldIds: readonly string[],
): boolean {
  return !Object.keys(errors).some((key) =>
    retractableFieldIds.some((fieldId) => isFieldOrSubPath(key, fieldId)),
  );
}
