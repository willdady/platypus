/**
 * Removes duplicates from an array of strings.
 * @param arr - The array of strings to deduplicate.
 * @returns A new array with duplicates removed.
 */
export const dedupeArray = (arr: string[]): string[] => {
  return [...new Set(arr)];
};

/**
 * Converts a string to kebab-case.
 * @param str - The string to convert.
 * @returns The kebab-case string.
 */
export const toKebabCase = (str: string): string => {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase();
};
