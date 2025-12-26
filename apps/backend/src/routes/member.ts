import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  organisationMember,
  workspaceMember,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import {
  organisationMemberUpdateSchema,
  workspaceMemberCreateSchema,
  workspaceMemberUpdateSchema,
} from "@platypus/schemas";
import { eq, and, count } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess, isSuperAdmin } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const member = new Hono<{ Variables: Variables }>();

/** List all organisation members with their workspace assignments */
member.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const orgId = c.req.param("orgId")!;

  const members = await db
    .select({
      id: organisationMember.id,
      organisationId: organisationMember.organisationId,
      userId: organisationMember.userId,
      role: organisationMember.role,
      createdAt: organisationMember.createdAt,
      updatedAt: organisationMember.updatedAt,
      user: {
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
        role: userTable.role,
      },
    })
    .from(organisationMember)
    .innerJoin(userTable, eq(organisationMember.userId, userTable.id))
    .where(eq(organisationMember.organisationId, orgId));

  const results = await Promise.all(
    members.map(async (m) => {
      const workspaces = await db
        .select({
          workspaceMemberId: workspaceMember.id,
          workspaceId: workspaceMember.workspaceId,
          workspaceName: workspaceTable.name,
          role: workspaceMember.role,
        })
        .from(workspaceMember)
        .innerJoin(
          workspaceTable,
          eq(workspaceMember.workspaceId, workspaceTable.id),
        )
        .where(
          and(
            eq(workspaceMember.userId, m.userId),
            eq(workspaceTable.organisationId, orgId),
          ),
        );

      return {
        ...m,
        workspaces,
        isSuperAdmin: isSuperAdmin(m.user),
      };
    }),
  );

  return c.json({ results });
});

/** Get a single organisation member with details */
member.get(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");

    const [m] = await db
      .select({
        id: organisationMember.id,
        organisationId: organisationMember.organisationId,
        userId: organisationMember.userId,
        role: organisationMember.role,
        createdAt: organisationMember.createdAt,
        updatedAt: organisationMember.updatedAt,
        user: {
          id: userTable.id,
          name: userTable.name,
          email: userTable.email,
          image: userTable.image,
          role: userTable.role,
        },
      })
      .from(organisationMember)
      .innerJoin(userTable, eq(organisationMember.userId, userTable.id))
      .where(
        and(
          eq(organisationMember.id, memberId),
          eq(organisationMember.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!m) {
      return c.json({ message: "Member not found" }, 404);
    }

    const workspaces = await db
      .select({
        workspaceMemberId: workspaceMember.id,
        workspaceId: workspaceMember.workspaceId,
        workspaceName: workspaceTable.name,
        role: workspaceMember.role,
      })
      .from(workspaceMember)
      .innerJoin(
        workspaceTable,
        eq(workspaceMember.workspaceId, workspaceTable.id),
      )
      .where(
        and(
          eq(workspaceMember.userId, m.userId),
          eq(workspaceTable.organisationId, orgId),
        ),
      );

    return c.json({
      ...m,
      workspaces,
      isSuperAdmin: isSuperAdmin(m.user),
    });
  },
);

/** Update organisation member role */
member.patch(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", organisationMemberUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");
    const { role: newRole } = c.req.valid("json");
    const currentUser = c.get("user")!;

    const [targetMember] = await db
      .select()
      .from(organisationMember)
      .where(
        and(
          eq(organisationMember.id, memberId),
          eq(organisationMember.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!targetMember) {
      return c.json({ message: "Member not found" }, 404);
    }

    // Self-demotion protection
    if (targetMember.userId === currentUser.id && newRole === "member") {
      return c.json({ error: "You cannot demote yourself from admin" }, 400);
    }

    // Last admin protection
    if (targetMember.role === "admin" && newRole === "member") {
      const [adminCountResult] = await db
        .select({ value: count() })
        .from(organisationMember)
        .where(
          and(
            eq(organisationMember.organisationId, orgId),
            eq(organisationMember.role, "admin"),
          ),
        );

      if (adminCountResult.value <= 1) {
        return c.json(
          { error: "Cannot demote the last organisation admin" },
          400,
        );
      }
    }

    const [updated] = await db
      .update(organisationMember)
      .set({ role: newRole, updatedAt: new Date() })
      .where(eq(organisationMember.id, memberId))
      .returning();

    return c.json(updated);
  },
);

/** Remove member from organisation */
member.delete(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");
    const currentUser = c.get("user")!;

    const [targetMember] = await db
      .select()
      .from(organisationMember)
      .where(
        and(
          eq(organisationMember.id, memberId),
          eq(organisationMember.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!targetMember) {
      return c.json({ message: "Member not found" }, 404);
    }

    // Self-removal protection
    if (targetMember.userId === currentUser.id) {
      return c.json(
        { error: "You cannot remove yourself from the organisation" },
        400,
      );
    }

    // Last admin protection
    if (targetMember.role === "admin") {
      const [adminCountResult] = await db
        .select({ value: count() })
        .from(organisationMember)
        .where(
          and(
            eq(organisationMember.organisationId, orgId),
            eq(organisationMember.role, "admin"),
          ),
        );

      if (adminCountResult.value <= 1) {
        return c.json(
          { error: "Cannot remove the last organisation admin" },
          400,
        );
      }
    }

    await db
      .delete(organisationMember)
      .where(eq(organisationMember.id, memberId));

    return c.json({ message: "Member removed from organisation" });
  },
);

/** Add member to a workspace */
member.post(
  "/:memberId/workspaces",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", workspaceMemberCreateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");
    const { workspaceId, role } = c.req.valid("json");

    const [m] = await db
      .select()
      .from(organisationMember)
      .where(
        and(
          eq(organisationMember.id, memberId),
          eq(organisationMember.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!m) {
      return c.json({ message: "Member not found" }, 404);
    }

    // Verify workspace belongs to org
    const [ws] = await db
      .select()
      .from(workspaceTable)
      .where(
        and(
          eq(workspaceTable.id, workspaceId),
          eq(workspaceTable.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!ws) {
      return c.json(
        { message: "Workspace not found in this organisation" },
        404,
      );
    }

    // Check if already a member
    const [existing] = await db
      .select()
      .from(workspaceMember)
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.userId, m.userId),
        ),
      )
      .limit(1);

    if (existing) {
      return c.json(
        { message: "User is already a member of this workspace" },
        409,
      );
    }

    const [record] = await db
      .insert(workspaceMember)
      .values({
        id: nanoid(),
        workspaceId,
        userId: m.userId,
        orgMemberId: m.id,
        role,
      })
      .returning();

    return c.json(record, 201);
  },
);

/** Update workspace role */
member.patch(
  "/:memberId/workspaces/:workspaceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", workspaceMemberUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");
    const workspaceId = c.req.param("workspaceId");
    const { role } = c.req.valid("json");

    const [m] = await db
      .select()
      .from(organisationMember)
      .where(
        and(
          eq(organisationMember.id, memberId),
          eq(organisationMember.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!m) {
      return c.json({ message: "Member not found" }, 404);
    }

    const [updated] = await db
      .update(workspaceMember)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.userId, m.userId),
        ),
      )
      .returning();

    if (!updated) {
      return c.json({ message: "Workspace membership not found" }, 404);
    }

    return c.json(updated);
  },
);

/** Remove member from workspace */
member.delete(
  "/:memberId/workspaces/:workspaceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");
    const workspaceId = c.req.param("workspaceId");

    const [m] = await db
      .select()
      .from(organisationMember)
      .where(
        and(
          eq(organisationMember.id, memberId),
          eq(organisationMember.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!m) {
      return c.json({ message: "Member not found" }, 404);
    }

    const result = await db
      .delete(workspaceMember)
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.userId, m.userId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Workspace membership not found" }, 404);
    }

    return c.json({ message: "Member removed from workspace" });
  },
);

export { member };
