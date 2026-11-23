import { ValidationError } from "../errors.ts";

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

const MAX_KEY_LENGTH = 1024;

export function isValidStorageKey(key: string): boolean {
  if (!key || key.length > MAX_KEY_LENGTH) {
    return false;
  }

  return key
    .split("/")
    .every(
      (segment) =>
        segment !== "." && segment !== ".." && SEGMENT_PATTERN.test(segment),
    );
}

export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) {
    throw new ValidationError("Invalid file key");
  }
}

export function assertValidStoragePrefix(prefix: string): void {
  if (!prefix.endsWith("/") || !isValidStorageKey(prefix.slice(0, -1))) {
    throw new ValidationError("Invalid storage prefix");
  }
}

export interface OrganizationKeyScope {
  orgId: string;
}

export interface WorkspaceKeyScope extends OrganizationKeyScope {
  workspaceId: string;
}

export interface ChatKeyScope extends WorkspaceKeyScope {
  chatId: string;
}

export function organizationStorageKeyPrefix(
  scope: OrganizationKeyScope,
): string {
  return `${scope.orgId}/`;
}

export function workspaceStorageKeyPrefix(scope: WorkspaceKeyScope): string {
  return `${organizationStorageKeyPrefix(scope)}${scope.workspaceId}/`;
}

export function chatStorageKeyPrefix(scope: ChatKeyScope): string {
  return `${workspaceStorageKeyPrefix(scope)}${scope.chatId}/`;
}

export interface SkillKeyScope extends OrganizationKeyScope {
  skillId: string;
}

export const SKILL_KEY_SEGMENT = "skills";

export function isSkillStorageKey(key: string): boolean {
  return key.split("/")[1]?.toLowerCase() === SKILL_KEY_SEGMENT;
}

export function skillStorageKeyPrefix(scope: SkillKeyScope): string {
  return `${organizationStorageKeyPrefix(scope)}${SKILL_KEY_SEGMENT}/${scope.skillId}/`;
}
