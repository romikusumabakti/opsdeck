# Deploy runbook

Short intro with **bold**, *italic*, ~~struck~~ and `inline code`, plus a [vendor page](https://example.com/docs) and a link to [Release checklist](/knowledge/release-checklist).

## Before you start

> Check the maintenance window with the on-call engineer.
>
> Second paragraph of the quote.

### Checklist

- [ ] Announce the window
- [x] Freeze merges
- [ ] Take a backup

1. Drain the node
2. Deploy the build
3. Verify the health check

- First bullet
- Second bullet with [Rollback guide](/knowledge/rollback-guide)

## Commands

```bash
./deploy.sh --env staging
echo "done"
```

```ts
const answer: number = 42;
```

## Hosts


| Host              | Role     | Notes   |
| ----------------- | -------- | ------- |
| app-1.example.net | Web      | Primary |
| db-1.example.net  | Database | `pg 18` |


![Network diagram of the staging cluster](/api/knowledge/asset/00000000-0000-4000-8000-000000000001)

Closing paragraph.
