import { beforeAll, describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import path from "node:path";

type LintResult = ESLint.LintResult;

/**
 * The frontend's `no-restricted-syntax` rules point a mechanical convention
 * violation at the primitive that replaces it (#1868). Each probe reintroduces
 * one pattern the review kept finding by hand and must fail with the message
 * that names the primitive. The primitive's own module, and each legitimate
 * different use, must stay exempt.
 */

const APP_ROOT = import.meta.dirname;

// A real component path the probes are linted through. Any non-exempt path
// works; the rules under test are syntactic, so the file's own types don't
// matter.
const PROBE_FILE = path.join(APP_ROOT, "components", "plugins-list.tsx");

const PROBES = [
  {
    name: "a hand-drawn Disabled badge",
    source: `
import { Badge } from "@/components/ui/badge";

export function DisabledBadgeProbe() {
  return <Badge variant="secondary">Disabled</Badge>;
}
`,
    message:
      "Render a disabled item's badge with DisabledBadge from components/disabled-badge, not a hand-built Badge.",
  },
  {
    name: 'a skeleton labelled "Loading …" by hand',
    source: `
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingRegionProbe() {
  return (
    <div aria-label="Loading agents">
      <Skeleton className="h-4 w-10" />
    </div>
  );
}
`,
    message:
      'Wrap a skeleton in LoadingRegion from components/list-skeletons (label="Loading …"), not an aria-label of your own.',
  },
  {
    name: "a hand-built row ⋮ menu",
    source: `
import { EllipsisVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function RowActionsMenuProbe() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Actions"
          className="focus-visible:outline-none"
        >
          <EllipsisVertical />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Edit</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
`,
    message:
      "Build a list row's ⋮ menu with RowActionsMenu from components/row-actions-menu, not DropdownMenu primitives.",
  },
  {
    name: "an inline by-name sort",
    source: `
export function NameSortProbe({ rows }: { rows: { name: string }[] }) {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}
`,
    message:
      "Sort by name with sortByName() from lib/utils, not an inline comparator.",
  },
  {
    // Not a #1868 rule, but it shares the `no-restricted-syntax` block these
    // rules joined, so a refactor that drops it fails here (#563, ADR-0010).
    name: "a raw write fetch",
    source: `
export async function RawWriteProbe() {
  await fetch("/organizations/org1/agents", { method: "POST" });
}
`,
    message:
      "Writes go through writeEntity()/writeAt() in lib/api-write.ts, not a raw fetch() — see ADR-0010 and #563.",
  },
] as const;

// Each module that draws the pattern by definition, so its own rule leaves it
// alone; the config block beside each name carries the reason.
const EXEMPT_PRIMITIVES = [
  {
    file: "components/disabled-badge.tsx",
    message: PROBES[0].message,
  },
  {
    file: "components/list-skeletons.tsx",
    message: PROBES[1].message,
  },
  {
    file: "components/row-actions-menu.tsx",
    message: PROBES[2].message,
  },
  {
    file: "lib/utils.ts",
    message: PROBES[3].message,
  },
] as const;

// A legitimately different use, exempted with a one-line reason in the config.
const EXEMPT_LEGITIMATE_USES = [
  {
    reason: "the chat sidebar row, not a card",
    file: "components/app-sidebar.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the account menu",
    file: "components/user-menu.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the notification bell",
    file: "components/notifications-dropdown.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the theme picker",
    file: "components/mode-toggle.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the header's settings links",
    file: "components/header.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the board switcher",
    file: "components/kanban-board.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the assignee picker",
    file: "components/kanban-card-dialog.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the vendored prompt-input pickers",
    file: "components/ai-elements/prompt-input.tsx",
    message: PROBES[2].message,
  },
  {
    reason: "the slash-command tier sort",
    file: "lib/slash-commands.ts",
    message: PROBES[3].message,
  },
  {
    reason: "the account trigger's placeholder",
    file: "components/user-menu.tsx",
    message: PROBES[1].message,
  },
  {
    reason: "the model trigger's placeholder",
    file: "components/model-selector-dialog.tsx",
    message: PROBES[1].message,
  },
  {
    reason: "the attached-workspaces count placeholder",
    file: "components/manage-sharing.tsx",
    message: PROBES[1].message,
  },
  {
    reason: "a summary stat's value placeholder",
    file: "app/[orgId]/workspace/[workspaceId]/(sidebar)/page.tsx",
    message: PROBES[1].message,
  },
] as const;

function conventionMessages(result: LintResult) {
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-syntax",
  );
}

describe("frontend convention lint rules", () => {
  let eslint: ESLint;
  let probeEslint: ESLint;
  let fileResults: LintResult[];

  beforeAll(async () => {
    eslint = new ESLint({ cwd: APP_ROOT });
    // Probes lint text under a real file's path. With type information the
    // parser can hand back that file's on-disk AST instead of the probe's,
    // crashing other rules; the rules under test are syntactic, so drop it.
    probeEslint = new ESLint({
      cwd: APP_ROOT,
      overrideConfig: {
        files: ["**/*.tsx"],
        ...tseslint.configs.disableTypeChecked,
      },
    });
    const realFiles = [
      ...EXEMPT_PRIMITIVES.map(({ file }) => path.join(APP_ROOT, file)),
      ...EXEMPT_LEGITIMATE_USES.map(({ file }) => path.join(APP_ROOT, file)),
    ];
    fileResults = await eslint.lintFiles(realFiles);
  }, 120_000);

  it.each(PROBES)(
    "fails $name with the primitive's message",
    async ({ source, message }) => {
      const [result] = await probeEslint.lintText(source, {
        filePath: PROBE_FILE,
      });
      expect(conventionMessages(result).map(({ message }) => message)).toEqual([
        message,
      ]);
    },
  );

  it.each(EXEMPT_PRIMITIVES)(
    "leaves $file exempt from its own rule",
    ({ file, message }) => {
      const result = fileResults.find(
        (candidate) => candidate.filePath === path.join(APP_ROOT, file),
      );
      expect(result, `ESLint did not lint ${file}`).toBeDefined();
      expect(
        conventionMessages(result!).filter(
          (candidate) => candidate.message === message,
        ),
      ).toEqual([]);
    },
  );

  it.each(EXEMPT_LEGITIMATE_USES)(
    "leaves $file ($reason) exempt",
    ({ file, message }) => {
      const result = fileResults.find(
        (candidate) => candidate.filePath === path.join(APP_ROOT, file),
      );
      expect(result, `ESLint did not lint ${file}`).toBeDefined();
      expect(
        conventionMessages(result!).filter(
          (candidate) => candidate.message === message,
        ),
      ).toEqual([]);
    },
  );
});
