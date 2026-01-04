import {
  type UIMessage,
  type InferUITool,
  type InferUITools,
  type UIDataTypes,
} from "ai";
import * as mathTools from "./tools/math";
import * as elicitationTools from "./tools/elicitation";
import { createLoadSkillTool } from "./tools/skill";

export type MathTools = InferUITools<typeof mathTools>;

export type ElicitationTools = InferUITools<typeof elicitationTools>;

export type SkillTools = {
  loadSkill: InferUITool<ReturnType<typeof createLoadSkillTool>>;
};

export type PlatypusTools = MathTools & ElicitationTools & SkillTools;

export type PlatypusUIMessage = UIMessage<any, UIDataTypes, PlatypusTools>;
