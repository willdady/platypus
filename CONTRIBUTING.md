# Contributing to Platypus

Thank you for your interest in contributing to Platypus! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We are committed to providing a welcoming and inclusive experience for everyone.

## Getting Started

1. **Fork the repository** and clone your fork locally.
2. **Set up your development environment** by following the [Local Development](README.md#️-local-development) section in the README.
3. **Create a branch** from `main` for your changes (see [Branch Naming](#branch-naming) below).

## Branch Naming

All branches must use one of the following prefixes:

- `feature/` — New features or functionality
- `fix/` — Bug fixes
- `chore/` — Maintenance tasks (dependencies, formatting, etc.)

**Examples:**

```
feature/user-authentication
fix/memory-leak-in-chat
chore/update-dependencies
```

## Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Only the following commit types are allowed:

- `feat` — New features or functionality
- `fix` — Bug fixes
- `chore` — Maintenance tasks

**Format:** `<type>[optional scope]: <description>`

**Examples:**

```
feat: add user authentication
feat(backend): implement JWT token refresh
fix: resolve memory leak in chat component
fix(frontend): correct workspace navigation
chore: update dependencies
chore(tests): add missing test coverage
```

## Submitting a Pull Request

1. Ensure your code passes all tests (`pnpm test`) and is formatted (`pnpm format`).
2. Write clear, descriptive commit messages following the conventions above.
3. Open a pull request against the `main` branch.
4. Provide a clear description of the changes and the motivation behind them.
5. Link any related issues in your PR description.

## Project Structure

Platypus is a monorepo managed by [Turborepo](https://turbo.build/) with the following packages:

| Package            | Description                                   |
| ------------------ | --------------------------------------------- |
| `apps/frontend`    | Next.js web application                       |
| `apps/backend`     | Hono.js REST API server                       |
| `packages/schemas` | Shared Zod schemas for end-to-end type safety |

## Reporting Issues

If you find a bug or have a feature request, please [open an issue](https://github.com/willdady/platypus/issues) with a clear description and, if applicable, steps to reproduce.

## License

By contributing to Platypus, you agree that your contributions will be licensed under the [MIT License](LICENSE).
