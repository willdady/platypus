"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  SKILL_GITHUB_INSTALL_MAX,
  type SkillGithubCandidate,
  type SkillGithubInstallResult,
  type SkillGithubPreview,
} from "@platypus/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/markdown";
import { useBackendUrl } from "@/components/auth-provider";
import { formatSize, githubTreeUrl } from "@/components/skill-bundle";
import { useSkillImportAllowed } from "@/hooks/use-skill-import-allowed";
import { scopedUrl, writeAt, type Scope } from "@/lib/api-write";

/** Why a discovered Skill can't be picked, or null when it can. */
function unselectableReason(skill: SkillGithubCandidate) {
  return (
    skill.error ??
    (skill.taken ? `A skill named ${skill.name} already exists here.` : null)
  );
}

function CandidateRow({
  skill,
  checked,
  onCheckedChange,
  full,
}: {
  skill: SkillGithubCandidate;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The most one install takes are already picked. */
  full: boolean;
}) {
  const reason = unselectableReason(skill);
  const id = `skill-${skill.skillPath || "root"}`;

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          className="mt-1 size-4"
          checked={checked}
          disabled={reason !== null || (full && !checked)}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <label htmlFor={id} className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 font-medium">
            {skill.name ?? skill.skillPath}
            {skill.needsSandbox && (
              <Badge variant="pill">
                <SquareTerminal />
                Needs Sandbox
              </Badge>
            )}
          </span>
          <span className="block font-mono text-xs text-muted-foreground">
            {skill.skillPath || "(repository root)"}
          </span>
          {skill.description && (
            <span className="block text-sm text-muted-foreground">
              {skill.description}
            </span>
          )}
          {reason && (
            <span className="mt-1 block text-sm text-destructive">
              {reason}
            </span>
          )}
        </label>
      </div>
      {skill.body !== null && (
        <Collapsible className="pl-7">
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            Review SKILL.md and {skill.files.length}{" "}
            {skill.files.length === 1 ? "file" : "files"}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex flex-col gap-3">
            <div className="max-h-96 overflow-auto rounded-md border px-3 py-2 text-sm">
              <Markdown>{skill.body}</Markdown>
            </div>
            {skill.files.length > 0 && (
              <ul className="divide-y rounded-md border text-sm">
                {skill.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex items-center gap-2 px-3 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {file.path}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatSize(file.size)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  );
}

/**
 * Install Skills from GitHub (ADR-0037): a source, then a review of every
 * Skill it holds at the commit its ref resolved to, then the install of the
 * ones picked, at that same commit, with how each one went.
 */
export function SkillGithubInstall({
  scope,
  skillsHref,
  skillHrefBase,
}: {
  scope: Scope;
  /** Where the Skills list is. */
  skillsHref: string;
  /** Where installed Skills' own pages are, each at `<base>/<skillId>`. */
  skillHrefBase: string;
}) {
  const backendUrl = useBackendUrl();
  const importAllowed = useSkillImportAllowed(scope);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<SkillGithubPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<
    SkillGithubInstallResult["results"] | null
  >(null);
  const [busy, setBusy] = useState(false);

  const url = (action: string) =>
    scopedUrl(backendUrl, `skills/github/${action}`, scope);

  const runPreview = async () => {
    setBusy(true);
    const outcome = await writeAt<SkillGithubPreview>(url("preview"), {
      method: "POST",
      data: { source },
    });
    setBusy(false);
    if (outcome.outcome !== "success") {
      toast.error(outcome.message);
      return;
    }
    setPreview(outcome.data);
    setSelected(new Set());
    setResults(null);
  };

  const install = async () => {
    if (!preview) return;
    setBusy(true);
    const outcome = await writeAt<SkillGithubInstallResult>(url("install"), {
      method: "POST",
      data: {
        owner: preview.owner,
        repo: preview.repo,
        ref: preview.ref,
        commitSha: preview.commitSha,
        skillPaths: [...selected],
      },
    });
    setBusy(false);
    if (outcome.outcome !== "success") {
      toast.error(outcome.message);
      return;
    }
    setResults(outcome.data.results);
  };

  if (!importAllowed && scope.workspaceId) {
    return (
      <p className="text-sm text-muted-foreground">
        Your organization doesn&apos;t allow importing skills into this
        workspace. Ask an organization admin to allow it.
      </p>
    );
  }

  if (results) {
    return (
      <div className="flex flex-col gap-4">
        <ul className="divide-y rounded-md border text-sm">
          {results.map((result) => (
            <li
              key={result.skillPath}
              className="flex items-start gap-2 px-3 py-2"
            >
              {result.status === 201 ? (
                <CircleCheck className="mt-0.5 size-4 text-success-foreground" />
              ) : (
                <CircleX className="mt-0.5 size-4 text-destructive" />
              )}
              <span className="min-w-0 flex-1">
                {result.status === 201 && result.skillId ? (
                  <Link
                    href={`${skillHrefBase}/${result.skillId}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {result.name}
                  </Link>
                ) : (
                  <span className="font-medium">
                    {result.name ?? result.skillPath}
                  </span>
                )}
                <span className="block text-muted-foreground">
                  {result.status === 201 ? "Installed" : result.error}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div>
          <Button asChild>
            <Link href={skillsHref}>Done</Link>
          </Button>
        </div>
      </div>
    );
  }

  const pickable = preview?.skills.filter(
    (skill) => unselectableReason(skill) === null,
  );
  // One install takes at most this many.
  const selectAll = pickable?.slice(0, SKILL_GITHUB_INSTALL_MAX) ?? [];
  const needsSandbox =
    preview?.skills.filter(
      (skill) => selected.has(skill.skillPath) && skill.needsSandbox,
    ).length ?? 0;
  const repo = preview ? `${preview.owner}/${preview.repo}` : "";

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void runPreview();
        }}
      >
        <Field>
          <FieldLabel htmlFor="skill-source">GitHub repository</FieldLabel>
          <Input
            id="skill-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="owner/repo or https://github.com/owner/repo/tree/main/skills"
            autoComplete="off"
          />
          <FieldDescription>
            A repository, or a folder in it. Every skill in it is listed for you
            to review before anything is installed.
          </FieldDescription>
        </Field>
        <div>
          <Button type="submit" disabled={busy || source.trim() === ""}>
            {busy && !preview ? "Finding..." : "Find skills"}
          </Button>
        </div>
      </form>

      {preview && (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            {preview.skills.length === 0 ? "No skills found in " : "Skills in "}
            <a
              href={githubTreeUrl(repo, preview.commitSha, preview.path)}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline underline-offset-4"
            >
              {repo}@{preview.commitSha.slice(0, 7)}
            </a>
          </p>

          {preview.skills.length > 0 && (
            <>
              {pickable && pickable.length > 1 && (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSelected(
                        selected.size === selectAll.length
                          ? new Set()
                          : new Set(selectAll.map((skill) => skill.skillPath)),
                      )
                    }
                  >
                    {selected.size === selectAll.length
                      ? "Clear selection"
                      : pickable.length > SKILL_GITHUB_INSTALL_MAX
                        ? `Select first ${SKILL_GITHUB_INSTALL_MAX}`
                        : "Select all"}
                  </Button>
                </div>
              )}
              <ul className="divide-y rounded-md border">
                {preview.skills.map((skill) => (
                  <CandidateRow
                    key={skill.skillPath}
                    skill={skill}
                    checked={selected.has(skill.skillPath)}
                    full={selected.size >= SKILL_GITHUB_INSTALL_MAX}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked) next.add(skill.skillPath);
                      else next.delete(skill.skillPath);
                      setSelected(next);
                    }}
                  />
                ))}
              </ul>
            </>
          )}

          {needsSandbox > 0 && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Third-party scripts</AlertTitle>
              <AlertDescription>
                {needsSandbox === 1
                  ? "1 selected Skill includes"
                  : `${needsSandbox} selected Skills include`}{" "}
                scripts written by a third party. If an Agent with a Sandbox
                runs them, they run with this Workspace&apos;s default
                environment variables and can send them anywhere the Sandbox can
                reach. Review the files before installing.
              </AlertDescription>
            </Alert>
          )}

          {preview.skills.length > 0 && (
            <div>
              <Button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => void install()}
              >
                {busy
                  ? "Installing..."
                  : selected.size === 1
                    ? "Install 1 skill"
                    : selected.size === 0
                      ? "Install skills"
                      : `Install ${selected.size} skills`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
