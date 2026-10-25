"use client";

import { useState } from "react";
import { CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Skill, SkillGithubUpdateCheck } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { formatSize } from "@/components/skill-bundle";
import { ThirdPartyScriptsAlert } from "@/components/skill-github-install";
import { writeAt, type Serialized } from "@/lib/api-write";
import { lineDiff } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

type Diff = Extract<SkillGithubUpdateCheck, { upToDate: false }>;

const DIFF_LINE_CLASS = {
  same: "text-muted-foreground",
  added: "bg-success/10 text-success-foreground",
  removed: "bg-destructive/10 text-destructive",
};
const DIFF_LINE_MARK = { same: " ", added: "+", removed: "-" };

/** What updating would change: the files, `SKILL.md` line by line, and the Sandbox need. */
function UpdateDiff({ diff }: { diff: Diff }) {
  const rows = [
    ...diff.files.added.map((file) => ({
      path: file.path,
      change: "Added",
      size: formatSize(file.size),
    })),
    ...diff.files.removed.map((file) => ({
      path: file.path,
      change: "Removed",
      size: formatSize(file.size),
    })),
    ...diff.files.changed.map((file) => ({
      path: file.path,
      change: "Changed",
      size: `${formatSize(file.oldSize)} → ${formatSize(file.newSize)}`,
    })),
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Update available:{" "}
        <span className="font-mono">
          {diff.fromSha.slice(0, 7)} → {diff.toSha.slice(0, 7)}
        </span>
      </p>

      {diff.needsSandbox.before !== diff.needsSandbox.after && (
        <p className="flex items-center gap-1 text-sm text-warning-foreground">
          <TriangleAlert className="size-4" />
          {diff.needsSandbox.after
            ? "After this update the skill needs a Sandbox."
            : "After this update the skill no longer needs a Sandbox."}
        </p>
      )}

      {rows.length > 0 ? (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((row) => (
            <li key={row.path} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono">
                {row.path}
              </span>
              <span className="text-xs">{row.change}</span>
              <span className="text-xs text-muted-foreground">{row.size}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No bundled files change.
        </p>
      )}

      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">SKILL.md</p>
        <pre className="max-h-96 overflow-auto rounded-md border py-2 font-mono text-xs">
          {lineDiff(diff.skillMd.before, diff.skillMd.after).map(
            (line, index) => (
              <div
                key={index}
                className={cn(
                  "px-3 whitespace-pre-wrap",
                  DIFF_LINE_CLASS[line.kind],
                )}
              >
                {DIFF_LINE_MARK[line.kind]} {line.text}
              </div>
            ),
          )}
        </pre>
      </div>
    </div>
  );
}

/**
 * Check for updates on a Skill installed from GitHub: up to date, or the diff
 * of what updating would change, then Update to exactly the checked commit.
 * A Modified Skill warns that its local edits will be overwritten.
 */
export function SkillGithubUpdate({
  skillUrl,
  skill,
  onUpdated,
}: {
  /** The Skill's backend URL at the scope it is managed from. */
  skillUrl: string;
  skill: Serialized<Skill>;
  onUpdated: (skill: Serialized<Skill>) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<SkillGithubUpdateCheck | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const runCheck = async () => {
    setChecking(true);
    const outcome = await writeAt<SkillGithubUpdateCheck>(
      `${skillUrl}/github/check`,
      { method: "POST", data: {} },
    );
    setChecking(false);
    if (outcome.outcome === "success") setCheck(outcome.data);
    else toast.error(outcome.message);
  };

  const update = async (commitSha: string) => {
    setUpdating(true);
    const outcome = await writeAt<Serialized<Skill>>(
      `${skillUrl}/github/update`,
      { method: "POST", data: { commitSha } },
    );
    setUpdating(false);
    if (outcome.outcome !== "success") {
      // A refused update shows in the confirm dialog, which stays open.
      if (confirming) setUpdateError(outcome.message);
      else toast.error(outcome.message);
      return;
    }
    setConfirming(false);
    toast.success("Skill updated");
    setCheck(null);
    onUpdated(outcome.data);
  };

  return (
    <div className="flex flex-col gap-3">
      {check?.upToDate && (
        <p className="flex items-center gap-1 text-sm">
          <CircleCheck className="size-4 text-success-foreground" />
          Up to date
        </p>
      )}

      {check && !check.upToDate && (
        <>
          <UpdateDiff diff={check} />
          {check.needsSandbox.after && (
            <ThirdPartyScriptsAlert
              subject="This update includes"
              action="updating"
            />
          )}
        </>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void runCheck()}
          disabled={checking || updating}
        >
          <RefreshCw /> {checking ? "Checking..." : "Check for updates"}
        </Button>
        {check && !check.upToDate && (
          <Button
            type="button"
            onClick={() => {
              if (!skill.modified) return void update(check.toSha);
              setUpdateError(null);
              setConfirming(true);
            }}
            disabled={checking || updating}
          >
            {updating ? "Updating..." : "Update"}
          </Button>
        )}
      </div>

      {check && !check.upToDate && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Overwrite local edits?"
          description="This skill has been edited since it was installed. Updating replaces those edits with the version from GitHub."
          confirmLabel="Update"
          loadingLabel="Updating..."
          confirmVariant="destructive"
          loading={updating}
          error={updateError}
          onConfirm={() => void update(check.toSha)}
        />
      )}
    </div>
  );
}
