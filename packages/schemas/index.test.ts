import { describe, it, expect } from 'vitest';
import {
  organizationSchema,
  workspaceSchema,
  agentSchema,
  organizationCreateSchema,
} from './index';

describe('Organization Schema', () => {
  it('should validate a valid organization', () => {
    const validOrg = {
      id: '123',
      name: 'Test Org',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = organizationSchema.safeParse(validOrg);
    expect(result.success).toBe(true);
  });

  it('should reject organization with short name', () => {
    const invalidOrg = {
      id: '123',
      name: 'AB',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = organizationSchema.safeParse(invalidOrg);
    expect(result.success).toBe(false);
  });

  it('should reject organization with long name', () => {
    const invalidOrg = {
      id: '123',
      name: 'A'.repeat(31),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = organizationSchema.safeParse(invalidOrg);
    expect(result.success).toBe(false);
  });
});

describe('Organization Create Schema', () => {
  it('should validate create input with only required fields', () => {
    const result = organizationCreateSchema.safeParse({ name: 'New Org' });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    const result = organizationCreateSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('Workspace Schema', () => {
  it('should validate a valid workspace', () => {
    const validWorkspace = {
      id: '456',
      organizationId: '123',
      name: 'Test Workspace',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = workspaceSchema.safeParse(validWorkspace);
    expect(result.success).toBe(true);
  });
});

describe('Agent Schema', () => {
  it('should validate a valid agent', () => {
    const validAgent = {
      id: '789',
      workspaceId: '456',
      providerId: 'provider-123',
      name: 'Test Agent',
      modelId: 'gpt-4',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = agentSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
  });

  it('should allow optional fields', () => {
    const agentWithOptionals = {
      id: '789',
      workspaceId: '456',
      providerId: 'provider-123',
      name: 'Test Agent',
      description: 'A test agent',
      systemPrompt: 'You are a helpful assistant',
      modelId: 'gpt-4',
      temperature: 0.7,
      maxSteps: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = agentSchema.safeParse(agentWithOptionals);
    expect(result.success).toBe(true);
  });
});
