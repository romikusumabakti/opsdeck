export interface Backup {
  name: string;
  size: string;
}

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
