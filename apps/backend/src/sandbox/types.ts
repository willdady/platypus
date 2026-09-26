import { z } from "zod";
import {
  SANDBOX_TRANSFER_MAX_BYTES,
  type FsEditInput as SdkFsEditInput,
  type FsEditOutput,
  type FsListInput as SdkFsListInput,
  type FsListEntry,
  type FsListOutput,
  type FsReadBytesInput as SdkFsReadBytesInput,
  type FsReadInput as SdkFsReadInput,
  type FsReadOutput,
  type FsWriteBytesInput as SdkFsWriteBytesInput,
  type FsWriteInput as SdkFsWriteInput,
  type FsWriteOutput,
  type SandboxBackend,
  type SandboxCallOptions,
  type SandboxContext,
  type ShellExecInput as SdkShellExecInput,
  type ShellExecOutput,
} from "@platypuschat/plugin-sdk";

// The adapter contract itself is published in `@platypuschat/plugin-sdk` — a
// Sandbox backend is an Extension point, so its shape belongs to the SDK a
// third-party author compiles against, not to core. Core re-exports it here so
// its own modules keep one import path, and so there is exactly one definition
// to change. These were duplicated verbatim until the API v2 sweep; identical
// twins with no compiler link between them is the drift this removes.
export type {
  FsEditOutput,
  FsListEntry,
  FsListOutput,
  FsReadOutput,
  FsWriteOutput,
  SandboxBackend,
  SandboxCallOptions,
  SandboxContext,
  ShellExecOutput,
};

// All paths are workspace-root-relative. The workspace root is conventionally
// "/workspace" inside the sandbox; adapters resolve relative paths against it.
const relativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), {
    message: "path must be relative to the workspace root",
  });

// shell.exec ------------------------------------------------------------------

export const shellExecInputSchema = z.object({
  command: z.string().min(1),
  cwd: relativePathSchema.optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type ShellExecInput = z.infer<typeof shellExecInputSchema>;

// fs.read ---------------------------------------------------------------------

export const fsReadInputSchema = z.object({
  path: relativePathSchema,
  lineRange: z
    .tuple([z.number().int().min(1), z.number().int().min(1)])
    .optional(),
});
export type FsReadInput = z.infer<typeof fsReadInputSchema>;

// fs.write --------------------------------------------------------------------

export const fsWriteInputSchema = z.object({
  path: relativePathSchema,
  content: z.string(),
  mode: z.enum(["create", "overwrite"]),
});
export type FsWriteInput = z.infer<typeof fsWriteInputSchema>;

// fs.edit ---------------------------------------------------------------------

export const fsEditInputSchema = z.object({
  path: relativePathSchema,
  oldString: z.string().min(1),
  newString: z.string(),
});
export type FsEditInput = z.infer<typeof fsEditInputSchema>;

// fs.list ---------------------------------------------------------------------

export const fsListInputSchema = z.object({
  path: relativePathSchema.optional(),
  recursive: z.boolean().optional(),
  glob: z.string().optional(),
});
export type FsListInput = z.infer<typeof fsListInputSchema>;

// fs.readBytes / fs.writeBytes ------------------------------------------------
//
// Not Tools: the optional byte-transfer members (ADR-0027). Bounded by the
// transfer limit an adapter promises to honour, never by the five tools' caps.

export const fsReadBytesInputSchema = z.object({
  path: relativePathSchema,
  maxBytes: z.number().int().positive().max(SANDBOX_TRANSFER_MAX_BYTES),
});
export type FsReadBytesInput = z.infer<typeof fsReadBytesInputSchema>;

export const fsWriteBytesInputSchema = z.object({
  path: relativePathSchema,
  // `custom` over `instanceof`: the latter infers `Uint8Array<ArrayBuffer>`,
  // narrower than the SDK's `Uint8Array`, which may sit on any ArrayBufferLike.
  bytes: z
    .custom<Uint8Array>((v) => v instanceof Uint8Array)
    .refine((b) => b.byteLength <= SANDBOX_TRANSFER_MAX_BYTES, {
      message: `file is larger than ${SANDBOX_TRANSFER_MAX_BYTES} bytes`,
    }),
});
export type FsWriteBytesInput = z.infer<typeof fsWriteBytesInputSchema>;

// Input types stay inferred from the schemas above, because core owns the
// validation an adapter is handed values through — but they must stay the shape
// the published `SandboxBackend` declares, or a core adapter and a third-party
// one would be implementing two different interfaces. Asserted both ways, so a
// drift in either the schema or the SDK is a type error here rather than a
// mismatch nobody notices until an adapter is written against the wrong one.
//
// The alias is deliberately never referenced: its constraints are checked when
// it is declared, which is the whole assertion. The `_` prefix is the repo's
// "intentionally unused" escape hatch, so the unused-vars lint leaves it be.
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
  MutuallyAssignable<FsReadBytesInput, SdkFsReadBytesInput>,
  MutuallyAssignable<SdkFsReadBytesInput, FsReadBytesInput>,
  MutuallyAssignable<FsWriteBytesInput, SdkFsWriteBytesInput>,
  MutuallyAssignable<SdkFsWriteBytesInput, FsWriteBytesInput>,
];

// Registered once per backend type. The discriminator string lives in the
// `sandbox.backend` column. configSchema and credentialsSchema validate the
// jsonb columns before an adapter instance is created.
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
