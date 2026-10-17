import type { CodeHighlighterPlugin, ThemeInput } from "@streamdown/code";
import type { DiagramPlugin } from "@streamdown/mermaid";

/**
 * Streamdown's code and diagram plugins, loaded the first time a reply
 * actually has a code block or a diagram. The real plugins import shiki and
 * mermaid at the top level, which would put both on every page that renders
 * a message. Streamdown already treats both as asynchronous — a highlight may
 * answer later through its callback, a diagram render is awaited — so these
 * stand in until the real one arrives and then hand straight through.
 */

// @streamdown/code's own default; the themes ride each highlight call anyway.
const codeThemes: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];

let code: CodeHighlighterPlugin | undefined;
let codeLoad: Promise<CodeHighlighterPlugin> | undefined;
function loadCode() {
  return (codeLoad ??= import("@streamdown/code").then((m) => (code = m.code)));
}

export const lazyCode: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => codeThemes,
  // Neither is read by Streamdown; answered as the real plugin would once it
  // is here.
  supportsLanguage: (language) => code?.supportsLanguage(language) ?? true,
  getSupportedLanguages: () => code?.getSupportedLanguages() ?? [],
  highlight(options, callback) {
    if (code) return code.highlight(options, callback);
    loadCode()
      .then((loaded) => {
        const result = loaded.highlight(options, callback);
        if (result) callback?.(result);
      })
      // The block stays plain text, as it is while loading.
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
