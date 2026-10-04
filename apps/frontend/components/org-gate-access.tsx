"use client";

import { useState } from "react";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import type {
  A2aAccess,
  InboundTriggerAccess,
  InboundTriggerGate,
} from "@platypus/schemas";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { SelectItem } from "@/components/ui/select";
import { FormSelectField } from "@/components/form-select-field";
import { FieldSkeleton } from "@/components/form-skeleton";
import { LoadingRegion } from "@/components/list-skeletons";
import { ListError } from "@/components/list-state";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { scopedUrl, writeAt } from "@/lib/api-write";

const GATE_OPTIONS: { value: InboundTriggerGate; label: string }[] = [
  { value: "off", label: "No workspaces" },
  { value: "all", label: "All workspaces" },
  { value: "selected", label: "Selected workspaces" },
];

type Draft = { gate: InboundTriggerGate; allowed: Set<string> };

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** One Workspace as a gate's access screen lists it. */
type GateWorkspace = {
  id: string;
  name: string;
  ownerName: string;
  allowed: boolean;
};

type Access<W extends GateWorkspace> = {
  gate: InboundTriggerGate;
  workspaces: W[];
};

/** What differs between the Organization's gates: where, and the words. */
type GateCopy<W extends GateWorkspace> = {
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
  countOf: (workspace: W) => number;
  /** The warning for Workspaces with resources the save would cut off. */
  cutOffMessage: (cutOff: W[]) => string;
};

/**
 * Which Workspaces an Organization gate lets in: the gate and, under Selected
 * workspaces, each Workspace's switch. Staged and saved in one write, so
 * switching to Selected never refuses calls for the Workspaces that should
 * keep them while the Admin ticks them one by one.
 */
export const OrgGateAccess = <W extends GateWorkspace>({
  orgId,
  copy,
}: {
  orgId: string;
  copy: GateCopy<W>;
}) => {
  const backendUrl = useBackendUrl();
  const scope = { orgId };
  const { data, error, isLoading, mutate } = useScopedSWR<Access<W>>(
    copy.entity,
    scope,
  );
  // The Admin's unsaved edits; null shows what is saved. Cleared on save, so
  // the next read is shown as it stands.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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

  const savedAllowed = new Set(
    data.workspaces.filter((ws) => ws.allowed).map((ws) => ws.id),
  );
  const { gate, allowed } = draft ?? { gate: data.gate, allowed: savedAllowed };
  // The switches only count under Selected; elsewhere they are left as saved.
  const dirty =
    gate !== data.gate ||
    (gate === "selected" && !sameSet(allowed, savedAllowed));
  const cutOff =
    gate === "selected"
      ? data.workspaces.filter(
          (ws) => copy.countOf(ws) > 0 && !allowed.has(ws.id),
        )
      : [];

  const setGate = (next: InboundTriggerGate) =>
    setDraft({ gate: next, allowed });
  const toggle = (workspaceId: string, on: boolean) => {
    const next = new Set(allowed);
    if (on) next.add(workspaceId);
    else next.delete(workspaceId);
    setDraft({ gate, allowed: next });
  };

  const handleSave = async () => {
    if (!backendUrl) return;
    setIsSaving(true);
    const outcome = await writeAt<Access<W>>(
      scopedUrl(backendUrl, copy.entity, scope),
      {
        method: "PUT",
        data: {
          gate,
          ...(gate === "selected" ? { allowedWorkspaceIds: [...allowed] } : {}),
        },
      },
    );
    if (outcome.outcome === "success") {
      toast.success(copy.savedMessage);
      await mutate(outcome.data, { revalidate: false });
      setDraft(null);
    } else {
      toast.error(outcome.message);
    }
    setIsSaving(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <FormSelectField
        label={copy.selectLabel}
        name={copy.selectName}
        value={gate}
        onValueChange={(value) => setGate(value as InboundTriggerGate)}
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
        <Field>
          <FieldLabel>Allowed workspaces</FieldLabel>
          <FieldDescription>{copy.allowedDescription}</FieldDescription>
          {data.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This organization has no workspaces yet.
            </p>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
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
                        <TableCell>{copy.countOf(ws)}</TableCell>
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
              </div>
            </div>
          )}
        </Field>
      )}

      {cutOff.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Calls will be refused</AlertTitle>
          <AlertDescription>{copy.cutOffMessage(cutOff)}</AlertDescription>
        </Alert>
      )}

      <div>
        <Button
          type="button"
          className="cursor-pointer"
          disabled={!dirty || isSaving}
          onClick={() => void handleSave()}
        >
          Save
        </Button>
      </div>
    </div>
  );
};

const INBOUND_TRIGGER_GATE: GateCopy<
  InboundTriggerAccess["workspaces"][number]
> = {
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
  countOf: (ws) => ws.inboundTriggerCount,
  cutOffMessage: (cutOff) =>
    cutOff.length === 1
      ? `${cutOff[0].name} has Inbound Triggers but isn't allowed, so its calls will be refused.`
      : `${cutOff.length} workspaces with Inbound Triggers aren't allowed, so their calls will be refused: ${cutOff.map((ws) => ws.name).join(", ")}.`,
};

/** Which Workspaces take Inbound Trigger calls (ADR-0030). */
export const OrgInboundTriggerAccess = ({ orgId }: { orgId: string }) => (
  <OrgGateAccess orgId={orgId} copy={INBOUND_TRIGGER_GATE} />
);

const A2A_GATE: GateCopy<A2aAccess["workspaces"][number]> = {
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
  countOf: (ws) => ws.a2aEndpointCount,
  cutOffMessage: (cutOff) =>
    cutOff.length === 1
      ? `${cutOff[0].name} has A2A endpoints but isn't allowed, so they will stop answering.`
      : `${cutOff.length} workspaces with A2A endpoints aren't allowed, so their endpoints will stop answering: ${cutOff.map((ws) => ws.name).join(", ")}.`,
};

/**
 * Which Workspaces may have A2A endpoints (ADR-0032). Separate from the
 * Inbound Trigger gate, and off by default.
 */
export const OrgA2aAccess = ({ orgId }: { orgId: string }) => (
  <OrgGateAccess orgId={orgId} copy={A2A_GATE} />
);
