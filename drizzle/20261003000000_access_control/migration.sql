-- Access control rework (docs/superpowers/specs/2026-10-03-access-control-design.md).
-- Org roles: admin | infra | observer | member. Project roles: viewer |
-- contributor | maintainer. Per-person assignments (infra/observer, demoting
-- memberships to contributor, offboarding) are a separate, uncommitted rollout
-- script — this file only maps old values to their safe new equivalents.
BEGIN;

UPDATE users
   SET role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END
 WHERE role IS DISTINCT FROM CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END;

UPDATE invitations
   SET role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END
 WHERE role IS DISTINCT FROM CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END;

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE invitations ALTER COLUMN role SET DEFAULT 'member';

CREATE TYPE project_role_v2 AS ENUM ('viewer', 'contributor', 'maintainer');

ALTER TABLE project_members
  ALTER COLUMN role TYPE project_role_v2
  USING (CASE role::text
           WHEN 'admin' THEN 'maintainer'
           WHEN 'maintainer' THEN 'maintainer'
           WHEN 'member' THEN 'contributor'
           ELSE 'viewer'
         END)::project_role_v2;

DROP TYPE project_role;
ALTER TYPE project_role_v2 RENAME TO project_role;

COMMIT;
