"use client";

import { useRef, useState } from "react";
import {
  Download,
  FileArchive,
  FileUp,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { Sandbox, Skill, SkillFile } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";
import { useBackendUrl } from "@/components/auth-provider";
import { scopedUrl, writeAt, type Scope } from "@/lib/api-write";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { optionalFetcher } from "@/lib/utils";

/** Marks a Skill whose scripts or binary files only a Sandbox can use. */
export const NeedsSandboxBadge = ({ skill }: { skill: Skill }) => {
  if (!skill.needsSandbox) return null;

  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider"
      title="This skill has scripts or binary files that only an agent with a Sandbox can use"
    >
      <SquareTerminal className="size-3" />
      Needs Sandbox
    </span>
  );
};

/**
 * Picks a `.zip` and sends it as the raw request body to `url`. The backend
 * validates the whole bundle before writing anything and names the rule a
 * rejected zip broke, so its message is shown as-is.
 */
const useZipUpload = <TResult,>(
  method: "POST" | "PUT",
  onSuccess: (result: TResult) => void,
) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const input = (url: string) => (
    <input
      ref={inputRef}
      type="file"
      accept=".zip,application/zip"
      className="hidden"
      onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setUploading(true);
        const outcome = await writeAt<TResult, Blob>(url, {
          method,
          data: file,
        });
        setUploading(false);
        if (outcome.outcome === "success") onSuccess(outcome.data);
        else toast.error(outcome.message);
      }}
    />
  );

  return { input, pick: () => inputRef.current?.click(), uploading };
};

/** Creates a new Skill from a zip, then hands it to `onImported`. */
export const SkillImportButton = ({
  scope,
  onImported,
}: {
  scope: Scope;
  onImported: (skill: Skill) => void;
}) => {
  const backendUrl = useBackendUrl();
  const upload = useZipUpload<Skill>("POST", (skill) => {
    toast.success(`Imported skill ${skill.name}`);
    onImported(skill);
  });

  return (
    <>
      {upload.input(scopedUrl(backendUrl, "skills/import", scope))}
      <Button
        variant="outline"
        onClick={upload.pick}
        disabled={upload.uploading}
      >
        <FileUp /> {upload.uploading ? "Importing..." : "Import zip"}
      </Button>
    </>
  );
};

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const formatValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * A Skill's bundle beyond the form's fields: Export, Replace bundle, the
 * bundled files (view-only, each downloadable), and the frontmatter kept from
 * the imported `SKILL.md`, read-only.
 */
export const SkillBundleCard = ({
  scope,
  skill,
  onReplaced,
}: {
  scope: Scope;
  skill: Skill;
  onReplaced: (skill: Skill) => void;
}) => {
  const backendUrl = useBackendUrl();
  const skillUrl = scopedUrl(backendUrl, `skills/${skill.id}`, scope);
  const upload = useZipUpload<Skill>("PUT", (replaced) => {
    toast.success("Bundle replaced");
    onReplaced(replaced);
  });
  const files: SkillFile[] = skill.files ?? [];
  const frontmatter = Object.entries(skill.frontmatter ?? {});
  // Only a Workspace has a Sandbox; a backend that can't receive bytes gets
  // the Skill's text files only.
  const { data: sandbox } = useScopedSWR<Sandbox | null>(
    "sandbox",
    scope.workspaceId ? scope : null,
    { fetcher: optionalFetcher },
  );
  const binariesSkipped =
    sandbox?.transfer.upload === false && files.some((file) => !file.isText);

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Bundle <NeedsSandboxBadge skill={skill} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <FieldDescription>
          Files bundled with this skill. Replacing the bundle overwrites the
          fields above, the frontmatter and every file with the zip&apos;s
          contents.
        </FieldDescription>

        {binariesSkipped && (
          <p className="flex items-center gap-1 text-sm text-warning-foreground">
            <TriangleAlert className="size-4" />
            Some files in this Skill can&apos;t be copied to this
            Workspace&apos;s Sandbox.
          </p>
        )}

        {files.length > 0 ? (
          <ul className="divide-y rounded-md border text-sm">
            {files.map((file) => (
              <li key={file.id} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.path}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatSize(file.size)}
                </span>
                <Button variant="ghost" size="sm" asChild>
                  <a
                    href={`${skillUrl}/files/${file.id}`}
                    aria-label={`Download ${file.path}`}
                  >
                    <Download />
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No bundled files.</p>
        )}

        {frontmatter.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Frontmatter</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm">
              {frontmatter.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-words">{formatValue(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={`${skillUrl}/export`}>
              <FileArchive /> Export
            </a>
          </Button>
          {upload.input(`${skillUrl}/bundle`)}
          <Button
            variant="outline"
            onClick={upload.pick}
            disabled={upload.uploading}
          >
            <FileUp /> {upload.uploading ? "Replacing..." : "Replace bundle"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
