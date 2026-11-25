import type { z } from "zod";
import type { WriteOutcome } from "./api-write";
import { parseValidationErrors } from "./form-errors";

type InvalidOutcome = Extract<
  WriteOutcome<never>,
  { readonly outcome: "invalid" }
>;

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
