import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

export const respond = <S extends z.ZodType>(
  c: Context,
  schema: S,
  value: unknown,
  status?: ContentfulStatusCode,
) => {
  if (process.env.NODE_ENV === "test") {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `Response does not match its schema: ${z.prettifyError(result.error)}`,
      );
    }
  }
  return status === undefined
    ? c.json(value as never)
    : c.json(value as never, status);
};
