export interface Backup {
  name: string;
  size: string;
}

/** The minimum needed to render a user as an avatar and a linked name. */
export type UserRef = { id: string; name: string; image: string | null };

/** Profile fields shown on the hover card. Carries no project data. */
export type UserCardData = UserRef & {
  email: string;
  title: string | null;
  bio: string | null;
  role: string;
  timeZone: string;
  workingHours: { days: number[]; start: string; end: string } | null;
  status: {
    emoji: string | null;
    text: string | null;
    expiresAt: string | null;
  } | null;
  jiraUrl: string | null;
  deactivated: boolean;
};

/**
 * The result every mutating server action returns.
 *
 * A discriminated union, not `{ success: boolean; message?: string }` — the
 * union makes `message` non-optional on the failure branch, so a caller that
 * checks `success` gets a `string` to show the user instead of
 * `string | undefined` it has to coalesce.
 *
 * `T` is the payload a successful action hands back. Left off (the `never`
 * default) the success branch carries no `data` at all; supplied, `data` is
 * REQUIRED on success, so `res.data` needs no second null check after
 * narrowing. Actions that only sometimes return a payload should say so:
 * `ActionResponse<Issue | undefined>`.
 */
export type ActionResponse<T = never> =
  | ([T] extends [never]
      ? { success: true; message?: string }
      : { success: true; message?: string; data: T })
  | { success: false; message: string };
