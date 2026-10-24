/**
 * The row of a statement that always yields exactly one: an `INSERT …
 * RETURNING`, or an aggregate such as `SELECT count(*)`. Throws if it yielded
 * none, rather than handing `undefined` on as a row. A lookup that can
 * legitimately find nothing checks for it itself and answers not-found.
 */
export const oneRow = <T>(rows: T[]): T => {
  const [row] = rows;
  if (row === undefined) throw new Error("Statement returned no row");
  return row;
};
