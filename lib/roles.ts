// Role constants kept in their own module so client components can import
// them without pulling in `lib/auth.ts` (which transitively imports the
// postgres driver — a server-only dependency).
export const ROLE_ADMIN = "admin";
export const ROLE_MEMBER = "member";
export type UserRole = typeof ROLE_ADMIN | typeof ROLE_MEMBER;
