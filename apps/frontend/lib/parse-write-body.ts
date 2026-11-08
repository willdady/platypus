import type { z } from "zod";

/**
 * Checks a clone's runtime-built create body against the entity's strict
 * create schema. `Object.fromEntries` erases its keys, so the compiler cannot
 * see a body the backend would refuse; answer as a refused create instead of
 * sending one. Returns the body unchanged — not the schema's output, whose
 * defaults it never carried.
 */
export function parseCloneBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  refusalMessage: string,
):
  | { readonly ok: true; readonly data: z.input<T> }
  | {
      readonly ok: false;
      readonly outcome: { readonly outcome: "error"; readonly message: string };
    } {
  if (!schema.safeParse(body).success) {
    return {
      ok: false,
      outcome: { outcome: "error", message: refusalMessage },
    };
  }
  return { ok: true, data: body as z.input<T> };
}
