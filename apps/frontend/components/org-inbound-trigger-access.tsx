"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  type InboundTriggerAccess,
  type InboundTriggerGate,
} from "@platypus/schemas";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

const ACCESS_ENTITY = "inbound-triggers/access";

const GATE_OPTIONS: { value: InboundTriggerGate; label: string }[] = [
  { value: "off", label: "No workspaces" },
  { value: "all", label: "All workspaces" },
  { value: "selected", label: "Selected workspaces" },
];

type Draft = { gate: InboundTriggerGate; allowed: Set<string> };

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * Which Workspaces take Inbound Trigger calls (ADR-0030): the Organization
 * gate and, under Selected workspaces, each Workspace's switch. Staged and
 * saved in one write, so switching to Selected never refuses calls for the
 * Workspaces that should keep them while the Admin ticks them one by one.
 */
export const OrgInboundTriggerAccess = ({ orgId }: { orgId: string }) => {
  const backendUrl = useBackendUrl();
  const scope = { orgId };
  const { data, error, isLoading, mutate } = useScopedSWR<InboundTriggerAccess>(
    ACCESS_ENTITY,
    scope,
  );
  // The Admin's unsaved edits; null shows what is saved. Cleared on save, so
  // the next read is shown as it stands.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (isLoading) {
    return (
      <LoadingRegion label="Loading inbound trigger access">
        <FieldSkeleton description={2} />
      </LoadingRegion>
    );
  }

  if (error && !data) {
    return <ListError error={error} subject="inbound trigger access" />;
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
          (ws) => ws.inboundTriggerCount > 0 && !allowed.has(ws.id),
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
    const outcome = await writeAt<InboundTriggerAccess>(
      scopedUrl(backendUrl, ACCESS_ENTITY, scope),
      {
        method: "PUT",
        data: {
          gate,
          ...(gate === "selected" ? { allowedWorkspaceIds: [...allowed] } : {}),
        },
      },
    );
    if (outcome.outcome === "success") {
      toast.success("Inbound Trigger access saved");
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
        label="Allow Inbound Triggers in"
        name="inboundTriggerGate"
        value={gate}
        onValueChange={(value) => setGate(value as InboundTriggerGate)}
        disabled={isSaving}
        description="Which workspaces can use Inbound Triggers. Changes apply straight away, and no triggers are deleted."
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
          <FieldDescription>
            Only the workspaces switched on here take calls. Saved together with
            the setting above. A workspace&apos;s own settings show the same
            switch.
          </FieldDescription>
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
                      <TableHead>Inbound Triggers</TableHead>
                      <TableHead className="text-right">Allowed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.workspaces.map((ws) => (
                      <TableRow key={ws.id}>
                        <TableCell className="font-medium">{ws.name}</TableCell>
                        <TableCell>{ws.ownerName}</TableCell>
                        <TableCell>{ws.inboundTriggerCount}</TableCell>
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
          <AlertDescription>
            {cutOff.length === 1
              ? `${cutOff[0].name} has Inbound Triggers but isn't allowed, so its calls will be refused.`
              : `${cutOff.length} workspaces with Inbound Triggers aren't allowed, so their calls will be refused: ${cutOff.map((ws) => ws.name).join(", ")}.`}
          </AlertDescription>
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
