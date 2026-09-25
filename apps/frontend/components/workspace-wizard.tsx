"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { Box, Unplug } from "lucide-react";
import {
  CONTEXT_MAX_LENGTH,
  workspaceCreateSchema,
  type Provider,
  type Workspace,
} from "@platypus/schemas";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { writeEntity, type WriteOutcome } from "@/lib/api-write";
import {
  parseValidationErrors,
  retractFieldError,
  type FormErrors,
} from "@/lib/form-errors";
import { workspaceRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ProviderForm } from "@/components/provider-form";
import { SandboxSettings } from "@/components/sandbox-settings";
import { FormTextField } from "@/components/form-text-field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STEPS = ["Workspace", "Provider", "Sandbox"] as const;

// Each step is checked against the same schema the backend validates the
// create with, so a step the user has left can't fail the final write.
const workspaceStepSchema = workspaceCreateSchema.pick({
  name: true,
  context: true,
});
const providerStepSchema = workspaceCreateSchema.shape.provider.unwrap();
const sandboxStepSchema = workspaceCreateSchema.shape.sandbox.unwrap();

type Member = { userId: string; user: { name: string; email: string } };

const invalid = (issues: readonly unknown[]): WriteOutcome<undefined> => ({
  outcome: "invalid",
  message: "Please fix the errors below",
  fieldErrors: parseValidationErrors({ error: issues }),
});

const accepted: WriteOutcome<undefined> = {
  outcome: "success",
  data: undefined,
  revalidateKeys: [],
};

/**
 * Creates a Workspace ready to use: its details, then a Provider (a new one,
 * or Shared ones attached), then an optional Sandbox. Nothing is written until
 * the last step, which creates all of it in one request — a Workspace without
 * a Provider cannot run a Chat, so none is created without one.
 */
export const WorkspaceWizard = ({ orgId }: { orgId: string }) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  // Empty until the admin picks someone else: the backend defaults the owner
  // to the caller (ADR-0008).
  const [ownerId, setOwnerId] = useState("");
  const [workspaceErrors, setWorkspaceErrors] = useState<FormErrors>({});

  const [providerSource, setProviderSource] = useState<"new" | "shared">("new");
  const [provider, setProvider] = useState<Record<string, unknown>>();
  const [sharedProviderIds, setSharedProviderIds] = useState<string[]>([]);

  const [withSandbox, setWithSandbox] = useState(false);

  // Only admins reach this page (ADR-0008), and these reads are admin-only.
  const { data: membersData } = useScopedSWR<{ results: Member[] }>("members", {
    orgId,
  });
  const { data: sharedData } = useScopedSWR<{ results: Provider[] }>(
    "providers",
    { orgId },
  );
  const { data: backendsData } = useScopedSWR<{ results: unknown[] }>(
    "sandbox-backends",
    { orgId },
  );
  const members = membersData?.results ?? [];
  const sharedProviders = sharedData?.results ?? [];
  const hasSandboxBackends = (backendsData?.results.length ?? 0) > 0;

  // A super-admin acting on an org they're not enrolled in won't appear in
  // /members, but the backend lets them own a workspace by defaulting to
  // themselves (ADR-0008). Always offer the current user so the default
  // resolves to a real, selectable option.
  const ownerOptions =
    user && !members.some((m) => m.userId === user.id)
      ? [
          { userId: user.id, user: { name: user.name, email: user.email } },
        ].concat(members)
      : members;

  const nextFromWorkspace = () => {
    const parsed = workspaceStepSchema.safeParse({
      name,
      context: context || null,
    });
    if (!parsed.success) {
      setWorkspaceErrors(parseValidationErrors({ error: parsed.error.issues }));
      return;
    }
    setStep(1);
  };

  const stashProvider = async (
    payload: Record<string, unknown>,
  ): Promise<WriteOutcome<undefined>> => {
    const parsed = providerStepSchema.safeParse(payload);
    if (!parsed.success) return invalid(parsed.error.issues);
    setProvider(payload);
    setStep(2);
    return accepted;
  };

  const create = async (
    sandbox?: Record<string, unknown>,
  ): Promise<WriteOutcome<undefined>> => {
    if (sandbox) {
      const parsed = sandboxStepSchema.safeParse(sandbox);
      if (!parsed.success) return invalid(parsed.error.issues);
    }
    const outcome = await writeEntity<Workspace>(
      backendUrl,
      "workspaces",
      { orgId },
      {
        data: {
          name,
          context: context || null,
          ownerId: ownerId || undefined,
          ...(providerSource === "new" ? { provider } : { sharedProviderIds }),
          sandbox,
        },
      },
    );
    if (outcome.outcome === "success") {
      outcome.revalidateKeys.forEach((key) => mutate(key));
      toast.success("Workspace created");
      router.push(workspaceRoutes(orgId, outcome.data.id).root);
      return accepted;
    }
    if (outcome.outcome === "invalid") {
      // Only the Sandbox's fields are on screen to show an error against; the
      // other steps passed the same schema before the user left them.
      const sandboxErrors = Object.fromEntries(
        Object.entries(outcome.fieldErrors)
          .filter(([key]) => key.startsWith("sandbox."))
          .map(([key, message]) => [key.slice("sandbox.".length), message]),
      );
      return Object.keys(sandboxErrors).length > 0
        ? { ...outcome, fieldErrors: sandboxErrors }
        : { outcome: "error", message: outcome.message };
    }
    return outcome;
  };

  const createWithoutSandbox = async () => {
    setIsSubmitting(true);
    try {
      const outcome = await create();
      if (outcome.outcome !== "success") toast.error(outcome.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const back = () => setStep((s) => s - 1);

  return (
    <div>
      <ol className="mb-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={cn(
              "flex items-center gap-2",
              index === step ? "font-medium" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs",
                index <= step &&
                  "border-primary bg-primary text-primary-foreground",
              )}
            >
              {index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>

      {/* Every step stays mounted, so going back keeps what was entered. */}
      <div hidden={step !== 0}>
        <FieldSet className="mb-6">
          <FieldGroup>
            <FormTextField
              label="Name"
              // Distinct from the Provider and Sandbox forms' `name`, which
              // are mounted alongside it.
              name="workspace-name"
              placeholder="Workspace name"
              value={name}
              onChange={(value) => {
                setWorkspaceErrors((prev) => retractFieldError(prev, "name"));
                setName(value);
              }}
              error={workspaceErrors.name}
              autoFocus
            />

            {/* ADR-0008: on creation an admin assigns the workspace owner. */}
            <Field>
              <FieldLabel htmlFor="ownerId">Owner</FieldLabel>
              <Select value={ownerId || user?.id} onValueChange={setOwnerId}>
                <SelectTrigger id="ownerId">
                  <SelectValue placeholder="Select an owner" />
                </SelectTrigger>
                <SelectContent>
                  {ownerOptions.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.user.name || m.user.email}
                      {m.userId === user?.id ? " (you)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                The member who will own this workspace. Defaults to you.
              </FieldDescription>
            </Field>

            <Field data-invalid={!!workspaceErrors.context}>
              <ExpandableTextarea
                id="workspace-context"
                label="Context"
                placeholder="Optional context for this workspace"
                value={context}
                onChange={(e) => {
                  setWorkspaceErrors((prev) =>
                    retractFieldError(prev, "context"),
                  );
                  setContext(e.target.value);
                }}
                aria-invalid={!!workspaceErrors.context}
                className="!font-mono"
                maxLength={CONTEXT_MAX_LENGTH}
              />
              <FieldDescription>
                Additional context about this workspace included in all chats in
                this workspace
              </FieldDescription>
              {workspaceErrors.context && (
                <FieldError>{workspaceErrors.context}</FieldError>
              )}
            </Field>
          </FieldGroup>
        </FieldSet>
        <Button onClick={nextFromWorkspace}>Next</Button>
      </div>

      <div hidden={step !== 1}>
        <p className="mb-6 text-sm text-muted-foreground">
          A workspace needs at least one provider before it can run chats or
          agents.
        </p>
        <Tabs
          value={providerSource}
          onValueChange={(value) =>
            setProviderSource(value as "new" | "shared")
          }
        >
          <TabsList className="mb-6">
            <TabsTrigger value="new">New provider</TabsTrigger>
            <TabsTrigger value="shared">Shared provider</TabsTrigger>
          </TabsList>
          {/* Force-mounted so switching tabs keeps a half-filled form. */}
          <TabsContent
            value="new"
            forceMount
            className="data-[state=inactive]:hidden"
          >
            <ProviderForm
              orgId={orgId}
              draft={{ write: stashProvider, onBack: back, submitText: "Next" }}
            />
          </TabsContent>
          <TabsContent
            value="shared"
            forceMount
            className="data-[state=inactive]:hidden"
          >
            {sharedProviders.length === 0 ? (
              <Empty className="mb-6 border-2 border-dashed">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Unplug className="size-6" />
                  </EmptyMedia>
                  <EmptyTitle>No shared providers</EmptyTitle>
                  <EmptyDescription>
                    This organization has no shared providers yet. Create a new
                    provider for this workspace instead.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <FieldSet className="mb-6">
                <FieldGroup>
                  {sharedProviders.map((p) => (
                    <Field
                      key={p.id}
                      orientation="horizontal"
                      className="items-center justify-between"
                    >
                      <FieldLabel htmlFor={`shared-${p.id}`}>
                        {p.name}
                      </FieldLabel>
                      <Switch
                        id={`shared-${p.id}`}
                        checked={sharedProviderIds.includes(p.id)}
                        onCheckedChange={(on) =>
                          setSharedProviderIds((prev) =>
                            on
                              ? [...prev, p.id]
                              : prev.filter((id) => id !== p.id),
                          )
                        }
                      />
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={back}>
                Back
              </Button>
              <Button
                onClick={() => setStep(2)}
                disabled={sharedProviderIds.length === 0}
              >
                Next
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <div hidden={step !== 2}>
        <Field
          orientation="horizontal"
          className="mb-6 items-center justify-between"
        >
          <div>
            <FieldLabel htmlFor="withSandbox">Configure a sandbox</FieldLabel>
            <FieldDescription>
              {hasSandboxBackends
                ? "Optional. Gives agents shell and filesystem tools in an isolated environment. You can add one later in the workspace settings."
                : "No sandbox backends are installed on this server."}
            </FieldDescription>
          </div>
          <Switch
            id="withSandbox"
            checked={withSandbox}
            onCheckedChange={setWithSandbox}
            disabled={!hasSandboxBackends || isSubmitting}
          />
        </Field>
        {withSandbox ? (
          <SandboxSettings
            orgId={orgId}
            draft={{ write: create, onBack: back, submitText: "Save" }}
          />
        ) : (
          <>
            <Empty className="mb-6 border-2 border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Box className="size-6" />
                </EmptyMedia>
                <EmptyTitle>No sandbox</EmptyTitle>
                <EmptyDescription>
                  Agents in this workspace won&apos;t have shell or filesystem
                  tools.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
            <div className="flex gap-2">
              <Button variant="outline" onClick={back} disabled={isSubmitting}>
                Back
              </Button>
              <Button onClick={createWithoutSandbox} disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : "Save"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
