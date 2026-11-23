export const oneRow = <T>(rows: T[]): T => {
  const [row] = rows;
  if (row === undefined) throw new Error("Statement returned no row");
  return row;
};
