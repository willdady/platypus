/** Dedupes an array of strings */
export const dedupeArray = (arr: string[] | undefined) => {
  if (!arr) {
    return undefined;
  }
  return Array.from(new Set(arr));
};