/**
 * Adds `id` to `list` when `on`, and removes it otherwise — the expression the
 * labelled switch rows in a form all repeat. Returns `list` itself when it is
 * already in the state asked for, so a React setter can skip the re-render.
 */
export function toggleInList(
  list: string[],
  id: string,
  on: boolean,
): string[] {
  if (list.includes(id) === on) return list;
  return on ? [...list, id] : list.filter((item) => item !== id);
}
