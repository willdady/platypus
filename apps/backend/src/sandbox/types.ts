import { z } from "zod";
import {
  type FsEditInput as SdkFsEditInput,
  type FsEditOutput,
  type FsListInput as SdkFsListInput,
  type FsListEntry,
  type FsListOutput,
  type FsReadBytesInput,
  type FsReadInput as SdkFsReadInput,
  type FsReadOutput,
  type FsWriteBytesInput,
  type FsWriteInput as SdkFsWriteInput,
  type FsWriteOutput,
  type SandboxBackend,
  type SandboxCallOptions,
  type SandboxContext,
  type ShellExecInput as SdkShellExecInput,
  type ShellExecOutput,
} from "@platypuschat/plugin-sdk";

export type {
  FsEditOutput,
  FsListEntry,
  FsListOutput,
  FsReadBytesInput,
  FsReadOutput,
  FsWriteBytesInput,
  FsWriteOutput,
  SandboxBackend,
  SandboxCallOptions,
  SandboxContext,
  ShellExecOutput,
};

export const relativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), {
    message: "path must be relative to the workspace root",
  });

export const shellExecInputSchema = z.object({
  command: z.string().min(1),
  cwd: relativePathSchema.optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type ShellExecInput = z.infer<typeof shellExecInputSchema>;

export const fsReadInputSchema = z.object({
  path: relativePathSchema,
  lineRange: z
    .tuple([z.number().int().min(1), z.number().int().min(1)])
    .optional(),
});
export type FsReadInput = z.infer<typeof fsReadInputSchema>;

export const fsWriteInputSchema = z.object({
  path: relativePathSchema,
  content: z.string(),
  mode: z.enum(["create", "overwrite"]),
});
export type FsWriteInput = z.infer<typeof fsWriteInputSchema>;

export const fsEditInputSchema = z.object({
  path: relativePathSchema,
  oldString: z.string().min(1),
  newString: z.string(),
});
export type FsEditInput = z.infer<typeof fsEditInputSchema>;

export const fsListInputSchema = z.object({
  path: relativePathSchema.optional(),
  recursive: z.boolean().optional(),
  glob: z.string().optional(),
});
export type FsListInput = z.infer<typeof fsListInputSchema>;

// why: never referenced; declaring it type-checks the schemas against the SDK inputs
type MutuallyAssignable<A extends B, B extends C, C = A> = true;
type _SandboxInputTypesMatchSdk = [
  MutuallyAssignable<ShellExecInput, SdkShellExecInput>,
  MutuallyAssignable<SdkShellExecInput, ShellExecInput>,
  MutuallyAssignable<FsReadInput, SdkFsReadInput>,
  MutuallyAssignable<SdkFsReadInput, FsReadInput>,
  MutuallyAssignable<FsWriteInput, SdkFsWriteInput>,
  MutuallyAssignable<SdkFsWriteInput, FsWriteInput>,
  MutuallyAssignable<FsEditInput, SdkFsEditInput>,
  MutuallyAssignable<SdkFsEditInput, FsEditInput>,
  MutuallyAssignable<FsListInput, SdkFsListInput>,
  MutuallyAssignable<SdkFsListInput, FsListInput>,
];

export interface SandboxBackendRegistration<
  TConfig = unknown,
  TCredentials = unknown,
> {
  backend: string;
  name: string;
  configSchema: z.ZodType<TConfig>;
  credentialsSchema: z.ZodType<TCredentials>;
  create(config: TConfig, credentials: TCredentials): SandboxBackend;
}
