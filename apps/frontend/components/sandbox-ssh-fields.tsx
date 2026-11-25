"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { FormTextareaField } from "@/components/form-textarea-field";
import { Button } from "@/components/ui/button";
import { KeyRound } from "lucide-react";
import type { SandboxConfigFieldsProps } from "@/components/sandbox-settings";

const DEFAULT_SSH_PORT = "22";

export type SandboxKeyState = "stored" | "replacing" | "none";

type SandboxSshFieldsProps = SandboxConfigFieldsProps & {
  keyState: SandboxKeyState;
  onReplaceKey: () => void;
};

function SandboxSshFields({
  formData,
  setConfigField,
  errors,
  disabled,
  keyState,
  onReplaceKey,
}: SandboxSshFieldsProps) {
  // why: a stored key has no control to label, so its caption is plain text
  return (
    <>
      <FormTextField
        label="Host"
        name="ssh-host"
        placeholder="ssh.example.com"
        value={formData.sshHost}
        error={errors["config.host"]}
        onChange={(value) => setConfigField("sshHost", value)}
        disabled={disabled}
        inputClassName="font-mono"
        description="Hostname or IP of the operator-owned host to attach to."
      />

      <FormTextField
        label="Port"
        name="ssh-port"
        type="number"
        placeholder={DEFAULT_SSH_PORT}
        value={formData.sshPort}
        error={errors["config.port"]}
        onChange={(value) => setConfigField("sshPort", value)}
        disabled={disabled}
        inputClassName="font-mono"
      />

      <FormTextField
        label="User"
        name="ssh-user"
        placeholder="platypus"
        value={formData.sshUser}
        error={errors["config.user"]}
        onChange={(value) => setConfigField("sshUser", value)}
        disabled={disabled}
        inputClassName="font-mono"
        description="SSH login user. Public-key auth only."
      />

      <FormTextField
        label="Workspace root (optional)"
        name="ssh-root-dir"
        placeholder="$HOME/platypus-workspace"
        value={formData.sshRootDir}
        error={errors["config.rootDir"]}
        onChange={(value) => setConfigField("sshRootDir", value)}
        disabled={disabled}
        inputClassName="font-mono"
        description={
          <>
            Absolute or $HOME-relative directory the sandbox works in. Defaults
            to <span className="font-mono">$HOME/platypus-workspace</span>,
            created on first connect.
          </>
        }
      />

      <FormTextareaField
        label="Host key (optional)"
        name="ssh-host-key"
        placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."
        value={formData.sshHostKey}
        error={errors["config.hostKey"]}
        onChange={(value) => setConfigField("sshHostKey", value)}
        disabled={disabled}
        rows={3}
        autoComplete="off"
        spellCheck={false}
        textareaClassName="font-mono"
        description={
          <>
            Pin the host&apos;s public key to reject a man-in-the-middle. Obtain
            it with{" "}
            <span className="font-mono">
              ssh-keyscan -t ed25519 {formData.sshHost || "<host>"}
            </span>
            . Leave blank to connect unverified (a warning is logged).
          </>
        }
      />

      {keyState === "stored" ? (
        <Field>
          <FieldTitle>Private key</FieldTitle>
          <div className="flex items-center justify-between gap-2 rounded-md border border-input px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" />
              Key stored
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReplaceKey}
              disabled={disabled}
            >
              Replace key
            </Button>
          </div>
          <FieldDescription>
            PEM or OpenSSH private key. Kept server-side, never sent to the
            model.
          </FieldDescription>
          {errors["credentials.privateKey"] && (
            <FieldError>{errors["credentials.privateKey"]}</FieldError>
          )}
        </Field>
      ) : (
        <FormTextareaField
          label="Private key"
          name="ssh-private-key"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          value={formData.sshPrivateKey}
          error={errors["credentials.privateKey"]}
          onChange={(value) => {
            setConfigField("sshPrivateKey", value);
            if (!value.trim()) setConfigField("sshPassphrase", "");
          }}
          disabled={disabled}
          rows={5}
          autoComplete="off"
          spellCheck={false}
          textareaClassName="font-mono"
          description={
            <>
              PEM or OpenSSH private key. Kept server-side, never sent to the
              model.
              {keyState === "replacing" &&
                " Leave blank to keep the stored key."}
            </>
          }
        />
      )}

      <FormTextField
        label="Key passphrase (optional)"
        name="ssh-passphrase"
        type="password"
        placeholder="Passphrase for the private key"
        value={formData.sshPassphrase}
        error={errors["credentials.passphrase"]}
        onChange={(value) => setConfigField("sshPassphrase", value)}
        disabled={disabled || !formData.sshPrivateKey.trim()}
        autoComplete="off"
        inputClassName="font-mono"
        description="Enter a private key first. A new key replaces the stored passphrase too, so re-enter it here if the key is encrypted."
      />
    </>
  );
}

export { DEFAULT_SSH_PORT, SandboxSshFields };
