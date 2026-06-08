// Building with Platypus section order. Audience: Workspace Owner (ADR-0011).
// Ordered as a build sequence: the Agent first, then the capabilities you give
// it (Skills, MCP), then the surfaces it works against (Triggers, Boards,
// Dashboards).
const meta = {
  index: "Overview",
  agents: "Agents & sub-agents",
  skills: "Skills",
  mcp: "MCP servers",
  triggers: "Triggers",
  boards: "Boards",
  dashboards: "Dashboards",
};

export default meta;
