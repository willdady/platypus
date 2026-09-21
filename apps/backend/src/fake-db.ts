import { vi, type Mock } from "vitest";

/**
 * An in-memory stand-in for the Drizzle handle that **interprets the `WHERE` a
 * query builds** instead of ignoring it.
 *
 * The chainable mock in `test-utils.ts` stubs every Drizzle operator as a
 * no-op, so a predicate is `undefined` by the time `.where()` receives it: a
 * test can only say which query comes back *nth*, never which rows it would
 * match. A query that dropped a scope column from its `and(...)` still passes.
 *
 * Here the operators are replaced with introspectable markers
 * ({@link markerOperators}) and this module evaluates them against seeded rows,
 * so a route that forgot to scope a lookup reads another Workspace's fixture
 * and the test fails.
 *
 * This module is the engine, not the entry point: tests reach it through
 * `seedDb()`/`resetMockDb()` in `test-utils.ts`, which installs it as the `db`
 * every module imports and mocks `drizzle-orm` with the markers it reads.
 *
 * It is a fake, not Postgres: no SQL is parsed, no constraint exists that a
 * test did not ask for, and an operator or SQL fragment it cannot interpret
 * throws rather than quietly matching everything.
 */

/** A seeded table row, keyed by camel-cased column name (or snake — both resolve). */
export type Row = Record<string, unknown>;

/** A column as a marker records it: which table it belongs to, and its name. */
export type ColumnRef = { table: string; name: string };

/** A comparison marker standing in for a Drizzle operator's `SQL` fragment. */
export type Marker =
  | { op: "eq" | "gt" | "lte"; column: ColumnRef; value: unknown }
  | { op: "isNull"; column: ColumnRef }
  | { op: "inArray" | "notInArray"; column: ColumnRef; values: unknown[] }
  | { op: "and" | "or"; conditions: Condition[] }
  | { op: "sql"; strings: readonly string[]; values: unknown[] };

/** What a `.where()` may receive: a marker, or nothing at all. */
export type Condition = Marker | undefined | null;

/** A marker standing in for `count()` in a `select({ n: count() })` projection. */
export type CountMarker = { isCount: true };

/** Resolves a {@link ColumnRef} against whichever row shape is in play. */
type Resolve = (ref: ColumnRef) => unknown;

/**
 * Drizzle stamps a table's name under this symbol. It is read directly rather
 * than through `getTableName`, because this module is imported from inside the
 * `drizzle-orm` mock factory and so must not import the package it stands in
 * for.
 */
const TABLE_NAME = Symbol.for("drizzle:Name");

/** The Postgres name of a Drizzle table object. */
const tableNameOf = (table: unknown): string => {
  const name = (table as Record<symbol, unknown> | null)?.[TABLE_NAME];
  if (typeof name !== "string") {
    throw new Error("fake db was handed something that is not a Drizzle table");
  }
  return name;
};

/** Whether a `select({...})` projection value is a column rather than a marker. */
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

/** Snake-cased column names map back onto camel-cased row keys. */
const toCamel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Records a Drizzle column as the table it belongs to plus its column name. */
const refOf = (column: unknown): ColumnRef => {
  const col = column as { name: string; table: object };
  return { table: tableNameOf(col.table), name: col.name };
};

/**
 * The Drizzle operators as introspectable markers — the set the code under
 * test actually composes. A test file mocks `drizzle-orm` with these — spread
 * over `...actual` so `pgTable` and friends stay real — and this module's fake
 * handle then evaluates what the query asked for. An operator that no query
 * issues yet is deliberately absent: adding one here without a query to read it
 * is surface nothing exercises.
 */
export const markerOperators = () => ({
  eq: (column: unknown, value: unknown) =>
    ({ op: "eq", column: refOf(column), value }) as Marker,
  gt: (column: unknown, value: unknown) =>
    ({ op: "gt", column: refOf(column), value }) as Marker,
  lte: (column: unknown, value: unknown) =>
    ({ op: "lte", column: refOf(column), value }) as Marker,
  isNull: (column: unknown) =>
    ({ op: "isNull", column: refOf(column) }) as Marker,
  inArray: (column: unknown, values: unknown[]) =>
    ({ op: "inArray", column: refOf(column), values }) as Marker,
  notInArray: (column: unknown, values: unknown[]) =>
    ({ op: "notInArray", column: refOf(column), values }) as Marker,
  and: (...conditions: Condition[]) =>
    ({ op: "and", conditions: conditions.filter(Boolean) }) as Marker,
  or: (...conditions: Condition[]) =>
    ({ op: "or", conditions: conditions.filter(Boolean) }) as Marker,
  count: (): CountMarker => ({ isCount: true }),
});

/**
 * A `sql` template as an introspectable marker. It keeps the `getSQL`/`mapWith`
 * surface the chainable mock's `sql` already offered, so a test that only looks
 * at the rendered query is unaffected, and adds the template's parts so a
 * fragment inside a `WHERE` can be evaluated rather than skipped.
 */
export const sqlMarker = (
  strings: readonly string[],
  values: unknown[],
): Marker & { getSQL: () => { query: string }; mapWith: () => unknown } =>
  Object.assign(
    { op: "sql" as const, strings, values },
    {
      getSQL: () => ({ query: strings.join("?") }),
      mapWith: () => undefined,
    },
  );

const isMarker = (value: unknown): value is Marker =>
  !!value && typeof value === "object" && "op" in value;

const isCountMarker = (value: unknown): value is CountMarker =>
  !!value &&
  typeof value === "object" &&
  (value as CountMarker).isCount === true;

/**
 * Evaluates the handful of raw-SQL fragments the code under test composes into
 * a `WHERE`. Anything else throws: a fragment this fake silently treated as
 * "matches everything" would be the very blindness it exists to remove.
 */
const matchesSql = (
  marker: Marker & { op: "sql" },
  resolve: Resolve,
): boolean => {
  // Whitespace-insensitive, so `lower(${col}) = ${value}` reads the same
  // however the template is spaced or wrapped.
  const shape = marker.strings.join("?").replace(/\s+/g, "");
  const [left, right] = marker.values;
  if (shape === "lower(?)=?") {
    const value = resolve(refOf(left));
    return typeof value === "string" && value.toLowerCase() === right;
  }
  throw new Error(
    `fake db cannot interpret this SQL fragment: \`${marker.strings.join("?")}\``,
  );
};

/**
 * The right-hand side of a comparison. A join condition compares two columns
 * (`eq(workspace.id, attachment.workspaceId)`), so a column there is resolved
 * against the row rather than compared as a literal.
 */
const operandOf = (value: unknown, resolve: Resolve): unknown =>
  isColumn(value) ? resolve(refOf(value)) : value;

/** Whether a row (as seen through `resolve`) satisfies a condition. */
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
    case "gt":
      return (
        (resolve(condition.column) as number) >
        (operandOf(condition.value, resolve) as number)
      );
    case "lte":
      return (
        (resolve(condition.column) as number) <=
        (operandOf(condition.value, resolve) as number)
      );
    case "isNull":
      return resolve(condition.column) == null;
    case "inArray":
      return condition.values.includes(resolve(condition.column));
    case "notInArray":
      return !condition.values.includes(resolve(condition.column));
    case "sql":
      return matchesSql(condition, resolve);
  }
};

/** Looks a column up on a flat row, accepting either casing of its name. */
const flatResolver =
  (row: Row): Resolve =>
  (ref) =>
    ref.name in row ? row[ref.name] : row[toCamel(ref.name)];

/**
 * Looks a column up on a joined row — one keyed by table name, the shape
 * Drizzle returns for `select().from(a).innerJoin(b, …)` — falling back to a
 * flat lookup so the same resolver serves both.
 */
const joinedResolver =
  (row: Row): Resolve =>
  (ref) => {
    const part = row[ref.table];
    if (part && typeof part === "object") {
      return flatResolver(part as Row)(ref);
    }
    return flatResolver(row)(ref);
  };

/** A `(column, direction)` pair as `asc()`/`desc()` record it. */
type OrderMarker = { op: "asc" | "desc"; column: ColumnRef };

/** The ordering operators, kept apart from the comparison ones for clarity. */
export const orderOperators = () => ({
  asc: (column: unknown) =>
    ({ op: "asc", column: refOf(column) }) as OrderMarker,
  desc: (column: unknown) =>
    ({ op: "desc", column: refOf(column) }) as OrderMarker,
});

/** A unique index, as the fake enforces it on insert. */
type UniqueConstraint = {
  /** The constraint name, as it reads in the Postgres error message. */
  name: string;
  /** The columns whose combined value must be unique. */
  columns: string[];
};

export type FakeDbOptions = {
  /**
   * Unique indexes to enforce per table, so a duplicate insert fails the way
   * Postgres would — the 409 path a route only has because the database
   * refuses the row.
   */
  unique?: Record<string, UniqueConstraint[]>;
  /** Called before every insert, for tests that inject a failure mid-write. */
  onInsert?: (table: string, values: Row) => void;
};

/** The rows the fake holds, keyed by Postgres table name. */
export type Store = Record<string, Row[]>;

export type FakeDb = {
  /** The Drizzle stand-in to hand the code under test. */
  handle: unknown;
  /** The seeded rows, live — assert on these to see what a write did. */
  tables: Store;
  /** `db.execute()`, a spy resolving to `{ rowCount: 0 }` unless restubbed. */
  execute: Mock<(...args: unknown[]) => unknown>;
};

const normaliseStore = (rows: Store): Store => {
  const store: Store = {};
  for (const [name, value] of Object.entries(rows)) {
    store[name] = value.map((row) => ({ ...row }));
  }
  return store;
};

const uniqueViolation = (constraint: string) => {
  const message = `duplicate key value violates unique constraint "${constraint}"`;
  return Object.assign(new Error(`DrizzleQueryError: ${message}`), {
    cause: { code: "23505", message },
  });
};

/**
 * Builds an in-memory Drizzle stand-in over `initialRows`, keyed by Postgres table
 * name (`seedDb({ workspace: [...], provider: [...] })`). Tables not seeded are
 * empty rather than an error, so a query for a resource a test never created
 * simply finds nothing.
 *
 * Covers `select`/`from`/`innerJoin`/`where`/`orderBy`/`limit`,
 * `insert`/`values`/`returning`, `update`/`set`/`where`/`returning`,
 * `delete`/`where`/`returning`, `execute`, and a `transaction` that really
 * rolls back: the callback gets a handle bound to a staging copy merged back
 * only on success, so code that used the outer `db` where it meant `tx` fails
 * rather than passing quietly.
 */
export const createFakeDb = (
  initialRows: Store = {},
  options: FakeDbOptions = {},
): FakeDb => {
  const committed = normaliseStore(initialRows);
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

    /** Applies a `select({...})` projection, or copies the row when there is none. */
    const project = (
      row: Row,
      resolve: Resolve,
      selection: Record<string, unknown> | undefined,
      rowCount: number,
    ): Row => {
      if (!selection) return { ...row };
      const out: Row = {};
      for (const [key, value] of Object.entries(selection)) {
        if (isCountMarker(value)) {
          out[key] = rowCount;
        } else if (isColumn(value)) {
          out[key] = resolve(refOf(value));
        } else {
          // Silently projecting `undefined` would let a query select something
          // this fake cannot compute (an aggregate, say) and still pass.
          throw new Error(
            `fake db cannot project the selection "${key}" — it is neither a column nor count()`,
          );
        }
      }
      return out;
    };

    /**
     * What an `insert`/`update`/`delete` resolves to: the rows it touched
     * through `.returning(...)`, or nothing when the caller just awaits the
     * write. One shape for all three, since Drizzle gives them one.
     */
    const writeResult = (touched: Row[]) => ({
      returning(selection?: Record<string, unknown>) {
        return Promise.resolve().then(() =>
          touched.map((row) =>
            project(row, flatResolver(row), selection, touched.length),
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

    const select = (selection?: Record<string, unknown>) => {
      let table: unknown;
      let condition: Condition;
      let take = Infinity;
      let order: OrderMarker[] = [];
      const joins: { table: unknown; on: Condition }[] = [];

      const rows = (): Row[] => {
        const base = rowsFor(table);
        // A join yields rows keyed by table name, the shape Drizzle returns.
        let combined: Row[] = joins.length
          ? base.map((row) => ({ [nameOf(table)]: row }))
          : base.slice();

        for (const join of joins) {
          const next: Row[] = [];
          for (const row of combined) {
            const partners = rowsFor(join.table).filter((partner) =>
              satisfies(
                joinedResolver({ ...row, [nameOf(join.table)]: partner }),
                join.on,
              ),
            );
            for (const partner of partners) {
              next.push({ ...row, [nameOf(join.table)]: partner });
            }
          }
          combined = next;
        }

        const resolverFor = joins.length ? joinedResolver : flatResolver;
        let matched = combined.filter((row) =>
          satisfies(resolverFor(row), condition),
        );

        for (const { column, op } of [...order].reverse()) {
          matched = matched.slice().sort((a, b) => {
            const left = resolverFor(a)(column) as number;
            const right = resolverFor(b)(column) as number;
            if (left === right) return 0;
            const ascending = left < right ? -1 : 1;
            return op === "asc" ? ascending : -ascending;
          });
        }

        // An aggregate selection is one row whatever the table holds — a
        // `count()` over no rows is `0`, not an empty result set.
        if (selection && Object.values(selection).some(isCountMarker)) {
          return [project({}, flatResolver({}), selection, matched.length)];
        }

        const page = matched.slice(0, take);
        return page.map((row) =>
          project(row, resolverFor(row), selection, matched.length),
        );
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
        where(c: Condition) {
          condition = c;
          return builder;
        },
        orderBy(...markers: OrderMarker[]) {
          order = markers.filter(Boolean);
          return builder;
        },
        limit(n: number) {
          take = n;
          return builder;
        },
        // This fake is single-threaded; lock behavior is tested on Postgres.
        for(_strength: string) {
          return builder;
        },
        then(
          onFulfilled?: (result: Row[]) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) {
          return Promise.resolve()
            .then(() => rows())
            .then(onFulfilled, onRejected);
        },
      };
      return builder;
    };

    const insert = (table: unknown) => {
      const name = nameOf(table);
      let inserted: Row[] = [];

      const write = (values: Row | Row[]) => {
        inserted = (Array.isArray(values) ? values : [values]).map((row) => ({
          ...row,
        }));
        for (const row of inserted) {
          options.onInsert?.(name, row);
          for (const constraint of options.unique?.[name] ?? []) {
            const resolve = flatResolver(row);
            const clashes = rowsFor(table).some((existing) =>
              constraint.columns.every(
                (column) =>
                  flatResolver(existing)({ table: name, name: column }) ===
                  resolve({ table: name, name: column }),
              ),
            );
            if (clashes) throw uniqueViolation(constraint.name);
          }
          rowsFor(table).push(row);
        }
      };

      return {
        values(values: Row | Row[]) {
          // Written synchronously so a unique violation surfaces where the
          // caller's `try` is, the way the driver's rejection does.
          write(values);
          return writeResult(inserted);
        },
      };
    };

    const update = (table: unknown) => {
      let patch: Row = {};
      let updated: Row[] = [];

      const apply = (condition: Condition) => {
        updated = rowsFor(table).filter((row) =>
          satisfies(flatResolver(row), condition),
        );
        for (const row of updated) Object.assign(row, patch);
      };

      const builder = {
        set(values: Row) {
          patch = values;
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
      select,
      insert,
      update,
      delete: remove,
      execute,
      async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
        const staged = structuredClone(store);
        const result = await callback(makeHandle(staged));
        for (const [name, rows] of Object.entries(staged)) {
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
    execute,
  };
};
