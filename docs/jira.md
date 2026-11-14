# Jira integration

A project can mirror one Jira project, so `ABC-42` in OpsDeck is the same work
item as `ABC-42` in Jira. Jira stays the source of truth: OpsDeck pulls
issues and comments, and pushes a few fields back only when you turn that on.

Jira Cloud (`/rest/api/3`) and Data Center (`/rest/api/2`) are both supported.

## Set up

1. **Add the site** (Admin → Jira → New): the site URL plus, on Cloud, the
   account email and an API token, or on Data Center a personal access
   token. Use a dedicated service account, not a person's, and scope its token to
   reading work items; add write scopes only if you enable push. The token is
   encrypted at rest under `SECRETS_KEY`.
2. **Register the webhook** in Jira (Settings → System → WebHooks) with the
   URL shown on the site's page in OpsDeck, for the events
   `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`,
   `comment_created`, `comment_updated` and `comment_deleted`. Jira only lets
   Connect and Forge apps register webhooks over REST, so this step is manual.
   Webhooks created in the admin UI don't expire.
3. **Link a project** (project settings → Jira) and run the first sync.

## How sync works

- A webhook is only a signal. OpsDeck re-fetches the issue by id and never
  trusts the payload.
- A reconcile sweep runs every 15 minutes per linked project, starting 5
  minutes before the last sync, so missed webhooks and downtime still
  converge.
- Deleting an issue in Jira leaves the OpsDeck copy as it was; nothing is
  deleted locally.
- The latest 100 comments per issue are mirrored. Attachments and sprints are
  not; issues link to Jira for those.
- Unlinking keeps the Jira ids on the issues, so relinking matches them in
  place instead of creating duplicates.

## Push (opt-in per project)

When push is enabled, changes made in OpsDeck to status, assignee, title,
description, priority and new comments are sent to Jira. If the issue changed
in Jira first, Jira wins: the editor gets a notification and the discarded
edit is recorded in the activity log. Issues are created in Jira, not in
OpsDeck.

## Security

The webhook URL contains its secret, so it can show up in proxy access logs.
A leaked URL only lets someone trigger a re-sync: the endpoint takes an issue
id and fetches the issue from Jira itself.
