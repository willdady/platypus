// One boot-populated store, shared by every Extension point (ADR-0013).
//
// Tool sets, Sandbox backends, and Web-search backends each keep their own
// instance, but they answer the same questions — register one entry under an id,
// serve it back, list what is registered, refuse a duplicate — and used to answer
// them three slightly different ways: one threw on a miss while the others
// returned `undefined`, one listed a raw map while the others listed arrays, one
// had a test reset and the others did not. Callers had to remember which was
// which, and `getToolSet`'s throw became control flow in the Chat-turn resolver.
// One factory, one contract.

export interface ContributionRegistry<TEntry> {
  /**
   * Store an entry under `id` and return it. Throws when `id` is taken — a
   * second registration is always a bug (two plugins claiming one id, or a
   * plugin colliding with a core built-in), and the plugin loader turns this
   * throw into a boot error naming the plugin.
   */
  register(id: string, entry: TEntry): TEntry;
  /** The entry registered under `id`, or `undefined` when nothing claimed it. */
  get(id: string): TEntry | undefined;
  /** Whether anything is registered under `id`. */
  has(id: string): boolean;
  /** Every registered entry, in registration order. */
  list(): readonly TEntry[];
  /**
   * Test-only reset. Boot registers once and nothing in production
   * unregisters, so this exists to let a test re-register the same id rather
   * than invent a fresh one per case.
   */
  clear(): void;
}

export interface ContributionRegistryOptions {
  /**
   * How this registry's entries are named in its errors, sentence-cased —
   * "Tool set", "Sandbox backend", "Web backend".
   */
  noun: string;
}

/**
 * Create an empty registry for one Extension point.
 *
 * A `Map`, not an object literal: every id reaches these lookups from request
 * data (`agent.toolSetIds`, a save-route body, the `sandbox.backend` and
 * `provider.webBackend` columns), and a plain object answers `"toString" in
 * store` with `true` and hands back `Object.prototype.toString` — an entry the
 * caller then trips over far from the lookup. A `Map` has no inherited keys, so
 * an unregistered id is unregistered whatever it is called.
 */
export const createContributionRegistry = <TEntry>(
  options: ContributionRegistryOptions,
): ContributionRegistry<TEntry> => {
  const entries = new Map<string, TEntry>();

  return {
    register(id, entry) {
      if (entries.has(id)) {
        throw new Error(`${options.noun} '${id}' has already been registered.`);
      }
      entries.set(id, entry);
      return entry;
    },
    get: (id) => entries.get(id),
    has: (id) => entries.has(id),
    list: () => [...entries.values()],
    clear: () => entries.clear(),
  };
};
