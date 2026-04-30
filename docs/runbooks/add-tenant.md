# Runbook: Add a tenant

Onboard a new user (and optionally a new project) into ChemClaw. Assumes the
Phase 1 admin RBAC is in place (`db/init/18_admin_roles_and_audit.sql`).

## Prerequisites

- The new user has an Entra ID (e.g. `alice@contoso.onmicrosoft.com`).
- You have either:
  - A `global_admin` row in `admin_roles`, OR
  - Your Entra ID listed in `AGENT_ADMIN_USERS` (bootstrap fallback).

## 1. Verify your admin status

```bash
curl -H "x-user-entra-id: $YOU" \
     "$AGENT_BASE_URL/api/admin/users/$YOU/admin-roles"
```

Expect a JSON array containing at least `{ "role": "global_admin" }`.

## 2. (Optional) Create the project

If the tenant needs a new project:

```sql
INSERT INTO nce_projects (id, name, created_at)
VALUES (gen_random_uuid(), 'Acme Discovery 2026', NOW())
RETURNING id;
```

Note the returned `id` for the next step.

## 3. Grant project access

`user_project_access` is the per-project ACL (separate from `admin_roles`,
which gates `/api/admin/*`).

```sql
INSERT INTO user_project_access (user_entra_id, nce_project_id, role)
VALUES ('alice@contoso.onmicrosoft.com', '<project-uuid>', 'contributor');
```

`role` ∈ `viewer | contributor | project_lead | admin`.

## 4. (Optional) Grant scoped admin

If the tenant should administer their own org's permission policies and
config settings without being a `global_admin`:

```bash
curl -X POST -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{"role":"org_admin","scope_id":"<org-id>","reason":"tenant onboarding"}' \
  "$AGENT_BASE_URL/api/admin/users/alice@contoso.onmicrosoft.com/admin-role"
```

The new admin can now manage `/api/admin/config/org/<org-id>`,
`/api/admin/permission-policies` (org-scoped), and
`/api/admin/redaction-patterns` (org-scoped).

## 5. (Optional) Set per-tenant config defaults

Per Phase 2, each tenant can have its own defaults:

```bash
curl -X PATCH -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{"value": 2000000, "description": "doubled session input budget"}' \
  "$AGENT_BASE_URL/api/admin/config/org/<org-id>?key=agent.session_input_token_budget"
```

## 6. Verify

The new user logs in, hits `/api/chat`, and confirms project visibility.
Audit row:

```bash
curl -H "x-user-entra-id: $YOU" \
  "$AGENT_BASE_URL/api/admin/audit?actor=$YOU&limit=10"
```

## Rollback

- Revoke project access: `DELETE FROM user_project_access WHERE …`.
- Revoke admin role: `DELETE … /api/admin/users/<id>/admin-role?role=…&scope_id=…`.
- Drop config row: `DELETE … /api/admin/config/org/<org-id>?key=…`.

All three paths leave audit log rows.
