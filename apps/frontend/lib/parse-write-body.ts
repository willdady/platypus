import type { z } from "zod";
import type { WriteOutcome } from "./api-write";
import { parseValidationErrors } from "./form-errors";

/** The outcome a backend 400 produces, reused so the two shapes can't drift. */
type InvalidOutcome = Extract<
  WriteOutcome<never>,
  { readonly outcome: "invalid" }
>;

/**
 * Checks a clone's runtime-built create body against the entity's strict
 * create schema. `Object.fromEntries` erases its keys, so the compiler cannot
 * see a body the backend would refuse; answer as a refused create instead of
 * sending one.
 *
 * The refusal carries the schema's issues keyed the way a 400 does, so a
 * dialog can show a field's own message — the name, whose `(copy)` suffix can
 * push a near-limit name over — instead of claiming the entity can't be cloned
 * at all. Returns the body unchanged, not the schema's output, whose defaults
 * it never carried.
 */
export function parseCloneBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  refusalMessage: string,
):
  | { readonly ok: true; readonly data: z.input<T> }
  | {
      readonly ok: false;
      readonly outcome: InvalidOutcome;
    } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      outcome: {
        outcome: "invalid",
        message: refusalMessage,
        // An issue with no path (an unknown key on a strict schema) names no
        // field, so it would vanish from the keyed errors and leave a name
        // issue looking like the only one. Key nothing then: the dialog falls
        // back to the entity's refusal.
        fieldErrors: result.error.issues.some(
          (issue) => issue.path.length === 0,
        )
          ? {}
          : parseValidationErrors({ error: result.error.issues }),
      },
    };
  }
  return { ok: true, data: body as z.input<T> };
}
