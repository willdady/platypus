import type { CodeHighlighterPlugin, ThemeInput } from "@streamdown/code";
import type { DiagramPlugin } from "@streamdown/mermaid";

// why: @streamdown/code's own default; each highlight call carries the real themes
const codeThemes: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];

let code: CodeHighlighterPlugin | undefined;
let codeLoad: Promise<CodeHighlighterPlugin> | undefined;
function loadCode() {
  return (codeLoad ??= import("@streamdown/code").then((m) => (code = m.code)));
}

// why: proxies keep shiki and mermaid off every page that renders a message
export const lazyCode: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => codeThemes,
  // why: Streamdown reads neither; answer as the real plugin will once loaded
  supportsLanguage: (language) => code?.supportsLanguage(language) ?? true,
  getSupportedLanguages: () => code?.getSupportedLanguages() ?? [],
  highlight(options, callback) {
    if (code) return code.highlight(options, callback);
    loadCode()
      .then((loaded) => {
        const result = loaded.highlight(options, callback);
        if (result) callback?.(result);
      })
      // why: a failed load leaves the block plain text, as it is while loading
      .catch((error) => console.error("Failed to load the highlighter", error));
    return null;
  },
};

let mermaidLoad: Promise<DiagramPlugin> | undefined;
function loadMermaid() {
  return (mermaidLoad ??= import("@streamdown/mermaid").then((m) => m.mermaid));
}

export const lazyMermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid: (config) => ({
    initialize: (next) => {
      void loadMermaid().then((plugin) => plugin.getMermaid().initialize(next));
    },
    render: async (id, source) =>
      (await loadMermaid()).getMermaid(config).render(id, source),
  }),
};
