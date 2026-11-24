export const WEB_SEARCH_TOOL_NAME = "web_search";

export const READ_URL_TOOL_NAME = "read_url";

export const DELEGATE_TOOL_NAME = "delegate";

export const LOAD_SKILL_TOOL_NAME = "loadSkill";

export const READ_SKILL_FILE_TOOL_NAME = "readSkillFile";

export const WEB_BACKEND_TOOL_NAMES: readonly string[] = [
  WEB_SEARCH_TOOL_NAME,
  READ_URL_TOOL_NAME,
];

export const SKILL_TOOL_NAMES: readonly string[] = [
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
];

export const RESERVED_TURN_TOOL_NAMES: readonly string[] = [
  ...WEB_BACKEND_TOOL_NAMES,
  DELEGATE_TOOL_NAME,
  ...SKILL_TOOL_NAMES,
];
