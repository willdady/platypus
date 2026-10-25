"use client";

import { useRef, useState } from "react";
import {
  Download,
  FileArchive,
  FileUp,
  PencilLine,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { Sandbox, Skill, SkillFile } from "@platypus/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";
import { useBackendUrl } from "@/components/auth-provider";
import {
  scopedUrl,
  writeAt,
  type Scope,
  type Serialized,
} from "@/lib/api-write";
import { SkillGithubUpdate } from "@/components/skill-github-update";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useSkillImportAllowed } from "@/hooks/use-skill-import-allowed";
import { optionalFetcher } from "@/lib/utils";

/** Marks a Skill whose scripts or binary files only a Sandbox can use. */
export function NeedsSandboxBadge({ skill }: { skill: Serialized<Skill> }) {
  if (!skill.needsSandbox) return null;

  return (
    <Badge
      variant="pill"
      title="This skill has scripts or binary files that only an agent with a Sandbox can use"
    >
      <SquareTerminal />
      Needs Sandbox
    </Badge>
  );
}

/** Marks a GitHub-installed Skill edited since it was installed or updated. */
export function ModifiedBadge({ skill }: { skill: Serialized<Skill> }) {
  if (!skill.modified) return null;

  return (
    <Badge
      variant="pill"
      title="This skill has been edited since it was installed from GitHub. Updating it overwrites those edits."
    >
      <PencilLine />
      Modified
    </Badge>
  );
}

/** A link to a Skill's directory on GitHub, at one commit. */
export function githubTreeUrl(
  source: string,
  commitSha: string,
  skillPath: string,
) {
  return `https://github.com/${source}/tree/${commitSha}${skillPath ? `/${skillPath}` : ""}`;
}

/**
 * Picks a `.zip` and sends it as the raw request body to `url`. The backend
 * validates the whole bundle before writing anything and names the rule a
 * rejected zip broke, so its message is shown as-is.
 */
function useZipUpload<TResult>(
  method: "POST" | "PUT",
  onSuccess: (result: Serialized<TResult>) => void,
) {
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
}

/** Creates a new Skill from a zip, then hands it to `onImported`. */
export function SkillImportButton({
  scope,
  onImported,
}: {
  scope: Scope;
  onImported: (skill: Serialized<Skill>) => void;
}) {
  const backendUrl = useBackendUrl();
  const upload = useZipUpload<Serialized<Skill>>("POST", (skill) => {
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
}

export function formatSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * A Skill's bundle beyond the form's fields: Export, Replace bundle, the
 * GitHub source and its update check, the bundled files (view-only, each downloadable), and the frontmatter kept from
 * the imported `SKILL.md`, read-only.
 */
export function SkillBundleCard({
  scope,
  skill,
  onReplaced,
}: {
  scope: Scope;
  skill: Serialized<Skill>;
  onReplaced: (skill: Serialized<Skill>) => void;
}) {
  const backendUrl = useBackendUrl();
  const skillUrl = scopedUrl(backendUrl, `skills/${skill.id}`, scope);
  const upload = useZipUpload<Serialized<Skill>>("PUT", (replaced) => {
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
  const importAllowed = useSkillImportAllowed(scope);

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Bundle <NeedsSandboxBadge skill={skill} />
          <ModifiedBadge skill={skill} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldDescription>
          Files bundled with this skill. Replacing the bundle overwrites the
          fields above, the frontmatter and every file with the zip&apos;s
          contents.
        </FieldDescription>

        {skill.sourceType === "github" && skill.source && skill.commitSha && (
          <p className="text-sm">
            Installed from{" "}
            <a
              href={githubTreeUrl(
                skill.source,
                skill.commitSha,
                skill.skillPath ?? "",
              )}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline underline-offset-4"
            >
              {[skill.source, skill.skillPath].filter(Boolean).join("/")} @{" "}
              {skill.commitSha.slice(0, 7)}
            </a>
          </p>
        )}

        {skill.sourceType === "github" && importAllowed && (
          <SkillGithubUpdate
            skillUrl={skillUrl}
            skill={skill}
            onUpdated={onReplaced}
          />
        )}

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
          <div className="flex flex-col gap-1">
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
          {importAllowed && (
            <>
              {upload.input(`${skillUrl}/bundle`)}
              <Button
                variant="outline"
                onClick={upload.pick}
                disabled={upload.uploading}
              >
                <FileUp />{" "}
                {upload.uploading ? "Replacing..." : "Replace bundle"}
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
