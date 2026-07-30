// Building with Platypus section order. Audience: Workspace Owner.
// Chat comes first — it is the screen everyone uses before they build anything.
// Then the build sequence: the Agent, the capabilities you give it (Skills, tool
// sets, MCP), the surfaces it works against (Triggers, Boards, Dashboards,
// Notifications), and integrating outward (Webhooks). The worked example sits
// last because it uses every form above it.
const meta = {
  index: "Overview",
  chat: "Chat",
  agents: "Agents & sub-agents",
  skills: "Skills",
  "tool-sets": "Tool sets",
  mcp: "MCP servers",
  triggers: "Triggers",
  boards: "Boards",
  dashboards: "Dashboards",
  notifications: "Notifications",
  webhooks: "Webhooks",
  "standup-bot": "Worked example: a standup bot",
};

export default meta;
