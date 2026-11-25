export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

// why: Myers' O((n+m)·D) walk beats an n×m LCS table, whose allocation grows with the product of both line counts.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const max = n + m;

  const offset = max;
  const v = new Int32Array(2 * max + 1);

  // why: trace[d] keeps only the [-d, d] diagonal band read when unfolding edit step d.
  const trace: Int32Array[] = [];
  let edits = 0;

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        edits = d;
        break outer;
      }
    }
  }

  return backtrack(a, b, trace, edits);
}

function backtrack(
  a: string[],
  b: string[],
  trace: Int32Array[],
  editDistance: number,
): DiffLine[] {
  const reversed: DiffLine[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = editDistance; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[k - 1 + d] < v[k + 1 + d])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ kind: "same", text: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      reversed.push({ kind: "added", text: b[y - 1] });
      y--;
    } else {
      reversed.push({ kind: "removed", text: a[x - 1] });
      x--;
    }
  }

  while (x > 0 && y > 0) {
    reversed.push({ kind: "same", text: a[x - 1] });
    x--;
    y--;
  }
  while (x > 0) {
    reversed.push({ kind: "removed", text: a[x - 1] });
    x--;
  }
  while (y > 0) {
    reversed.push({ kind: "added", text: b[y - 1] });
    y--;
  }
  return reversed.reverse();
}
