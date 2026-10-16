import type { InferUITool } from "ai";
import type { CustomUITools } from "@platypus/schemas";
import type {
  createLoadSkillTool,
  createReadSkillFileTool,
} from "./tools/skill.ts";
import type { DelegateTool } from "./tools/sub-agent.ts";
import type { createFsDownloadTool } from "./sandbox/tools.ts";

// The Chat UI message contract lives in `@platypus/schemas`, hand-written, so
// the frontend can type its messages without compiling backend source. The
// assertions below keep it honest: each custom-UI tool's inferred type must
// equal its contract entry exactly, so changing a tool's input or output fails
// `pnpm typecheck` here until the contract is updated to match.
//
// `loadSkill` is the one partial guard: its execute is annotated with the
// contract's own `SkillLoadResult`, because inference subtype-reduces that
// union to its first member and the assertion could never pass. Its input,
// and its `{ error }` branch, are still checked.
export type {
  ChatMessageMetadata,
  CustomUITools,
  PlatypusDataTypes,
  PlatypusUIMessage,
} from "@platypus/schemas";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// Exported only so the unused-type lint leaves them be; nothing imports them.
export type CustomUIToolsMatchBackend = [
  Expect<
    Equal<
      InferUITool<ReturnType<typeof createLoadSkillTool>>,
      CustomUITools["loadSkill"]
    >
  >,
  Expect<
    Equal<
      InferUITool<ReturnType<typeof createReadSkillFileTool>>,
      CustomUITools["readSkillFile"]
    >
  >,
  Expect<Equal<InferUITool<DelegateTool>, CustomUITools["delegate"]>>,
  Expect<
    Equal<
      InferUITool<ReturnType<typeof createFsDownloadTool>>,
      CustomUITools["fsDownload"]
    >
  >,
];
