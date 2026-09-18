/**
 * The slash-command grammar, client side.
 *
 * A command is a Skill invoked from the chat input: the user types `/`, picks a
 * Skill, and sends an ordinary message that happens to start with the token.
 * The text is the whole wire format — the backend parses the name off the first
 * text part of the message it receives — so nothing here has to survive
 * anywhere but the textarea (issue #649).
 */

/** What the picker needs of a Skill to offer it. */
export type SlashCommand = {
  name: string;
  description: string;
  argumentHint?: string | null;
};

/**
 * What the picker renders. Produced whole by `useSlashCommands`, so the surface
 * hosting the composer spreads one bag rather than threading six props and
 * risking a disagreement between the list and the textarea's ARIA state.
 *
 * Declared here beside the grammar rather than on the component, so the hook
 * that produces it does not have to import from the view it feeds.
 */
export type SlashCommandPickerProps = {
  open: boolean;
  /** The ranked matches for what has been typed so far. */
  items: SlashCommand[];
  /** Whether the Agent has any Skills at all — the two empty states differ. */
  hasCommands: boolean;
  /** The highlighted command, or `null` when there is nothing to accept. */
  activeName: string | null;
  listboxId: string;
  optionId: (name: string) => string;
  onSelect: (name: string) => void;
};

/**
 * The Skills the picker offers: the Workspace's Skills narrowed to this Agent's
 * assignment, in assignment order.
 *
 * Deliberately NOT filtered by `disableModelInvocation` — that flag removes a
 * Skill from the *model's* catalogue, and this menu is the user invoking one
 * themselves, which is the case the flag exists for.
 */
export const skillsForAgent = <T extends { id: string }>(
  skills: T[],
  skillIds: string[] | undefined,
): T[] => {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return (skillIds ?? []).flatMap((id) => {
    const skill = byId.get(id);
    return skill ? [skill] : [];
  });
};

/**
 * The picker is open while the whole value is one unfinished token at position
 * 0. That single rule covers both halves of the behaviour: `/` typed anywhere
 * but the start never matches, and the first space ends the command and closes
 * the picker — which is also where the user starts writing their prompt.
 *
 * Looser than a Skill name on purpose: this asks "is a command being typed?",
 * not "is this a name?". `/usr/bin` has to keep the picker open long enough to
 * say nothing matches — that muted line is the only warning a typo gets before
 * Enter. The backend's parser is the strict one, built from the name shape
 * `@platypus/schemas` enforces on save.
 */
const SLASH_QUERY_PATTERN = /^\/(\S*)$/;

/** The partial name being typed, or `null` when the value is not a command. */
export const slashQueryOf = (value: string): string | null =>
  SLASH_QUERY_PATTERN.exec(value)?.[1] ?? null;

/**
 * The commands matching `query`, best first: an exact name, then names that
 * start with it, then names that merely contain it, alphabetically within each
 * tier.
 *
 * The tiers exist for prefix collisions. With `/deploy` typed and both
 * `deploy` and `deploy-staging` assigned, both stay candidates — but the one
 * the user has fully typed is the one highlighted, so Tab accepts what is
 * visibly selected rather than whichever name happened to sort first.
 */
export const rankSlashCommands = (
  commands: SlashCommand[],
  query: string,
): SlashCommand[] => {
  const needle = query.toLowerCase();
  const tierOf = (name: string): number => {
    const haystack = name.toLowerCase();
    if (haystack === needle) return 0;
    if (haystack.startsWith(needle)) return 1;
    if (haystack.includes(needle)) return 2;
    return 3;
  };

  return commands
    .map((command) => ({ command, tier: tierOf(command.name) }))
    .filter(({ tier }) => tier < 3)
    .sort(
      (a, b) => a.tier - b.tier || a.command.name.localeCompare(b.command.name),
    )
    .map(({ command }) => command);
};

/**
 * The value a completed command leaves in the textarea. The trailing space both
 * closes the picker and puts the caret where the user's prompt goes.
 */
export const completeSlashCommand = (name: string): string => `/${name} `;
