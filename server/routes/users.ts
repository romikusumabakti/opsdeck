import { z } from "zod";
import { requireSession } from "@/lib/auth-session";
import { getUserCard } from "@/lib/people/card";
import {
  getPersonMeta,
  getPersonProjects,
  listPeople,
  listPersonOpenIssues,
  listPersonRecentRuns,
} from "@/lib/people/queries";
import { uuidSchema } from "@/lib/validation";
import { notFound } from "@/server/errors";
import { publicRouter, sessionRouter } from "@/server/router";
import {
  acceptInvitation,
  bulkDeleteUsers,
  bulkRevokeInvitations,
  createInitialUser,
  deleteUser,
  getInvitationByToken,
  hasAnyUser,
  inviteUser,
  listAssignableUsers,
  listAssignableUsersAcrossProjects,
  listPendingInvitations,
  listUsers,
  resendInvitation,
  revokeInvitation,
  updateUserRole,
} from "@/server/services/users";
import { json, query } from "@/server/validation";

// Free-text fields are checked by the services, which answer with translated
// messages the forms show (blank name, disallowed domain, password length).
// The schemas here only fix the shape and bound the size.
const text = z.string().max(1000);
// Above any sane password; the service enforces better-auth's real limits.
const password = z.string().max(4096);
// One admin page of users or invitations.
const ids = z.array(uuidSchema).max(500);

// Rows on a person's page, so the two side-by-side lists stay level (the
// page's LIST_ROWS).
const PERSON_LIST_ROWS = 8;

/**
 * Onboarding: the steps that run before the caller has an account (first-run
 * setup, accepting an invitation) and the checks the sign-in and setup pages
 * make while signed out. Public, so it lives on its own prefix — a session
 * router mounted at /api/users would gate it.
 */
export const onboardingRouter = publicRouter()
  .get("/has-any-user", async (c) => c.json(await hasAnyUser()))
  .post(
    "/create-initial-user",
    json(
      z.object({
        input: z.object({ name: text, email: text, password }),
      })
    ),
    async (c) => c.json(await createInitialUser(c.req.valid("json").input))
  )
  .get(
    "/get-invitation-by-token",
    query(z.object({ token: z.string().min(1).max(200) })),
    async (c) => {
      const inv = await getInvitationByToken(c.req.valid("query").token);
      // Only what the accept-invite page shows. The row also carries the
      // inviter, role and timestamps, none of which a link holder needs.
      return c.json(inv && { email: inv.email, name: inv.name });
    }
  )
  .post(
    "/accept-invitation",
    json(z.object({ input: z.object({ token: text, password }) })),
    async (c) => c.json(await acceptInvitation(c.req.valid("json").input))
  );

export const usersRouter = sessionRouter()
  .get(
    "/list-assignable-users",
    query(z.object({ projectId: uuidSchema })),
    async (c) =>
      c.json(await listAssignableUsers(c.req.valid("query").projectId))
  )
  .get("/list-assignable-users-across-projects", async (c) =>
    c.json(await listAssignableUsersAcrossProjects())
  )
  .get("/list-users", async (c) => c.json(await listUsers()))
  .get("/list-pending-invitations", async (c) =>
    c.json(await listPendingInvitations())
  )
  .post(
    "/invite-user",
    json(
      z.object({
        input: z.object({ email: text, name: text, role: z.string().max(32) }),
      })
    ),
    async (c) => c.json(await inviteUser(c.req.valid("json").input))
  )
  .post(
    "/update-user-role",
    json(
      z.object({
        input: z.object({ userId: uuidSchema, role: z.string().max(32) }),
      })
    ),
    async (c) => c.json(await updateUserRole(c.req.valid("json").input))
  )
  .post("/delete-user", json(z.object({ userId: uuidSchema })), async (c) =>
    c.json(await deleteUser(c.req.valid("json").userId))
  )
  .post(
    "/revoke-invitation",
    json(z.object({ invitationId: uuidSchema })),
    async (c) =>
      c.json(await revokeInvitation(c.req.valid("json").invitationId))
  )
  .post(
    "/resend-invitation",
    json(z.object({ invitationId: uuidSchema })),
    async (c) =>
      c.json(await resendInvitation(c.req.valid("json").invitationId))
  )
  .post("/bulk-delete-users", json(z.object({ ids })), async (c) =>
    c.json(await bulkDeleteUsers(c.req.valid("json").ids))
  )
  .post("/bulk-revoke-invitations", json(z.object({ ids })), async (c) =>
    c.json(await bulkRevokeInvitations(c.req.valid("json").ids))
  )
  // --- Page data (people pages), straight from lib/people. Both pages needed
  // only a session; the queries scope anything carrying a project to the
  // viewer's projects.
  .get("/people", async (c) => {
    const session = await requireSession();
    return c.json(await listPeople(session.user.role));
  })
  .get("/:id/person", async (c) => {
    const session = await requireSession();
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) notFound();
    // The card decides visibility (a deactivated user is hidden from non-user
    // admins); nothing else about the person is read unless it allows.
    const card = await getUserCard(id, session.user);
    if (!card) notFound();
    const [projects, openIssues, runs, meta] = await Promise.all([
      getPersonProjects(id),
      listPersonOpenIssues(id, PERSON_LIST_ROWS),
      listPersonRecentRuns(id),
      getPersonMeta(id),
    ]);
    return c.json({ card, projects, openIssues, runs, meta });
  })
  // --- Ported from app/api/users/[id]/card: same path and responses (the
  // hover card fetches it).
  .get("/:id/card", async (c) => {
    const session = await requireSession();
    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return new Response("Bad request", { status: 400 });
    }
    const card = await getUserCard(id, session.user);
    if (!card) return new Response("Not found", { status: 404 });
    // Status and name change; the client cache (60 s) absorbs repeat hovers.
    return c.json(card, 200, { "Cache-Control": "private, no-store" });
  });
