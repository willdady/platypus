import {
  type UIMessage,
  type InferUITool,
  type InferUITools,
  type UIDataTypes,
} from "ai";
import * as mathTools from "./tools/math.ts";
import * as elicitationTools from "./tools/elicitation.ts";
import { createLoadSkillTool } from "./tools/skill.ts";
import { createNewTaskTool, createTaskResultTool } from "./tools/sub-agent.ts";

export type MathTools = InferUITools<typeof mathTools>;

export type ElicitationTools = InferUITools<typeof elicitationTools>;

export type SkillTools = {
  loadSkill: InferUITool<ReturnType<typeof createLoadSkillTool>>;
};

export type SubAgentTools = {
  newTask: InferUITool<ReturnType<typeof createNewTaskTool>>;
  taskResult: InferUITool<ReturnType<typeof createTaskResultTool>>;
};

export type PlatypusTools = MathTools & ElicitationTools & SkillTools & SubAgentTools;

export type PlatypusUIMessage = UIMessage<any, UIDataTypes, PlatypusTools>;
