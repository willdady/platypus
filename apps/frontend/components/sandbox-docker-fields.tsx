"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { KeyValueRowsEditor } from "@/components/key-value-rows-editor";
import { ListError } from "@/components/list-state";
import { LoadingRegion } from "@/components/list-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useScopedList } from "@/hooks/use-scoped-list";
import { toggleInList } from "@/lib/toggle-in-list";
import type { SandboxConfigFieldsProps } from "@/components/sandbox-settings";

function SandboxDockerFields({
  orgId,
  formData,
  setConfigField,
  errors,
  disabled,
}: SandboxConfigFieldsProps & { orgId: string }) {
  const {
    data: networksData,
    results: allowedNetworks,
    error: networksError,
    isLoading: networksLoading,
    mutate: mutateNetworks,
  } = useScopedList<string>("sandbox-backends/networks", { orgId });

  const networksFailed = Boolean(networksError && !networksData);

  return (
    <>
      <Field
        aria-labelledby="sandbox-networks-label"
        data-invalid={!!errors["config.networks"]}
      >
        <FieldTitle id="sandbox-networks-label">Networks</FieldTitle>
        <FieldDescription>
          Docker networks this sandbox may attach to. The list is declared by
          the operator in the deployment&apos;s plugin configuration. Off by
          default.
        </FieldDescription>
        {networksLoading ? (
          <LoadingRegion
            label="Loading networks"
            className="flex items-center justify-between gap-2"
          >
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-[1.15rem] w-8 rounded-full" />
          </LoadingRegion>
        ) : networksFailed ? (
          <ListError
            error={networksError}
            subject="networks"
            onRetry={() => void mutateNetworks()}
          />
        ) : allowedNetworks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No networks declared by the operator.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {allowedNetworks.map((net) => (
              <div
                key={net}
                className="flex items-center justify-between gap-2"
              >
                <span className="font-mono text-sm">{net}</span>
                <Switch
                  checked={formData.networks.includes(net)}
                  disabled={disabled}
                  onCheckedChange={(on) =>
                    setConfigField(
                      "networks",
                      toggleInList(formData.networks, net, on),
                    )
                  }
                  aria-label={`Attach network ${net}`}
                />
              </div>
            ))}
          </div>
        )}
        {errors["config.networks"] && (
          <FieldError>{errors["config.networks"]}</FieldError>
        )}
      </Field>

      <Field
        aria-labelledby="sandbox-extra-hosts-label"
        data-invalid={!!errors["config.extraHosts"]}
      >
        <FieldTitle id="sandbox-extra-hosts-label">Extra hosts</FieldTitle>
        <FieldDescription>
          Extra <span className="font-mono">hostname → target</span> entries
          added to the container (target is an IP or{" "}
          <span className="font-mono">host-gateway</span>). Lets agent code
          reach host services. Off by default.
        </FieldDescription>
        <KeyValueRowsEditor
          rows={formData.extraHosts}
          onChange={(rows) => setConfigField("extraHosts", rows)}
          disabled={disabled}
          keyPlaceholder="hostname"
          valuePlaceholder="host-gateway"
          addLabel="Add host"
          mono
        />
        {errors["config.extraHosts"] && (
          <FieldError>{errors["config.extraHosts"]}</FieldError>
        )}
      </Field>
    </>
  );
}

export { SandboxDockerFields };
