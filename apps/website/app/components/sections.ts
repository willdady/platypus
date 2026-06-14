// Single source of truth for the in-page anchor sections. The nav renders a
// scroll-link per entry and the scrollspy observes these ids; page.tsx tags the
// matching <section id>. Order matches the visual order down the page.
export const NAV_SECTIONS = [
  { id: "features", label: "Features" },
  { id: "agents", label: "Agents" },
  { id: "boards", label: "Boards" },
  { id: "how-it-works", label: "How it works" },
  { id: "get-started", label: "Get started" },
] as const;

export const GITHUB_URL = "https://github.com/willdady/platypus";
export const DOCS_URL = "https://docs.platypus.chat";
