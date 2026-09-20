"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useEntityForm } from "@/hooks/use-entity-form";
import { FIX_FORM_ERRORS_MESSAGE } from "@/lib/apply-write-outcome";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import type { Blueprint } from "@platypus/schemas";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { orgRoutes } from "@/lib/routes";

interface InvitationFormProps {
  orgId: string;
  onSuccess?: () => void;
}

const RETRACTABLE_FIELDS = ["email", "workspaceName", "blueprintIds"] as const;

const INITIAL_DATA = {
  email: "",
  workspaceName: "",
  // The ordered set of blueprints applied to the provisioned workspace on
  // accept (ADR-0009). Selection order is application order; on conflicting
  // settings the later blueprint wins (last-write-wins).
  blueprintIds: [] as string[],
};

export function InvitationForm({ orgId, onSuccess }: InvitationFormProps) {
  const backendUrl = useBackendUrl();
  const { user } = useAuth();

  const {
    formData,
    setFormData,
    validationErrors,
    isSubmitting,
    canSubmit,
    toFieldChange,
    clearErrors,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown>({
    initialData: INITIAL_DATA,
    entity: "invitations",
    scope: { orgId },
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => ({
      email: data.email,
      // Optional; the workspace provisioned on accept defaults to
      // "<member name>'s Workspace" when blank (ADR-0008).
      ...(data.workspaceName.trim()
        ? { workspaceName: data.workspaceName.trim() }
        : {}),
      // The ordered set of blueprints applied on accept (ADR-0009).
      ...(data.blueprintIds.length ? { blueprintIds: data.blueprintIds } : {}),
    }),
    conflictField: "email",
    invalidMessage: FIX_FORM_ERRORS_MESSAGE,
    successMessage: "Invitation created",
    onSuccess: () => {
      setFormData(INITIAL_DATA);
      onSuccess?.();
    },
  });

  const { data: blueprintsData } = useSWR<{ results: Blueprint[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/blueprints`)
      : null,
    fetcher,
  );
  const blueprints = blueprintsData?.results || [];
  const blueprintsById = new Map(blueprints.map((b) => [b.id, b]));

  const toggleBlueprint = (id: string, on: boolean) => {
    clearErrors("blueprintIds");
    setFormData((prev) => ({
      ...prev,
      blueprintIds: on
        ? [...prev.blueprintIds, id]
        : prev.blueprintIds.filter((bid) => bid !== id),
    }));
  };

  const moveBlueprint = (index: number, delta: number) => {
    setFormData((prev) => {
      const next = [...prev.blueprintIds];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...prev, blueprintIds: next };
    });
  };

  const { blueprintIds } = formData;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-4 border p-4 rounded-lg bg-muted/30"
    >
      <h3 className="font-semibold">Invite User to Organization</h3>
      <FieldSet>
        <FieldGroup className="gap-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormTextField
              label="Email"
              name="email"
              type="email"
              placeholder="user@example.com"
              value={formData.email}
              onChange={toFieldChange("email")}
              disabled={isSubmitting}
              error={validationErrors.email}
              autoFocus
              required
            />

            <FormTextField
              label="Workspace name"
              name="workspaceName"
              placeholder="Defaults to the member's name"
              value={formData.workspaceName}
              onChange={toFieldChange("workspaceName")}
              disabled={isSubmitting}
              error={validationErrors.workspaceName}
            />
          </div>

          {/* ADR-0009: the invitation carries an ordered set of blueprints,
              applied to the provisioned workspace on accept. */}
          <Field data-invalid={!!validationErrors.blueprintIds}>
            <FieldLabel htmlFor="blueprints">Blueprints (optional)</FieldLabel>
            <FieldDescription>
              Provision the member&apos;s new workspace from one or more
              blueprints. They apply top to bottom — when two set the same
              workspace setting, the later one wins.
            </FieldDescription>

            {blueprints.length === 0 ? (
              <p className="text-sm text-muted-foreground mt-2">
                No blueprints in this organization yet.{" "}
                <Link
                  href={orgRoutes(orgId).settings.blueprints}
                  className="underline underline-offset-2"
                >
                  Create one
                </Link>{" "}
                to pre-provision new members&apos; workspaces.
              </p>
            ) : (
              <>
                <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                  {blueprints.map((bp) => {
                    const checked = blueprintIds.includes(bp.id);
                    return (
                      <Field key={bp.id} orientation="horizontal">
                        <Switch
                          id={`bp-${bp.id}`}
                          className="cursor-pointer"
                          checked={checked}
                          onCheckedChange={(on) => toggleBlueprint(bp.id, on)}
                          disabled={isSubmitting}
                        />
                        <FieldLabel htmlFor={`bp-${bp.id}`}>
                          <div className="flex flex-col">
                            <p>{bp.name}</p>
                            {bp.description && (
                              <p className="text-xs text-muted-foreground line-clamp-1">
                                {bp.description}
                              </p>
                            )}
                          </div>
                        </FieldLabel>
                      </Field>
                    );
                  })}
                </FieldGroup>

                {blueprintIds.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Application order
                    </p>
                    <ol className="flex flex-col gap-2">
                      {blueprintIds.map((id, index) => (
                        <li
                          key={id}
                          className="flex items-center gap-2 rounded-md border bg-background px-3 py-2"
                        >
                          <span className="text-xs text-muted-foreground w-4">
                            {index + 1}.
                          </span>
                          <span className="flex-1 text-sm">
                            {blueprintsById.get(id)?.name ?? id}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={isSubmitting || index === 0}
                            onClick={() => moveBlueprint(index, -1)}
                            aria-label="Move earlier"
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={
                              isSubmitting || index === blueprintIds.length - 1
                            }
                            onClick={() => moveBlueprint(index, 1)}
                            aria-label="Move later"
                          >
                            <ArrowDown className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={isSubmitting}
                            onClick={() => toggleBlueprint(id, false)}
                            aria-label="Remove"
                          >
                            <X className="size-4" />
                          </Button>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            )}

            {validationErrors.blueprintIds && (
              <FieldError>{validationErrors.blueprintIds}</FieldError>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>
      <Button
        type="submit"
        disabled={isSubmitting || !canSubmit}
        className={`w-full md:w-auto mt-2 ${!isSubmitting ? "cursor-pointer" : ""}`}
      >
        {isSubmitting ? "Sending..." : "Send invitation"}
      </Button>
    </form>
  );
}
