"use client";

import { toast } from "sonner";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { OrgGate, OrgGateAccess as Access } from "@platypus/schemas";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, FieldDescription, FieldTitle } from "@/components/ui/field";
import { SelectItem } from "@/components/ui/select";
import { FormSelectField } from "@/components/form-select-field";
import { FieldSkeleton } from "@/components/form-skeleton";
import { LoadingRegion } from "@/components/list-skeletons";
import { ListError } from "@/components/list-state";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useEntityForm } from "@/hooks/use-entity-form";
import { scopedUrl, writeAt } from "@/lib/api-write";

const GATE_OPTIONS: { value: OrgGate; label: string }[] = [
  { value: "off", label: "No workspaces" },
  { value: "all", label: "All workspaces" },
  { value: "selected", label: "Selected workspaces" },
];

type Draft = { gate: OrgGate; allowed: Set<string> };

function sameSet(a: Set<string>, b: Set<string>) {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** One Workspace as a gate's access screen lists it. */
type GateWorkspace = Access["workspaces"][number];

/** What differs between the Organization's gates: where, and the words. */
type GateCopy = {
  /** The API path under the Organization the access is read and saved at. */
  entity: string;
  /** Lower case, for "Loading …" and the load error. */
  subject: string;
  savedMessage: string;
  selectLabel: string;
  selectName: string;
  selectDescription: string;
  allowedDescription: string;
  /** The column header for how many gated resources a Workspace holds. */
  countHeader: string;
  /**
   * The warning for Workspaces with resources the save would cut off. Absent
   * where shutting a Workspace out leaves what it has working.
   */
  cutOffMessage?: (cutOff: GateWorkspace[]) => string;
};

/**
 * Which Workspaces an Organization gate lets in: the gate and, under Selected
 * workspaces, each Workspace's switch. Staged and saved in one write, so
 * switching to Selected never refuses calls for the Workspaces that should
 * keep them while the Admin ticks them one by one.
 */
export function OrgGateAccess({
  orgId,
  copy,
}: {
  orgId: string;
  copy: GateCopy;
}) {
  const backendUrl = useBackendUrl();
  const scope = { orgId };
  const { data, error, isLoading, mutate } = useScopedSWR<Access>(
    copy.entity,
    scope,
  );
  // The Admin's unsaved edits; null shows what is saved. Cleared on save, so
  // the next read is shown as it stands.
  const [draft, setDraft] = useState<Draft | null>(null);

  const savedAllowed = new Set(
    data?.workspaces.filter((ws) => ws.allowed).map((ws) => ws.id),
  );
  const { gate, allowed } = draft ?? {
    gate: data?.gate ?? "off",
    allowed: savedAllowed,
  };

  const { isSubmitting: isSaving, submit } = useEntityForm<object, Access>({
    initialData: {},
    entity: copy.entity,
    scope,
    // The staged draft lives outside the hook's form state, so the write
    // reads it directly rather than through `formData`.
    write: () =>
      writeAt<Access>(scopedUrl(backendUrl, copy.entity, scope), {
        method: "PUT",
        data: {
          gate,
          ...(gate === "selected" ? { allowedWorkspaceIds: [...allowed] } : {}),
        },
      }),
    // No field here renders a server error, so a rejection is toasted.
    onInvalid: (_fieldErrors, message) => toast.error(message),
    successMessage: copy.savedMessage,
    onSuccess: async (saved) => {
      await mutate(saved, { revalidate: false });
      setDraft(null);
    },
  });

  if (isLoading) {
    return (
      <LoadingRegion label={`Loading ${copy.subject}`}>
        <FieldSkeleton description={2} />
      </LoadingRegion>
    );
  }

  if (error && !data) {
    return <ListError error={error} subject={copy.subject} />;
  }
  if (!data) return null;

  // The switches only count under Selected; elsewhere they are left as saved.
  const dirty =
    gate !== data.gate ||
    (gate === "selected" && !sameSet(allowed, savedAllowed));
  const cutOff =
    gate === "selected"
      ? data.workspaces.filter((ws) => ws.count > 0 && !allowed.has(ws.id))
      : [];

  const setGate = (next: OrgGate) => setDraft({ gate: next, allowed });
  const toggle = (workspaceId: string, on: boolean) => {
    const next = new Set(allowed);
    if (on) next.add(workspaceId);
    else next.delete(workspaceId);
    setDraft({ gate, allowed: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <FormSelectField
        label={copy.selectLabel}
        name={copy.selectName}
        value={gate}
        onValueChange={(value) => setGate(value as OrgGate)}
        disabled={isSaving}
        description={copy.selectDescription}
      >
        {GATE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </FormSelectField>

      {gate === "selected" && (
        <Field aria-labelledby="org-gate-allowed-workspaces-label">
          <FieldTitle id="org-gate-allowed-workspaces-label">
            Allowed workspaces
          </FieldTitle>
          <FieldDescription>{copy.allowedDescription}</FieldDescription>
          {data.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This organization has no workspaces yet.
            </p>
          ) : (
            <Table bordered>
              <TableHeader>
                <TableRow>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>{copy.countHeader}</TableHead>
                  <TableHead className="text-right">Allowed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.workspaces.map((ws) => (
                  <TableRow key={ws.id}>
                    <TableCell className="font-medium">{ws.name}</TableCell>
                    <TableCell>{ws.ownerName}</TableCell>
                    <TableCell>{ws.count}</TableCell>
                    <TableCell className="text-right">
                      <Switch
                        aria-label={`Allow ${ws.name}`}
                        checked={allowed.has(ws.id)}
                        disabled={isSaving}
                        onCheckedChange={(on) => toggle(ws.id, on)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Field>
      )}

      {copy.cutOffMessage && cutOff.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Calls will be refused</AlertTitle>
          <AlertDescription>{copy.cutOffMessage(cutOff)}</AlertDescription>
        </Alert>
      )}

      <div>
        <Button
          type="button"
          disabled={!dirty || isSaving}
          onClick={() => void submit()}
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

const INBOUND_TRIGGER_GATE: GateCopy = {
  entity: "inbound-triggers/access",
  subject: "inbound trigger access",
  savedMessage: "Inbound Trigger access saved",
  selectLabel: "Allow Inbound Triggers in",
  selectName: "inboundTriggerGate",
  selectDescription:
    "Which workspaces can use Inbound Triggers. Changes apply straight away, and no triggers are deleted.",
  allowedDescription:
    "Only the workspaces switched on here take calls. Saved together with the setting above. A workspace's own settings show the same switch.",
  countHeader: "Inbound Triggers",
  cutOffMessage: (cutOff) =>
    cutOff.length === 1
      ? `${cutOff[0].name} has Inbound Triggers but isn't allowed, so its calls will be refused.`
      : `${cutOff.length} workspaces with Inbound Triggers aren't allowed, so their calls will be refused: ${cutOff.map((ws) => ws.name).join(", ")}.`,
};

/** Which Workspaces take Inbound Trigger calls (ADR-0030). */
export function OrgInboundTriggerAccess({ orgId }: { orgId: string }) {
  return <OrgGateAccess orgId={orgId} copy={INBOUND_TRIGGER_GATE} />;
}

const A2A_GATE: GateCopy = {
  entity: "a2a/access",
  subject: "A2A access",
  savedMessage: "A2A access saved",
  selectLabel: "Allow A2A endpoints in",
  selectName: "a2aGate",
  selectDescription:
    "Which workspaces can make their agents reachable over A2A. Changes apply straight away, and no endpoints are deleted.",
  allowedDescription:
    "Only the workspaces switched on here answer A2A calls. Saved together with the setting above.",
  countHeader: "A2A endpoints",
  cutOffMessage: (cutOff) =>
    cutOff.length === 1
      ? `${cutOff[0].name} has A2A endpoints but isn't allowed, so they will stop answering.`
      : `${cutOff.length} workspaces with A2A endpoints aren't allowed, so their endpoints will stop answering: ${cutOff.map((ws) => ws.name).join(", ")}.`,
};

/**
 * Which Workspaces may have A2A endpoints (ADR-0032). Separate from the
 * Inbound Trigger gate, and off by default.
 */
export function OrgA2aAccess({ orgId }: { orgId: string }) {
  return <OrgGateAccess orgId={orgId} copy={A2A_GATE} />;
}

const SKILL_IMPORT_GATE: GateCopy = {
  entity: "skill-import/access",
  subject: "skill import access",
  savedMessage: "Skill import access saved",
  selectLabel: "Allow importing skills in",
  selectName: "skillImportGate",
  selectDescription:
    "Which workspaces can import skill bundles: from a zip, by replacing a bundle, or from GitHub. Skills already imported stay, and anyone can still write a skill by hand.",
  allowedDescription:
    "Only the workspaces switched on here can import skills. Saved together with the setting above.",
  countHeader: "Skills",
};

/**
 * Which Workspaces may import Skill bundles (ADR-0037). On by default for
 * every Workspace; importing at Organization scope is never gated.
 */
export function OrgSkillImportAccess({ orgId }: { orgId: string }) {
  return <OrgGateAccess orgId={orgId} copy={SKILL_IMPORT_GATE} />;
}
