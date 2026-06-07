"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import type { Blueprint } from "@platypus/schemas";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { toast } from "sonner";

interface InvitationFormProps {
  orgId: string;
  onSuccess?: () => void;
}

export function InvitationForm({ orgId, onSuccess }: InvitationFormProps) {
  const backendUrl = useBackendUrl();
  const { user } = useAuth();

  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  // The ordered set of blueprints applied to the provisioned workspace on
  // accept (ADR-0009). Selection order is application order; on conflicting
  // settings the later blueprint wins (last-write-wins).
  const [blueprintIds, setBlueprintIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const { data: blueprintsData } = useSWR<{ results: Blueprint[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/blueprints`)
      : null,
    fetcher,
  );
  const blueprints = blueprintsData?.results || [];
  const blueprintsById = new Map(blueprints.map((b) => [b.id, b]));

  const toggleBlueprint = (id: string, on: boolean) => {
    setBlueprintIds((prev) =>
      on ? [...prev, id] : prev.filter((bid) => bid !== id),
    );
  };

  const moveBlueprint = (index: number, delta: number) => {
    setBlueprintIds((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setValidationErrors({});

    try {
      const response = await fetch(
        joinUrl(backendUrl, `/organizations/${orgId}/invitations`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            // Optional; the workspace provisioned on accept defaults to
            // "<member name>'s Workspace" when blank (ADR-0008).
            ...(workspaceName.trim()
              ? { workspaceName: workspaceName.trim() }
              : {}),
            // The ordered set of blueprints applied on accept (ADR-0009).
            ...(blueprintIds.length ? { blueprintIds } : {}),
          }),
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Invitation created");
        setEmail("");
        setWorkspaceName("");
        setBlueprintIds([]);
        onSuccess?.();
      } else {
        const errorData = await response.json();
        const errors = parseValidationErrors(errorData);
        setValidationErrors(errors);

        if (errorData.message) {
          toast.error(errorData.message);
        } else if (errorData.error) {
          toast.error(errorData.error);
        } else if (Object.keys(errors).length > 0) {
          toast.error("Please fix the errors in the form");
        } else {
          toast.error("Failed to send invitation");
        }
      }
    } catch {
      toast.error("Error sending invitation");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 border p-4 rounded-lg bg-muted/30"
    >
      <h3 className="font-semibold">Invite User to Organization</h3>
      <FieldSet>
        <FieldGroup className="gap-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field data-invalid={!!validationErrors.email}>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (validationErrors.email) {
                    setValidationErrors((prev) => {
                      const next = { ...prev };
                      delete next.email;
                      return next;
                    });
                  }
                }}
                disabled={isSubmitting}
                autoFocus
                required
              />
              {validationErrors.email && (
                <FieldError>{validationErrors.email}</FieldError>
              )}
            </Field>

            <Field data-invalid={!!validationErrors.workspaceName}>
              <FieldLabel htmlFor="workspaceName">Workspace name</FieldLabel>
              <Input
                id="workspaceName"
                type="text"
                placeholder="Defaults to the member's name"
                value={workspaceName}
                onChange={(e) => {
                  setWorkspaceName(e.target.value);
                  if (validationErrors.workspaceName) {
                    setValidationErrors((prev) => {
                      const next = { ...prev };
                      delete next.workspaceName;
                      return next;
                    });
                  }
                }}
                disabled={isSubmitting}
              />
              {validationErrors.workspaceName && (
                <FieldError>{validationErrors.workspaceName}</FieldError>
              )}
            </Field>
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
                  href={`/${orgId}/settings/blueprints`}
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
        disabled={isSubmitting}
        className={`w-full md:w-auto mt-2 ${!isSubmitting ? "cursor-pointer" : ""}`}
      >
        {isSubmitting ? "Sending..." : "Send Invitation"}
      </Button>
    </form>
  );
}
