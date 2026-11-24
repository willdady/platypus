export interface ContributionRegistry<TEntry> {
  register(id: string, entry: TEntry): TEntry;
  get(id: string): TEntry | undefined;
  has(id: string): boolean;
  list(): readonly TEntry[];
}

export interface ContributionRegistryOptions {
  noun: string;
}

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
  };
};
