/**
 * Removes duplicates from an array of strings.
 * @param arr - The array of strings to deduplicate.
 * @returns A new array with duplicates removed.
 */
export const dedupeArray = (arr: string[]): string[] => {
  return [...new Set(arr)];
};
