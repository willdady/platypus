import { isDeepStrictEqual } from "node:util";
import { vi, type Mock } from "vitest";
import { Param, SQL, StringChunk } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";

export type Row = Record<string, unknown>;

export type ColumnRef = { table: string; name: string };

export type Condition = SQL | SQL.Aliased | undefined | null;

type Resolve = (ref: ColumnRef) => unknown;

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

type SqlToken =
  | { kind: "column"; column: ColumnRef }
  | { kind: "value"; value: unknown }
  | { kind: "text"; text: string }
  | { kind: "list"; items: SqlToken[] };

const tokensOf = (chunk: unknown): SqlToken[] => {
  if (chunk === undefined) return [];
  if (chunk instanceof StringChunk) {
    const text = chunk.value.join("");
    return text === "" ? [] : [{ kind: "text", text }];
  }
  if (chunk instanceof SQL.Aliased) return tokensOf(chunk.sql);
  if (chunk instanceof SQL) return chunk.queryChunks.flatMap(tokensOf);
  if (chunk instanceof Param) return [{ kind: "value", value: chunk.value }];
  if (isColumn(chunk)) return [{ kind: "column", column: refOf(chunk) }];
  if (Array.isArray(chunk))
    return [{ kind: "list", items: chunk.flatMap(tokensOf) }];
  return [{ kind: "value", value: chunk }];
};

const sourceOf = (tokens: SqlToken[]): string =>
  tokens
    .map((token) =>
      token.kind === "text" ? token.text : token.kind === "list" ? "(…)" : "?",
    )
    .join("");

const shapeOf = (tokens: SqlToken[]): string =>
  sourceOf(tokens).replace(/\s+/g, " ").trim().toLowerCase();

type Lexeme =
  | { type: "column"; column: ColumnRef }
  | { type: "value"; value: unknown }
  | { type: "list"; items: Lexeme[] }
  | { type: "keyword"; word: string }
  | { type: "operator"; op: string }
  | { type: "open" }
  | { type: "close" }
  | { type: "comma" };

const OPERATORS = ["@>", "<>", "!=", "<=", ">=", "::", "=", "<", ">"];

const lexText = (text: string): Lexeme[] => {
  const lexemes: Lexeme[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "(") {
      lexemes.push({ type: "open" });
      index++;
      continue;
    }
    if (char === ")") {
      lexemes.push({ type: "close" });
      index++;
      continue;
    }
    if (char === ",") {
      lexemes.push({ type: "comma" });
      index++;
      continue;
    }
    const operator = OPERATORS.find((candidate) =>
      text.startsWith(candidate, index),
    );
    if (operator) {
      lexemes.push({ type: "operator", op: operator });
      index += operator.length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(index));
    if (word) {
      lexemes.push({ type: "keyword", word: word[0].toLowerCase() });
      index += word[0].length;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(text.slice(index));
    if (number) {
      lexemes.push({ type: "value", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    throw new Error(`fake db cannot read the SQL fragment \`${text}\``);
  }
  return lexemes;
};

const lexemesOf = (tokens: SqlToken[]): Lexeme[] =>
  tokens.flatMap((token) => {
    switch (token.kind) {
      case "column":
        return [{ type: "column", column: token.column }];
      case "value":
        return [{ type: "value", value: token.value }];
      case "list": {
        const items = lexemesOf(token.items);
        return [
          {
            type: "list",
            items: items.flatMap((item, index) =>
              index === 0 ? [item] : [{ type: "comma" }, item],
            ),
          },
        ];
      }
      case "text":
        return lexText(token.text);
    }
  });

type Test = (resolve: Resolve) => boolean;

type Operand = (resolve: Resolve) => unknown;

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

const numberish = (value: unknown): number | string | null | undefined =>
  value instanceof Date
    ? value.getTime()
    : (value as number | string | null | undefined);

const compare = (
  op: "=" | "<>" | ">" | ">=" | "<" | "<=",
  left: unknown,
  right: unknown,
): boolean => {
  const a = numberish(left);
  const b = numberish(right);
  switch (op) {
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    case ">":
      return a != null && b != null && a > b;
    case ">=":
      return a != null && b != null && a >= b;
    case "<":
      return a != null && b != null && a < b;
    case "<=":
      return a != null && b != null && a <= b;
  }
};

const containsJson = (value: unknown, wanted: unknown): boolean => {
  const list =
    typeof wanted === "string" ? (JSON.parse(wanted) as unknown) : wanted;
  const items = Array.isArray(list) ? list : [list];
  return Array.isArray(value) && items.every((item) => value.includes(item));
};

const listOf = (values: unknown): unknown[] => {
  if (Array.isArray(values)) return values;
  const run = (values as Record<symbol, unknown> | null)?.[SUBQUERY];
  if (typeof run !== "function") {
    throw new Error(
      "fake db was handed an in / inArray list that is neither an array nor a select",
    );
  }
  return (run as () => Row[])().map((row) => Object.values(row)[0]);
};

class ExpressionParser {
  private lexemes: Lexeme[];
  private index: number;
  private source: string;

  constructor(lexemes: Lexeme[], source: string) {
    this.lexemes = lexemes;
    this.index = 0;
    this.source = source;
  }

  parse(): Test {
    const test = this.parseOr();
    if (this.peek()) this.unsupported();
    return test;
  }

  parseOperand(): Operand {
    const operand = this.parseAtom();
    while (this.acceptOperator("::")) {
      const type = this.take();
      if (type?.type !== "keyword") this.unsupported();
      if (this.peek()?.type === "open") this.skipParentheses();
    }
    return operand;
  }

  private parseOr(): Test {
    let test = this.parseAnd();
    while (this.acceptKeyword("or")) {
      const left = test;
      const right = this.parseAnd();
      test = (resolve) => left(resolve) || right(resolve);
    }
    return test;
  }

  private parseAnd(): Test {
    let test = this.parseCondition();
    while (this.acceptKeyword("and")) {
      const left = test;
      const right = this.parseCondition();
      test = (resolve) => left(resolve) && right(resolve);
    }
    return test;
  }

  private parseCondition(): Test {
    if (this.acceptKeyword("not")) {
      const inner = this.parseCondition();
      return (resolve) => !inner(resolve);
    }
    if (this.acceptKeyword("true")) return () => true;
    if (this.acceptKeyword("false")) return () => false;
    if (this.peek()?.type === "open") {
      this.index++;
      const test = this.parseOr();
      if (this.take()?.type !== "close") this.unsupported();
      return test;
    }
    return this.parseComparison();
  }

  private parseComparison(): Test {
    const left = this.parseOperand();
    for (const op of ["=", "<>", "!=", ">", ">=", "<", "<="] as const) {
      if (!this.acceptOperator(op)) continue;
      const right = this.parseOperand();
      const comparison = op === "!=" ? "<>" : op;
      return (resolve) => compare(comparison, left(resolve), right(resolve));
    }
    if (this.acceptOperator("@>")) {
      const right = this.parseOperand();
      return (resolve) => containsJson(left(resolve), right(resolve));
    }
    if (this.acceptKeyword("is")) {
      const negated = this.acceptKeyword("not");
      if (this.acceptKeyword("null")) {
        return (resolve) =>
          negated ? left(resolve) != null : left(resolve) == null;
      }
      if (this.acceptKeyword("distinct")) {
        this.expectKeyword("from");
        const right = this.parseOperand();
        const distinct = (resolve: Resolve) =>
          (left(resolve) ?? null) !== (right(resolve) ?? null);
        return negated ? (resolve) => !distinct(resolve) : distinct;
      }
      this.unsupported();
    }
    const negated = this.acceptKeyword("not");
    if (this.acceptKeyword("in")) {
      const right = this.parseOperand();
      return (resolve) => {
        const found = listOf(right(resolve)).includes(left(resolve));
        return negated ? !found : found;
      };
    }
    if (this.acceptKeyword("ilike")) {
      const right = this.parseOperand();
      return (resolve) => {
        const [value, pattern] = [left(resolve), right(resolve)];
        const found =
          typeof value === "string" &&
          typeof pattern === "string" &&
          likeMatches(value, pattern);
        return negated ? !found : found;
      };
    }
    if (negated) this.unsupported();
    return this.unsupported();
  }

  private parseAtom(): Operand {
    const lexeme = this.take();
    if (!lexeme) this.unsupported();
    switch (lexeme.type) {
      case "column":
        return (resolve) => resolve(lexeme.column);
      case "value":
        return () => lexeme.value;
      case "list": {
        const items = this.parseOperandList(lexeme.items);
        return (resolve) => items.map((item) => item(resolve));
      }
      case "open": {
        const operand = this.parseOperand();
        if (this.take()?.type !== "close") this.unsupported();
        return operand;
      }
      case "keyword": {
        if (lexeme.word === "null") return () => null;
        if (lexeme.word === "true") return () => true;
        if (lexeme.word === "false") return () => false;
        if (this.peek()?.type === "open") return this.parseCall(lexeme.word);
        return this.unsupported();
      }
      default:
        return this.unsupported();
    }
  }

  private parseCall(name: string): Operand {
    if (this.take()?.type !== "open") this.unsupported();
    const args: Operand[] = [];
    if (this.peek()?.type !== "close") {
      args.push(this.parseOperand());
      while (this.peek()?.type === "comma") {
        this.index++;
        args.push(this.parseOperand());
      }
    }
    if (this.take()?.type !== "close") this.unsupported();
    if (name === "lower") {
      return (resolve) => {
        const [value] = args;
        const resolved = value(resolve);
        return typeof resolved === "string" ? resolved.toLowerCase() : resolved;
      };
    }
    return this.unsupported();
  }

  private parseOperandList(items: Lexeme[]): Operand[] {
    const parser = new ExpressionParser(items, this.source);
    const operands = [parser.parseOperand()];
    while (parser.peek()?.type === "comma") {
      parser.index++;
      operands.push(parser.parseOperand());
    }
    if (parser.peek()) this.unsupported();
    return operands;
  }

  private skipParentheses(): void {
    let depth = 0;
    for (;;) {
      const lexeme = this.take();
      if (!lexeme) this.unsupported();
      if (lexeme.type === "open") depth++;
      if (lexeme.type === "close" && --depth === 0) return;
    }
  }

  private peek(): Lexeme | undefined {
    return this.lexemes[this.index];
  }

  private take(): Lexeme | undefined {
    return this.lexemes[this.index++];
  }

  private acceptKeyword(word: string): boolean {
    const lexeme = this.peek();
    if (lexeme?.type !== "keyword" || lexeme.word !== word) return false;
    this.index++;
    return true;
  }

  private acceptOperator(op: string): boolean {
    const lexeme = this.peek();
    if (lexeme?.type !== "operator" || lexeme.op !== op) return false;
    this.index++;
    return true;
  }

  private expectKeyword(word: string): void {
    if (!this.acceptKeyword(word)) this.unsupported();
  }

  private unsupported(): never {
    throw new Error(
      `fake db cannot interpret this SQL fragment: \`${this.source}\``,
    );
  }
}

const conditionOf = (condition: unknown): Test => {
  if (condition == null) return () => true;
  if (condition instanceof SQL.Aliased) return conditionOf(condition.sql);
  if (!(condition instanceof SQL)) {
    throw new Error(
      "fake db received a condition it cannot read — pass a drizzle-orm predicate",
    );
  }
  const tokens = tokensOf(condition);
  return new ExpressionParser(lexemesOf(tokens), sourceOf(tokens)).parse();
};

const satisfies = (resolve: Resolve, condition: Condition): boolean =>
  conditionOf(condition)(resolve);

const SUBQUERY = Symbol("fake-db:subquery");

const LATERAL = Symbol("fake-db:lateral");

type Aggregate =
  | { kind: "count"; aliased: boolean }
  | { kind: "max"; column: ColumnRef; aliased: boolean };

const aggregateOf = (value: unknown): Aggregate | null => {
  const aliased = value instanceof SQL.Aliased;
  const sql = aliased ? value.sql : value;
  if (!(sql instanceof SQL)) return null;
  const tokens = tokensOf(sql);
  const shape = shapeOf(tokens);
  if (/^count\((\*|\?|distinct \?)\)(::int)?$/.test(shape)) {
    return { kind: "count", aliased };
  }
  const column = tokens.find((token) => token.kind === "column");
  if (column?.kind === "column" && /^max\(\?\)(::\w+)?$/.test(shape)) {
    return { kind: "max", column: column.column, aliased };
  }
  return null;
};

const isNested = (value: unknown): value is Record<string, unknown> =>
  !!value && Object.getPrototypeOf(value) === Object.prototype;

const textAt = (tokens: SqlToken[], index: number): string => {
  const token = tokens[index];
  return token.kind === "text" ? token.text : "";
};

const sqlValueOf = (value: unknown, resolve: Resolve): unknown => {
  const sql = value instanceof SQL.Aliased ? value.sql : value;
  if (!(sql instanceof SQL)) return value;
  const tokens = tokensOf(sql);
  if (
    tokens.length === 6 &&
    tokens[0]?.kind === "value" &&
    /^\s*::timestamp\s*\+\s*\(\s*$/i.test(textAt(tokens, 1)) &&
    tokens[2]?.kind === "column" &&
    /^\s*-\s*$/.test(textAt(tokens, 3)) &&
    tokens[4]?.kind === "column" &&
    /^\s*\)\s*$/.test(textAt(tokens, 5))
  ) {
    const start = tokens[0].value as string;
    const end = resolve(tokens[2].column) as Date;
    const begin = resolve(tokens[4].column) as Date;
    return new Date(Date.parse(start) + end.getTime() - begin.getTime());
  }
  if (
    tokens.length === 3 &&
    tokens[0]?.kind === "column" &&
    /^\s*-\s*$/.test(textAt(tokens, 1)) &&
    tokens[2]?.kind === "value"
  ) {
    const current = resolve(tokens[0].column);
    if (!Array.isArray(current)) {
      throw new Error(
        `fake db cannot subtract from a value that is not an array: \`${sourceOf(tokens)}\``,
      );
    }
    const element = tokens[2].value;
    return current.filter((item) => item !== element);
  }
  throw new Error(
    `fake db cannot compute this SQL value: \`${sourceOf(tokens)}\``,
  );
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

const orderMarkerOf = (value: unknown): OrderMarker => {
  if (isColumn(value)) return { op: "asc", column: refOf(value) };
  if (value instanceof SQL.Aliased) return orderMarkerOf(value.sql);
  if (!(value instanceof SQL)) {
    throw new Error(
      "fake db received an order it cannot read — pass a drizzle-orm ordering",
    );
  }
  const tokens = tokensOf(value);
  const column: SqlToken | undefined = tokens.find(
    (token) => token.kind === "column",
  );
  const text = tokens
    .filter((token) => token.kind === "text")
    .map((token) => token.text)
    .join(" ");
  const match = /^\s*(?:(asc)|(desc))?(?:\s+nulls\s+(first|last))?\s*$/i.exec(
    text,
  );
  if (
    !match ||
    text.trim() === "" ||
    !column ||
    tokens.some((token) => token.kind !== "text" && token.kind !== "column")
  ) {
    throw new Error(
      `fake db cannot interpret this order fragment: \`${sourceOf(tokens)}\``,
    );
  }
  const groups = match.slice(1) as (string | undefined)[];
  return {
    op: groups[1] ? "desc" : "asc",
    column: column.column,
    ...(groups[2]
      ? { nulls: groups[2].toLowerCase() as "first" | "last" }
      : {}),
  };
};

type UniqueConstraint = {
  name: string;
  columns: string[];
  where?: (row: Row) => boolean;
};

type Cascade = {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
};

export type FakeDbOptions = {
  unique?: Record<string, UniqueConstraint[]>;
  // why: mirrors an onDelete: "cascade" foreign key in db/schema.ts, which the fake cannot read
  cascades?: Cascade[];
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

type RowOrigin = { table: string; live: Row; atStart: Row };

const stageStore = (store: Store) => {
  const staged: Store = {};
  const origins = new Map<Row, RowOrigin>();
  for (const [name, rows] of Object.entries(store)) {
    staged[name] = rows.map((live) => {
      const copy = structuredClone(live);
      origins.set(copy, { table: name, live, atStart: structuredClone(live) });
      return copy;
    });
  }
  return { staged, origins };
};

const commitStore = (
  store: Store,
  staged: Store,
  origins: Map<Row, RowOrigin>,
) => {
  const present = new Set(Object.values(staged).flat());
  const touched = new Set<string>();
  const deleted = new Set<Row>();
  for (const [copy, origin] of origins) {
    if (!present.has(copy)) {
      deleted.add(origin.live);
      touched.add(origin.table);
      continue;
    }
    if (isDeepStrictEqual(copy, origin.atStart)) continue;
    touched.add(origin.table);
    for (const [key, value] of Object.entries(copy)) {
      if (isDeepStrictEqual(value, origin.atStart[key])) continue;
      origin.live[key] = value;
    }
    for (const key of Object.keys(origin.atStart)) {
      if (key in copy) continue;
      delete origin.live[key];
    }
  }
  for (const [name, rows] of Object.entries(staged)) {
    if (rows.some((row) => !origins.has(row))) touched.add(name);
  }
  for (const name of touched) {
    const live = (store[name] ??= []);
    for (let i = live.length - 1; i >= 0; i--) {
      if (deleted.has(live[i])) live.splice(i, 1);
    }
    for (const row of staged[name] ?? []) {
      if (!origins.has(row)) live.push(structuredClone(row));
    }
  }
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
    const rowsNamed = (name: string): Row[] => {
      store[name] ??= [];
      return store[name];
    };

    const rowsFor = (table: unknown): Row[] => rowsNamed(nameOf(table));

    const project = (
      row: Row,
      resolve: Resolve,
      selection: Record<string, unknown> | undefined,
      group: Resolve[],
    ): Row => {
      if (!selection) return { ...row };
      const out: Row = {};
      for (const [key, value] of Object.entries(selection)) {
        const aggregate = aggregateOf(value);
        if (aggregate?.kind === "count") {
          out[key] = group.length;
        } else if (aggregate?.kind === "max") {
          const values = group
            .map((r) => r(aggregate.column))
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

        if (
          selection &&
          Object.values(selection).some((value) => aggregateOf(value))
        ) {
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
            const aggregate = aggregateOf(value);
            if (aggregate?.kind === "count" && !aggregate.aliased) {
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
        orderBy(...markers: unknown[]) {
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
      const kept: Row[] = [];
      let staged: Row[] = [];
      let written = false;

      const clashOf = (row: Row): string | undefined => {
        const resolve = flatResolver(row);
        for (const constraint of options.unique?.[name] ?? []) {
          const covers = constraint.where ?? (() => true);
          if (!covers(row)) continue;
          const clashes = rowsFor(table).some(
            (existing) =>
              covers(existing) &&
              constraint.columns.every(
                (column) =>
                  flatResolver(existing)({ table: name, name: column }) ===
                  resolve({ table: name, name: column }),
              ),
          );
          if (clashes) return constraint.name;
        }
        return undefined;
      };

      const write = (ignoreConflicts: boolean) => {
        if (written) return;
        written = true;
        for (const row of staged) {
          options.onInsert?.(name, row);
          const clash = clashOf(row);
          if (clash) {
            if (ignoreConflicts) continue;
            throw uniqueViolation(clash);
          }
          rowsFor(table).push(row);
          kept.push(row);
        }
      };

      return {
        values(values: Row | Row[]) {
          record({ kind: "insert", table: name });
          staged = (Array.isArray(values) ? values : [values]).map((row) => ({
            ...(options.defaults?.[name] ?? {}),
            ...row,
          }));
          const result = {
            returning(selection?: Record<string, unknown>) {
              return Promise.resolve().then(() => {
                write(false);
                return writeResult(kept).returning(selection);
              });
            },
            then(
              onFulfilled?: (result: unknown) => unknown,
              onRejected?: (error: unknown) => unknown,
            ) {
              return Promise.resolve()
                .then(() => {
                  write(false);
                  return undefined;
                })
                .then(onFulfilled, onRejected);
            },
            onConflictDoNothing: () => {
              write(true);
              return result;
            },
            onConflictDoUpdate: () => {
              write(false);
              return result;
            },
          };
          return result;
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
              sqlValueOf(value, resolve),
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

    const deleteRows = (
      name: string,
      predicate: (row: Row) => boolean,
    ): Row[] => {
      const rows = rowsNamed(name);
      const removed = rows.filter(predicate);
      const kept = rows.filter((row) => !removed.includes(row));
      rows.length = 0;
      rows.push(...kept);
      return removed;
    };

    // why: a deleted parent takes the rows whose foreign key cascades from it, and theirs with them
    const cascadeFrom = (parent: string, removed: Row[]) => {
      if (!removed.length) return;
      for (const cascade of options.cascades ?? []) {
        if (cascade.parentTable !== parent) continue;
        const parentKeys = removed.map((row) =>
          flatResolver(row)({ table: parent, name: cascade.parentColumn }),
        );
        const children = deleteRows(cascade.childTable, (row) =>
          parentKeys.includes(
            flatResolver(row)({
              table: cascade.childTable,
              name: cascade.childColumn,
            }),
          ),
        );
        cascadeFrom(cascade.childTable, children);
      }
    };

    const remove = (table: unknown) => ({
      where(condition: Condition) {
        const name = nameOf(table);
        record({ kind: "delete", table: name });
        const deleted = deleteRows(name, (row) =>
          satisfies(flatResolver(row), condition),
        );
        cascadeFrom(name, deleted);
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
        // why: replay only the rows it changed, or writes made outside it while it ran are undone
        const { staged, origins } = stageStore(store);
        const result = await callback(makeHandle(staged));
        commitStore(store, staged, origins);
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
