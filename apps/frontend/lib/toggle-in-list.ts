export function toggleInList<T extends string>(
  list: T[],
  id: T,
  on: boolean,
): T[] {
  if (list.includes(id) === on) return list;
  return on ? [...list, id] : list.filter((item) => item !== id);
}
