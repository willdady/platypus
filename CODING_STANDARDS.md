# Coding Standards

Read by the reviewer, not the implementer. Each rule is a judgement call: tooling (Prettier, ESLint, `tsc`, `docs-contract.test.ts`) already enforces the mechanical ones, so skip anything it catches.

## Convention skills

The diff follows the convention skill for each area it touches. Read the matching `SKILL.md` under `.agents/skills/` and apply it as a standard:

| The diff touches                                    | Skill              |
| --------------------------------------------------- | ------------------ |
| a backend route or its tests                        | `api-conventions`  |
| a list, card or ⋮ menu in `apps/frontend`           | `card-conventions` |
| a form, submit button, delete confirm or dialog     | `form-conventions` |
| an empty or failed-to-load state in `apps/frontend` | `ui-conventions`   |
| a tool or tool set                                  | `platypus-tools`   |

Reuse beats re-creation: flag a hand-rolled version of something a shared component already does (`row-actions-menu.tsx`, `disabled-badge.tsx`), and logic that repeats a sibling's (one tool renderer restating another's error handling).

## Docs ride with the change

Check the diff against the table in `CLAUDE.md` § Documentation. Also flag, when there is no matching `apps/docs/content` edit:

- a new or changed response header, CSP directive or other behaviour a self-hoster can see from outside;
- a visible field label or label-vs-`aria-label` change.

Docs describe a failure condition; flag docs prose that quotes an error string from the code.

## Every visual change has a stated reason

A changed design token, colour, focus ring or spacing value needs a reason in the PR body or commit message. Flag one that rides in unexplained inside a broader change.

## Lint ceilings only go down

Each package's `lint` script caps warnings with `--max-warnings`. Flag a diff that raises a cap or demotes a rule from `error` to `warn`. The fix is to fix the warnings. Lowering a cap after fixing warnings is welcome.

## Tests mock at the edge they mean

Before you suggest a new assertion in an existing test file, check its `vi.mock` calls: a mocked component may drop the props you want to assert. Flag a new `next/navigation` mock that leaves out hooks the code under test calls.
