import { isDeepStrictEqual } from "node:util";
import { vi, type Mock } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";

export type Row = Record<string, unknown>;

export type ColumnRef = { table: string; name: string };

export type Marker =
  | {
      op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      column: ColumnRef;
      value: unknown;
    }
  | { op: "isNull" | "isNotNull"; column: ColumnRef }
  | { op: "inArray" | "notInArray"; column: ColumnRef; values: unknown[] }
  | { op: "and" | "or"; conditions: Condition[] }
  | { op: "sql"; strings: readonly string[]; values: unknown[] };

export type Condition = Marker | undefined | null;

export type CountMarker = {
  isCount: true;
  aliased?: true;
  as: (alias: string) => CountMarker;
};

export type MaxMarker = { isMax: true; column: ColumnRef };

type Resolve = (ref: ColumnRef) => unknown;

// why: read directly: this module is loaded inside the drizzle-orm mock, so must not import it
const TABLE_NAME = Symbol.for("drizzle:Name");

const tableNameOf = (table: unknown): string => {
  const name = (table as Record<symbol, unknown> | null)?.[TABLE_NAME];
  if (typeof name !== "string") {
    throw new Error("fake db was handed something that is not a Drizzle table");
  }
  return name;
};

const isColumn = (value: unknown): boolean => {
  const candidate = value as { name?: unknown; table?: unknown } | null;
  return (
    !!candidate &&
    typeof candidate === "object" &&
    typeof candidate.name === "string" &&
    !!candidate.table &&
    typeof (candidate.table as Record<symbol, unknown>)[TABLE_NAME] === "string"
  );
};

const toCamel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const refOf = (column: unknown): ColumnRef => {
  const col = column as { name: string; table: object };
  return { table: tableNameOf(col.table), name: col.name };
};

export const markerOperators = () => ({
  eq: (column: unknown, value: unknown) =>
    ({ op: "eq", column: refOf(column), value }) as Marker,
  ne: (column: unknown, value: unknown) =>
    ({ op: "ne", column: refOf(column), value }) as Marker,
  gt: (column: unknown, value: unknown) =>
    ({ op: "gt", column: refOf(column), value }) as Marker,
  gte: (column: unknown, value: unknown) =>
    ({ op: "gte", column: refOf(column), value }) as Marker,
  lt: (column: unknown, value: unknown) =>
    ({ op: "lt", column: refOf(column), value }) as Marker,
  lte: (column: unknown, value: unknown) =>
    ({ op: "lte", column: refOf(column), value }) as Marker,
  isNull: (column: unknown) =>
    ({ op: "isNull", column: refOf(column) }) as Marker,
  isNotNull: (column: unknown) =>
    ({ op: "isNotNull", column: refOf(column) }) as Marker,
  inArray: (column: unknown, values: unknown[]) =>
    ({ op: "inArray", column: refOf(column), values }) as Marker,
  notInArray: (column: unknown, values: unknown[]) =>
    ({ op: "notInArray", column: refOf(column), values }) as Marker,
  and: (...conditions: Condition[]) =>
    ({ op: "and", conditions: conditions.filter(Boolean) }) as Marker,
  or: (...conditions: Condition[]) =>
    ({ op: "or", conditions: conditions.filter(Boolean) }) as Marker,
  count: () => countMarker(),
  max: (column: unknown): MaxMarker => ({ isMax: true, column: refOf(column) }),
});

const countMarker = (aliased?: true): CountMarker => ({
  isCount: true,
  ...(aliased && { aliased }),
  as: () => countMarker(true),
});

export const sqlMarker = (
  strings: readonly string[],
  values: unknown[],
): Marker & {
  getSQL: () => { query: string };
  mapWith: () => unknown;
  as: () => Marker;
} => {
  const marker = Object.assign(
    { op: "sql" as const, strings, values },
    {
      getSQL: () => ({ query: strings.join("?") }),
      mapWith: () => undefined,
      as: () => marker,
    },
  );
  return marker;
};

const isMarker = (value: unknown): value is Marker =>
  !!value && typeof value === "object" && "op" in value;

const isCountMarker = (value: unknown): value is CountMarker =>
  !!value &&
  typeof value === "object" &&
  "isCount" in value &&
  value.isCount === true;

const isMaxMarker = (value: unknown): value is MaxMarker =>
  !!value &&
  typeof value === "object" &&
  "isMax" in value &&
  value.isMax === true;

const isNested = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  !isMarker(value) &&
  !isAggregate(value);

const isAggregate = (value: unknown): boolean =>
  isCountMarker(value) || isMaxMarker(value);

const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const likeMatches = (value: string, pattern: string): boolean => {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      source += escapeRegex(pattern[++i]);
    } else if (char === "%") {
      source += ".*";
    } else if (char === "_") {
      source += ".";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`, "is").test(value);
};

const matchesSql = (
  marker: Marker & { op: "sql" },
  resolve: Resolve,
): boolean => {
  const shape = marker.strings.join("?").replace(/\s+/g, "");
  const [left, right] = marker.values;
  if (shape === "lower(?)=?") {
    const value = resolve(refOf(left));
    return typeof value === "string" && value.toLowerCase() === right;
  }
  if (shape === "?ILIKE?") {
    const value = resolve(refOf(left));
    return typeof value === "string" && likeMatches(value, right as string);
  }
  if (shape === "?>=?") {
    const value = resolve(refOf(left));
    return value != null && (value as string) >= (right as string);
  }
  if (shape === "true") {
    return true;
  }
  if (shape === "?ISDISTINCTFROM?") {
    return (resolve(refOf(left)) ?? null) !== (resolve(refOf(right)) ?? null);
  }
  if (shape === "?@>?::jsonb") {
    const value = resolve(refOf(left));
    const wanted = JSON.parse(right as string) as unknown[];
    return Array.isArray(value) && wanted.every((v) => value.includes(v));
  }
  throw new Error(
    `fake db cannot interpret this SQL fragment: \`${marker.strings.join("?")}\``,
  );
};

const sqlValue = (
  marker: Marker & { op: "sql" },
  resolve: Resolve,
): unknown => {
  const shape = marker.strings.join("?").replace(/\s+/g, "");
  if (shape === "?::timestamp+(?-?)") {
    const [start, later, earlier] = marker.values;
    const end = resolve(refOf(later)) as Date;
    const begin = resolve(refOf(earlier)) as Date;
    return new Date(
      Date.parse(start as string) + end.getTime() - begin.getTime(),
    );
  }
  if (shape === "?-?") {
    const [column, element] = marker.values;
    const value = resolve(refOf(column)) as unknown[];
    return value.filter((v) => v !== element);
  }
  throw new Error(
    `fake db cannot compute this SQL value: \`${marker.strings.join("?")}\``,
  );
};

const SUBQUERY = Symbol("fake-db:subquery");

const LATERAL = Symbol("fake-db:lateral");

const listOf = (values: unknown): unknown[] => {
  if (Array.isArray(values)) return values;
  const run = (values as Record<symbol, unknown> | null)?.[SUBQUERY];
  if (typeof run !== "function") {
    throw new Error(
      "fake db was handed an inArray list that is neither an array nor a select",
    );
  }
  return (run as () => Row[])().map((row) => Object.values(row)[0]);
};

const operandOf = (value: unknown, resolve: Resolve): unknown =>
  isColumn(value) ? resolve(refOf(value)) : value;

const satisfies = (resolve: Resolve, condition: Condition): boolean => {
  if (!condition) return true;
  if (!isMarker(condition)) {
    throw new Error(
      "fake db received a condition it cannot read — mock `drizzle-orm` with `markerOperators()`",
    );
  }
  switch (condition.op) {
    case "and":
      return condition.conditions.every((c) => satisfies(resolve, c));
    case "or":
      return condition.conditions.some((c) => satisfies(resolve, c));
    case "eq":
      return resolve(condition.column) === operandOf(condition.value, resolve);
    case "ne":
      return resolve(condition.column) !== operandOf(condition.value, resolve);
    case "gt":
      return (
        (resolve(condition.column) as number) >
        (operandOf(condition.value, resolve) as number)
      );
    case "gte":
      return (
        (resolve(condition.column) as number) >=
        (operandOf(condition.value, resolve) as number)
      );
    case "lt":
      return (
        (resolve(condition.column) as number) <
        (operandOf(condition.value, resolve) as number)
      );
    case "lte":
      return (
        (resolve(condition.column) as number) <=
        (operandOf(condition.value, resolve) as number)
      );
    case "isNull":
      return resolve(condition.column) == null;
    case "isNotNull":
      return resolve(condition.column) != null;
    case "inArray":
      return listOf(condition.values).includes(resolve(condition.column));
    case "notInArray":
      return !listOf(condition.values).includes(resolve(condition.column));
    case "sql":
      return matchesSql(condition, resolve);
  }
};

const flatResolver =
  (row: Row): Resolve =>
  (ref) =>
    ref.name in row ? row[ref.name] : row[toCamel(ref.name)];

const joinedResolver =
  (row: Row): Resolve =>
  (ref) => {
    const part = row[ref.table];
    if (part && typeof part === "object") {
      return flatResolver(part as Row)(ref);
    }
    if (part === null) return null;
    return flatResolver(row)(ref);
  };

type OrderMarker = {
  op: "asc" | "desc";
  column: ColumnRef;
  nulls?: "first" | "last";
};

export const orderOperators = () => ({
  asc: (column: unknown) =>
    ({ op: "asc", column: refOf(column) }) as OrderMarker,
  desc: (column: unknown) =>
    ({ op: "desc", column: refOf(column) }) as OrderMarker,
});

const orderMarkerOf = (marker: OrderMarker | Marker): OrderMarker => {
  if (!isMarker(marker) || marker.op !== "sql") {
    return marker as OrderMarker;
  }
  const shape = marker.strings.join("?").replace(/\s+/g, "").toLowerCase();
  const match = /^\?((?:asc|desc))(nulls(?:first|last))?$/.exec(shape);
  const column = marker.values[0];
  if (!match || !isColumn(column)) {
    throw new Error(
      `fake db cannot interpret this order fragment: \`${marker.strings.join("?")}\``,
    );
  }
  return {
    op: match[1] as "asc" | "desc",
    column: refOf(column),
    ...(match[2]
      ? { nulls: match[2].slice("nulls".length) as "first" | "last" }
      : {}),
  };
};

type UniqueConstraint = {
  name: string;
  columns: string[];
  where?: (row: Row) => boolean;
};

export type FakeDbOptions = {
  unique?: Record<string, UniqueConstraint[]>;
  onInsert?: (table: string, values: Row) => void;
  defaults?: Record<string, Row>;
  onQuery?: (query: QueryRecord) => void;
};

export type Store = Record<string, Row[]>;

export type QueryRecord = {
  kind: "select" | "insert" | "update" | "delete";
  table: string;
  lock?: string;
};

export type FakeDb = {
  handle: unknown;
  queries: QueryRecord[];
  tables: Store;
  execute: Mock<(...args: unknown[]) => unknown>;
};

const normaliseStore = (rows: Store): Store => {
  const store: Store = {};
  for (const [name, value] of Object.entries(rows)) {
    store[name] = value.map((row) => ({ ...row }));
  }
  return store;
};

export const dbError = (
  code = "08006",
  message = "connection failure",
): DrizzleQueryError =>
  new DrizzleQueryError(
    "fake query",
    [],
    Object.assign(new Error(message), { code }),
  );

const uniqueViolation = (constraint: string) =>
  dbError(
    "23505",
    `duplicate key value violates unique constraint "${constraint}"`,
  );

export const createFakeDb = (
  initialRows: Store = {},
  options: FakeDbOptions = {},
): FakeDb => {
  const committed = normaliseStore(initialRows);
  const queries: QueryRecord[] = [];
  const record = (query: QueryRecord) => {
    queries.push(query);
    options.onQuery?.(query);
  };
  const execute = vi.fn((..._args: unknown[]) =>
    Promise.resolve({ rowCount: 0, rows: [] }),
  );

  const nameOf = (table: unknown) => tableNameOf(table);

  const makeHandle = (store: Store) => {
    const rowsFor = (table: unknown): Row[] => {
      const name = nameOf(table);
      store[name] ??= [];
      return store[name];
    };

    const project = (
      row: Row,
      resolve: Resolve,
      selection: Record<string, unknown> | undefined,
      group: Resolve[],
    ): Row => {
      if (!selection) return { ...row };
      const out: Row = {};
      for (const [key, value] of Object.entries(selection)) {
        if (isCountMarker(value)) {
          out[key] = group.length;
        } else if (isMaxMarker(value)) {
          const values = group
            .map((r) => r(value.column))
            .filter((v) => v != null) as number[];
          out[key] = values.length ? Math.max(...values) : null;
        } else if (isColumn(value)) {
          out[key] = resolve(refOf(value));
        } else if (isNested(value)) {
          out[key] = project(row, resolve, value, group);
        } else {
          throw new Error(
            `fake db cannot project the selection "${key}" — it is neither a column, count() nor max()`,
          );
        }
      }
      return out;
    };

    const writeResult = (touched: Row[]) => ({
      returning(selection?: Record<string, unknown>) {
        return Promise.resolve().then(() =>
          touched.map((row) =>
            project(
              row,
              flatResolver(row),
              selection,
              touched.map(flatResolver),
            ),
          ),
        );
      },
      then(
        onFulfilled?: (result: unknown) => unknown,
        onRejected?: (error: unknown) => unknown,
      ) {
        return Promise.resolve(undefined).then(onFulfilled, onRejected);
      },
    });

    const select = (
      selection?: Record<string, unknown>,
      distinct = false,
      distinctOn: ColumnRef[] = [],
    ) => {
      let table: unknown;
      let condition: Condition;
      let take = Infinity;
      let skip = 0;
      let order: OrderMarker[] = [];
      let grouping: ColumnRef[] = [];
      let lock: string | undefined;
      const joins: {
        table: unknown;
        on: Condition;
        left?: boolean;
        lateral?: boolean;
      }[] = [];

      const rows = (outer?: Resolve): Row[] => {
        const base = rowsFor(table);
        let combined: Row[] = joins.length
          ? base.map((row) => ({ [nameOf(table)]: row }))
          : base.slice();

        for (const join of joins) {
          const next: Row[] = [];
          for (const row of combined) {
            const candidates = join.lateral
              ? (join.table as Record<symbol, (outer: Resolve) => Row[]>)[
                  LATERAL
                ](joinedResolver(row))
              : rowsFor(join.table);
            const partners = candidates.filter((partner) =>
              satisfies(
                joinedResolver({ ...row, [nameOf(join.table)]: partner }),
                join.on,
              ),
            );
            for (const partner of partners) {
              next.push({ ...row, [nameOf(join.table)]: partner });
            }
            if (join.left && !partners.length) {
              next.push({ ...row, [nameOf(join.table)]: null });
            }
          }
          combined = next;
        }

        const own = joins.length ? joinedResolver : flatResolver;
        const read = new Set([table, ...joins.map((j) => j.table)].map(nameOf));
        const resolverFor = (row: Row): Resolve =>
          outer
            ? (ref) => (read.has(ref.table) ? own(row)(ref) : outer(ref))
            : own(row);
        let matched = combined.filter((row) =>
          satisfies(resolverFor(row), condition),
        );

        for (const { column, op, nulls } of [...order].reverse()) {
          matched = matched.slice().sort((a, b) => {
            const valueOf = (v: unknown): unknown =>
              v instanceof Date ? v.getTime() : v;
            const leftValue = valueOf(resolverFor(a)(column));
            const rightValue = valueOf(resolverFor(b)(column));
            const leftNull = leftValue == null;
            const rightNull = rightValue == null;
            if (nulls === "last") {
              if (leftNull !== rightNull) return leftNull ? 1 : -1;
            } else if (nulls === "first") {
              if (leftNull !== rightNull) return leftNull ? -1 : 1;
            }
            const left = leftValue as number;
            const right = rightValue as number;
            if (left === right) return 0;
            const ascending = left < right ? -1 : 1;
            return op === "asc" ? ascending : -ascending;
          });
        }

        if (distinctOn.length) {
          const seen = new Set<string>();
          matched = matched.filter((row) => {
            const resolve = resolverFor(row);
            const key = JSON.stringify(distinctOn.map((c) => resolve(c)));
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }

        if (grouping.length) {
          const buckets = new Map<string, Row[]>();
          for (const row of matched) {
            const resolve = resolverFor(row);
            const key = JSON.stringify(
              grouping.map((column) => resolve(column)),
            );
            buckets.set(key, [...(buckets.get(key) ?? []), row]);
          }
          return [...buckets.values()]
            .slice(0, take)
            .map((bucket) =>
              project(
                bucket[0],
                resolverFor(bucket[0]),
                selection,
                bucket.map(resolverFor),
              ),
            );
        }

        if (selection && Object.values(selection).some(isAggregate)) {
          return [
            project({}, flatResolver({}), selection, matched.map(resolverFor)),
          ];
        }

        const page = matched
          .slice(skip, skip + take)
          .map((row) =>
            project(row, resolverFor(row), selection, [resolverFor(row)]),
          );
        if (!distinct) return page;
        const seen = new Set<string>();
        return page.filter((row) => {
          const key = JSON.stringify(row);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const builder = {
        from(t: unknown) {
          table = t;
          return builder;
        },
        innerJoin(t: unknown, on: Condition) {
          joins.push({ table: t, on });
          return builder;
        },
        leftJoin(t: unknown, on: Condition) {
          joins.push({ table: t, on, left: true });
          return builder;
        },
        leftJoinLateral(t: unknown, on: Condition) {
          joins.push({ table: t, on, left: true, lateral: true });
          return builder;
        },
        as(alias: string) {
          for (const [key, value] of Object.entries(selection ?? {})) {
            if (isCountMarker(value) && !value.aliased) {
              throw new Error(
                `subquery "${alias}" selects "${key}" as count() without .as(…)`,
              );
            }
          }
          const subquery: Record<string | symbol, unknown> = {
            [TABLE_NAME]: alias,
            [LATERAL]: (outer: Resolve) => rows(outer),
          };
          for (const key of Object.keys(selection ?? {})) {
            subquery[key] = { name: key, table: subquery };
          }
          return subquery;
        },
        where(c: Condition) {
          condition = c;
          return builder;
        },
        orderBy(...markers: (OrderMarker | Marker)[]) {
          order = markers.filter(Boolean).map(orderMarkerOf);
          return builder;
        },
        groupBy(...columns: unknown[]) {
          grouping = columns.map(refOf);
          return builder;
        },
        limit(n: number) {
          take = n;
          return builder;
        },
        offset(n: number) {
          skip = n;
          return builder;
        },
        for(strength: string) {
          lock = strength;
          return builder;
        },
        then(
          onFulfilled?: (result: Row[]) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) {
          return Promise.resolve()
            .then(() => {
              record({
                kind: "select",
                table: nameOf(table),
                ...(lock && { lock }),
              });
              return rows();
            })
            .then(onFulfilled, onRejected);
        },
      };
      Object.defineProperty(builder, SUBQUERY, { value: rows });
      return builder;
    };

    const insert = (table: unknown) => {
      const name = nameOf(table);

      const clashingConstraint = (row: Row): UniqueConstraint | undefined => {
        const resolve = flatResolver(row);
        return (options.unique?.[name] ?? []).find((constraint) => {
          const covers = constraint.where ?? (() => true);
          if (!covers(row)) return false;
          return rowsFor(table).some(
            (existing) =>
              covers(existing) &&
              constraint.columns.every(
                (column) =>
                  flatResolver(existing)({ table: name, name: column }) ===
                  resolve({ table: name, name: column }),
              ),
          );
        });
      };

      const write = (
        values: Row | Row[],
        conflicts: "throw" | "skip",
      ): Row[] => {
        record({ kind: "insert", table: name });
        const written: Row[] = [];
        for (const row of (Array.isArray(values) ? values : [values]).map(
          (row) => ({ ...(options.defaults?.[name] ?? {}), ...row }),
        )) {
          const clash = clashingConstraint(row);
          if (clash) {
            if (conflicts === "skip") continue;
            throw uniqueViolation(clash.name);
          }
          options.onInsert?.(name, row);
          rowsFor(table).push(row);
          written.push(row);
        }
        return written;
      };

      return {
        values(values: Row | Row[]) {
          // why: deferred to the terminal call, so `.onConflictDoNothing()` can skip a clash a plain insert throws on
          let settled: ReturnType<typeof writeResult> | undefined;
          const settle = (conflicts: "throw" | "skip") => {
            settled ??= writeResult(write(values, conflicts));
            return settled;
          };
          return {
            returning(selection?: Record<string, unknown>) {
              return settle("throw").returning(selection);
            },
            then(
              onFulfilled?: (result: unknown) => unknown,
              onRejected?: (error: unknown) => unknown,
            ) {
              return settle("throw").then(onFulfilled, onRejected);
            },
            onConflictDoNothing: () => settle("skip"),
            onConflictDoUpdate: () => settle("throw"),
          };
        },
      };
    };

    const update = (table: unknown) => {
      let patch: Row = {};
      let updated: Row[] = [];
      let joined: unknown;

      const matches = (row: Row, condition: Condition) => {
        if (joined === undefined) {
          return satisfies(flatResolver(row), condition);
        }
        return rowsFor(joined).some((other) =>
          satisfies(
            joinedResolver({ [nameOf(table)]: row, [nameOf(joined)]: other }),
            condition,
          ),
        );
      };

      const apply = (condition: Condition) => {
        record({ kind: "update", table: nameOf(table) });
        updated = rowsFor(table).filter((row) => matches(row, condition));
        for (const row of updated) {
          const resolve = flatResolver(row);
          const values = Object.fromEntries(
            Object.entries(patch).map(([key, value]) => [
              key,
              isMarker(value) && value.op === "sql"
                ? sqlValue(value, resolve)
                : value,
            ]),
          );
          Object.assign(row, values);
        }
      };

      const builder = {
        set(values: Row) {
          patch = values;
          return builder;
        },
        from(other: unknown) {
          joined = other;
          return builder;
        },
        where(condition: Condition) {
          apply(condition);
          return writeResult(updated);
        },
      };
      return builder;
    };

    const remove = (table: unknown) => ({
      where(condition: Condition) {
        record({ kind: "delete", table: nameOf(table) });
        const rows = rowsFor(table);
        const deleted = rows.filter((row) =>
          satisfies(flatResolver(row), condition),
        );
        const kept = rows.filter((row) => !deleted.includes(row));
        rows.length = 0;
        rows.push(...kept);
        return writeResult(deleted);
      },
    });

    return {
      select: (selection?: Record<string, unknown>) => select(selection),
      selectDistinct: (selection?: Record<string, unknown>) =>
        select(selection, true),
      selectDistinctOn: (on: unknown[], selection?: Record<string, unknown>) =>
        select(selection, false, on.map(refOf)),
      insert,
      update,
      delete: remove,
      execute,
      async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
        const before = structuredClone(store);
        const staged = structuredClone(store);
        const result = await callback(makeHandle(staged));
        // why: copy back only the tables it wrote, or writes made outside it while it ran are undone
        for (const [name, rows] of Object.entries(staged)) {
          if (isDeepStrictEqual(rows, before[name])) continue;
          store[name] ??= [];
          store[name].length = 0;
          store[name].push(...rows);
        }
        return result;
      },
    };
  };

  return {
    handle: makeHandle(committed),
    tables: committed,
    queries,
    execute,
  };
};
