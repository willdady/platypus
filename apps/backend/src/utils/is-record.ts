/** Whether a value is a non-null, non-array object, such as parsed JSON's `{}`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
