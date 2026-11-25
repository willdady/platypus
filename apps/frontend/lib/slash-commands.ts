import {
  isBuiltInChatCommandName,
  type BuiltInChatCommandName,
} from "@platypus/schemas";

export type SlashCommand = {
  name: string;
  argumentHint?: string | null;
};

// why: the hook produces this whole bag, so the list and the textarea cannot disagree
export type SlashCommandPickerProps = {
  open: boolean;
  items: SlashCommand[];
  hasCommands: boolean;
  activeName: string | null;
  listboxId: string;
  optionId: (name: string) => string;
  onSelect: (name: string) => void;
};

// why: not filtered by disableModelInvocation — this menu is the user invoking the Skill
export function skillsForAgent<T extends { id: string }>(
  skills: T[],
  skillIds: string[],
): T[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return skillIds.flatMap((id) => {
    const skill = byId.get(id);
    return skill ? [skill] : [];
  });
}

const SLASH_QUERY_PATTERN = /^\/(\S*)$/;

export function slashQueryOf(value: string): string | null {
  return SLASH_QUERY_PATTERN.exec(value)?.[1] ?? null;
}

export function rankSlashCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
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
}

export function completeSlashCommand(name: string): string {
  return `/${name} `;
}

export function builtInCommandOf(
  value: string,
): { name: BuiltInChatCommandName; argument?: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value.trim());
  const name = match?.[1];
  if (name === undefined || !isBuiltInChatCommandName(name)) return null;
  const argument = match?.[2]?.trim();
  return argument ? { name, argument } : { name };
}
