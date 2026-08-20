/**
 * Owns a form's server-side rejections end to end: parsing them off a failed
 * write, retracting one when the field it names is edited, and deciding
 * whether the form may submit.
 *
 * A form declares which field ids it can retract (its inputs) and never
 * needs to reason about the rest itself — an error keyed to anything else
 * (a field the form doesn't render, a cross-field rule with nowhere to
 * live) simply can't gate Save, because there would be no way to clear it
 * short of reloading.
 */

export type FormErrors = Record<string, string>;

function isFieldOrSubPath(key: string, fieldId: string): boolean {
  return key === fieldId || key.startsWith(`${fieldId}.`);
}

/**
 * Map a validation failure onto the fields that can show it.
 *
 * Each issue is keyed on its **full path**, dot-joined: a rule over a list
 * reports the row it failed on (`modelIds.2.alias`), so two bad rows produce
 * two messages the form can render in two places. Keyed on the first segment
 * alone, they overwrote each other — one message, one fix per round-trip.
 *
 * Every issue is *also* reported under its top-level field, because most forms
 * only know flat names. An error on the field itself wins that slot over one
 * derived from a row.
 */
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
  for (const issue of errorData.error) {
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

  // Exact paths first, so the top-level pass below can't take a slot an issue
  // on the field itself is entitled to.
  for (const { path, message } of issues) {
    const key = path.join(".");
    if (!(key in errors)) errors[key] = message;
  }
  for (const { path, message } of issues) {
    if (!(path[0] in errors)) errors[path[0]] = message;
  }

  return errors;
}

/**
 * Retract the error shown against a field, including any keyed at a path
 * *under* it — the edit that fixes a row is an edit to the field the row lives
 * in. Returns the original object when nothing matched, so a no-op leaves
 * state (and identity) untouched.
 */
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

/**
 * Retract exactly the given keys — no sub-path matching. For a row-scoped
 * edit inside a keyed group (e.g. one header row in `headers`), where
 * `retractFieldError(errors, "headers")` would sweep every sibling row under
 * the same top-level field. Returns the original object when nothing
 * matched, so a no-op leaves state (and identity) untouched.
 */
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

/**
 * A form may submit unless a *retractable* error is still outstanding — one
 * keyed to a field the form declared. A server-returned error with no
 * retracting field must never gate Save: editing can't clear it, so gating on
 * it would disable Save forever with no way out but reloading.
 */
export function canSubmitForm(
  errors: FormErrors,
  retractableFieldIds: readonly string[],
): boolean {
  return !Object.keys(errors).some((key) =>
    retractableFieldIds.some((fieldId) => isFieldOrSubPath(key, fieldId)),
  );
}
