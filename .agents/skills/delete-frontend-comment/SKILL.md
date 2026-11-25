---
name: delete-frontend-comment
description: Burn down the comment baseline in apps/frontend. Classifies each comment in a scope, deletes them all, drafts Excuses as issues and moves Decision Records into a test, an ADR or a `// why:` line. Use when asked to delete or ratchet down comments in apps/frontend.
---

# Delete comments

Comments are banned in `apps/frontend` (`local/no-comments` in `apps/frontend/eslint.config.mjs`). `apps/frontend/comment-baseline.json` lists how many comments each file still has. The rule fails when a file has more comments than its baseline allows, and also when it has fewer, so a baseline only ever moves down. Two kinds of comment are not counted and stay: directives (`eslint-disable`, `@ts-expect-error`, `prettier-ignore`, `///`), and a single-line `// why: …` that keeps a local, non-obvious warning beside the code it protects.

The argument is the scope, relative to `apps/frontend`: one or more directories, files or globs (`components/a*`, `hooks/use-a*.ts components/chat.tsx`). Expand it to the files listed in the baseline; a file not listed there has no comments to delete. With no argument, take the smallest directory still listed in the baseline.

## Steps

1. **List the comments.** Read every file in scope in full: a comment can only be classified next to its code. Done when every comment counted for the scope in the baseline has been read.
2. **Classify each comment** as exactly one of:
   - **Tautology.** Restates what the code, a name or a test already says.
   - **Stale.** Names a file, function, issue or behaviour that no longer exists or no longer matches the code, or tells history ("used to", "since #N"). Check that the referenced thing really is gone before you call it Stale.
   - **Excuse.** Justifies a shortcut: production code shaped for a fixture, a global mock, a test seam, a "for now", a disabled constraint. Verify the shortcut against the code (a FK, a caller, the schema) before you call it an Excuse.
   - **Decision Record.** A non-obvious why that someone would otherwise "fix": an ordering dependency, a cross-instance safety argument, an option that was rejected.
3. **Record Decision Records**, picking the first option that holds:
   1. **A test.** If a test already pins the behaviour, or one cheaply could, the test is the record and the comment is deleted. Add the test if it's missing.
   2. **An ADR**, when the decision spans more than one module and passes the "when to offer an ADR" test in `.agents/skills/domain-modeling/ADR-FORMAT.md`.
   3. **A `// why:` one-liner**, when the warning is local to one function. Rewrite the comment as a single line, at most about 100 characters, that states the constraint and not its history (`// why: same value on every instance, or a peer's live run is failed`).

   For an ADR, write one per topic, not one per comment, following `docs/adr/README.md`. First check that no existing ADR already holds the decision (`grep -ril <keyword> docs/adr`); if one does, reference it or append to it under that README's amending rules. Write the decision as it stands today; leave history out.

4. **Draft Excuse issues.** Write a draft issue per shortcut (several comments about one hack make one issue) to the scratchpad, never straight to GitHub: a title as a Conventional Commit subject, `file:line` of the shortcut, why it is a hack, and the fix. First check for an existing issue (`gh issue list --search`). Never file them yourself: put the drafts in your report, and the user files the ones they approve with the label `ready-for-agent`. Keep a security-relevant Excuse out of every public place (issue, commit, PR body) and flag it only in your report.
5. **Delete.** From `apps/frontend`, run `node ../../.agents/skills/delete-frontend-comment/strip-comments.mjs <file>` for each file, then `pnpm exec prettier --write <scope>`. Add line numbers after the file to delete only the comments starting on those lines.
6. **Ratchet.** For each file, set its baseline to the new count, or delete its entry when the count is 0. `pnpm --filter @platypus/frontend lint` reports each stale entry and its new count.
7. **Verify.** Run `pnpm --filter @platypus/frontend lint`, `typecheck` and `test` for the scope. All must pass, and `git diff` must show nothing removed except comments.

Report back: the count per category, the ADR(s), the drafted issues, and the comment-only lines removed.
