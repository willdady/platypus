import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import { organizationMember, user as userTable } from "../db/schema.ts";
import {
  organizationMemberRemoveSchema,
  organizationMemberUpdateSchema,
} from "@platypus/schemas";
import { eq, and, type SQL } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  isSuperAdmin,
  orgScopeOf,
  requireOrgAccess,
} from "../middleware/authorization.ts";
import { isBanned } from "../services/owner-membership.ts";
import { removeMember } from "../services/member-removal.ts";
import { changeMemberRole } from "../services/member-role.ts";
import type { Variables } from "../server.ts";

const member = new Hono<{ Variables: Variables }>();

/** The members matching `where`, in the shape both GETs return. */
const selectMembers = (where: SQL | undefined) =>
  db
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
        banned: userTable.banned,
        banExpires: userTable.banExpires,
      },
    })
    .from(organizationMember)
    .innerJoin(userTable, eq(organizationMember.userId, userTable.id))
    .where(where);

type MemberRow = Awaited<ReturnType<typeof selectMembers>>[number];

const toMemberResponse = ({
  user: { banned, banExpires, ...user },
  ...m
}: MemberRow) => ({
  ...m,
  user,
  isSuperAdmin: isSuperAdmin(user),
  isBanned: isBanned({ banned, banExpires }),
});

/** List all organization members */
member.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const { orgId } = orgScopeOf(c);

  const members = await selectMembers(
    eq(organizationMember.organizationId, orgId),
  );

  return c.json({ results: members.map(toMemberResponse) });
});

/** Get a single organization member with details */
member.get(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const memberId = c.req.param("memberId");

    const [m] = await selectMembers(
      and(
        eq(organizationMember.id, memberId),
        eq(organizationMember.organizationId, orgId),
      ),
    ).limit(1);

    if (!m) {
      return c.json({ error: "Member not found" }, 404);
    }

    return c.json(toMemberResponse(m));
  },
);

/** Update organization member role */
member.patch(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", organizationMemberUpdateSchema),
  async (c) => {
    const updated = await changeMemberRole({
      orgId: orgScopeOf(c).orgId,
      memberId: c.req.param("memberId"),
      role: c.req.valid("json").role,
      actorUserId: c.get("user")!.id,
    });

    return c.json(updated);
  },
);

/** Remove member from organization */
member.delete(
  "/:memberId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", organizationMemberRemoveSchema),
  async (c) => {
    const currentUser = c.get("user")!;

    await removeMember({
      orgId: orgScopeOf(c).orgId,
      memberId: c.req.param("memberId"),
      actorUserId: currentUser.id,
      workspaces: c.req.valid("json").workspaces,
      transferredBy: currentUser.name,
    });

    return c.json({ message: "Member removed from organization" });
  },
);

export { member };
