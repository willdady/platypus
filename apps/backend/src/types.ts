import type { InferUITool } from "ai";
import type { CustomUITools } from "@platypus/schemas";
import type {
  createLoadSkillTool,
  createReadSkillFileTool,
} from "./tools/skill.ts";
import type { DelegateTool } from "./tools/sub-agent.ts";
import type { createFsDownloadTool } from "./sandbox/tools.ts";
import type {
  createCreateOrRewriteArtifactTool,
  createUpdateArtifactTool,
} from "./tools/artifacts.ts";

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

// why: exported only so the unused-type lint keeps it; the assertions fail typecheck on drift
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
  Expect<
    Equal<
      InferUITool<ReturnType<typeof createCreateOrRewriteArtifactTool>>,
      CustomUITools["createArtifact"]
    >
  >,
  Expect<
    Equal<
      InferUITool<ReturnType<typeof createUpdateArtifactTool>>,
      CustomUITools["updateArtifact"]
    >
  >,
];
