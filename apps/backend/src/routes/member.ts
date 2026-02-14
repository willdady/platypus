import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import { organizationMember, user as userTable } from "../db/schema.ts";
import { organizationMemberUpdateSchema } from "@platypus/schemas";
import { eq, and, count } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess, isSuperAdmin } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const member = new Hono<{ Variables: Variables }>();

/** List all organization members */
member.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const orgId = c.req.param("orgId")!;

  const members = await db
    .select({
      id: organizationMember.id,
      organizationId: organizationMember.organizationId,
      userId: organizationMember.userId,
      role: organizationMember.role,
      createdAt: organizationMember.createdAt,
      updatedAt: organizationMember.updatedAt,
      user: {
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
        role: userTable.role,
      },
    })
    .from(organizationMember)
    .innerJoin(userTable, eq(organizationMember.userId, userTable.id))
    .where(eq(organizationMember.organizationId, orgId));

  const results = members.map((m) => ({
    ...m,
    isSuperAdmin: isSuperAdmin(m.user),
  }));

  return c.json({ results });
});

/** Get a single organization member with details */
member.get(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");

    const [m] = await db
      .select({
        id: organizationMember.id,
        organizationId: organizationMember.organizationId,
        userId: organizationMember.userId,
        role: organizationMember.role,
        createdAt: organizationMember.createdAt,
        updatedAt: organizationMember.updatedAt,
        user: {
          id: userTable.id,
          name: userTable.name,
          email: userTable.email,
          image: userTable.image,
          role: userTable.role,
        },
      })
      .from(organizationMember)
      .innerJoin(userTable, eq(organizationMember.userId, userTable.id))
      .where(
        and(
          eq(organizationMember.id, memberId),
          eq(organizationMember.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!m) {
      return c.json({ message: "Member not found" }, 404);
    }

    return c.json({
      ...m,
      isSuperAdmin: isSuperAdmin(m.user),
    });
  },
);

/** Update organization member role */
member.patch(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", organizationMemberUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const memberId = c.req.param("memberId");
    const { role: newRole } = c.req.valid("json");
    const currentUser = c.get("user")!;

    const [targetMember] = await db
      .select()
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.id, memberId),
          eq(organizationMember.organizationId, orgId),
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
        .from(organizationMember)
        .where(
          and(
            eq(organizationMember.organizationId, orgId),
            eq(organizationMember.role, "admin"),
          ),
        );

      if (adminCountResult.value <= 1) {
        return c.json(
          { error: "Cannot demote the last organization admin" },
          400,
        );
      }
    }

    const [updated] = await db
      .update(organizationMember)
      .set({ role: newRole, updatedAt: new Date() })
      .where(eq(organizationMember.id, memberId))
      .returning();

    return c.json(updated);
  },
);

/** Remove member from organization */
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
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.id, memberId),
          eq(organizationMember.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!targetMember) {
      return c.json({ message: "Member not found" }, 404);
    }

    // Self-removal protection
    if (targetMember.userId === currentUser.id) {
      return c.json(
        { error: "You cannot remove yourself from the organization" },
        400,
      );
    }

    // Last admin protection
    if (targetMember.role === "admin") {
      const [adminCountResult] = await db
        .select({ value: count() })
        .from(organizationMember)
        .where(
          and(
            eq(organizationMember.organizationId, orgId),
            eq(organizationMember.role, "admin"),
          ),
        );

      if (adminCountResult.value <= 1) {
        return c.json(
          { error: "Cannot remove the last organization admin" },
          400,
        );
      }
    }

    // Deleting org membership will cascade delete their workspaces via ownerId FK
    await db
      .delete(organizationMember)
      .where(eq(organizationMember.id, memberId));

    return c.json({ message: "Member removed from organization" });
  },
);

export { member };
