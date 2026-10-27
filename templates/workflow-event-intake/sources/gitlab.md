# GitLab source policy

This is a reference policy, not a default skill. Copy it into the agent workspace
and adapt it to your task system before use.

## Configuration

```bash
GITLAB_USERNAME='<gitlab-username>'
TASK_CLI='<task-cli>'
TASK_REPO='<task-repo>'
TASK_PREFIX='<task-prefix>'
BRANCH_PREFIX='work/'
REVIEW_WORKSPACE='<review-workspace>'
```

These are deployment values. Keep them here or read them from the coordinator's
standing instructions.

## Event to intent

| GitLab event | Intent | Condition |
| :--- | :--- | :--- |
| `merge_request.opened` / `reopened` / `updated` | `REVIEW_REQUEST` | author is not `GITLAB_USERNAME`, `GITLAB_USERNAME` is reviewer or assignee, not Draft |
| `note.created` on a merge request | `REVIEW_REQUEST` | same as above and the note is a human review request |
| `note.created` on a merge request | `FEEDBACK` | MR author is `GITLAB_USERNAME`, note author is not `GITLAB_USERNAME`, note is not system |
| `merge_request.approved` / `unapproved` | `FEEDBACK` | MR author is `GITLAB_USERNAME`; treat as task continuation, never auto-merge |
| `issue.opened` | `ISSUE_UPDATE` | assigned to `GITLAB_USERNAME`; queue the task, do not auto-start |
| `issue.updated` / issue note | `ISSUE_UPDATE` | `GITLAB_USERNAME` is assignee or an existing task references the issue |
| `merge_request.merged` / `closed` | `LIFECYCLE` | update or close the matching task |
| `issue.closed` | `LIFECYCLE` | update or close the matching task |
| `pipeline.*`, `push`, duplicate delivery | `NOISE` | inspect, then ack |

When an MR can be both a review request and feedback, decide by author:
`author == GITLAB_USERNAME` is feedback; otherwise it is a review request if
`GITLAB_USERNAME` is a reviewer or assignee.

## Resolve current state

Prefer GitLab's current state over the webhook snapshot:

```bash
glab mr view <iid> --repo "$REPO" --output json
glab issue view <iid> --repo "$REPO" --output json
```

`REPO` is the full path (`<group>/<project>`). `PROJECT` is the last segment.
`REVIEW_PROJECT` is a path-safe project name:

```bash
REPO='<group>/<project>'
PROJECT='<project>'
REVIEW_PROJECT='<project-path-slug>'
KEY="$REPO!$IID"
```

Keep for an MR: `author.username`, `reviewers[].username`,
`assignees[].username`, `state`, `draft`, `source_branch`, `target_branch`,
`sha`, `web_url`, `title`.
For a note, also keep `rawPayload.user.username`,
`rawPayload.object_attributes.note`, `rawPayload.object_attributes.id`, and
`created_at`.

Skip closed or merged MRs and closed issues.

## Dedupe keys

State file: `$REVIEW_WORKSPACE/intake-state.json`, key
`gitlab:<REPO>!<IID>`. The same GitLab note can be delivered more than once with
different inbox `entryId`s. Use `(subject, note id)` as the dedupe key.

For a review request, skip when both are true:

1. `head_sha == sha`
2. no human note is newer than `last_note_id`

For feedback, skip when the note id is not newer than `last_note_id`, or when
`last_driven_at` is newer than the note.

For an approval, record the event id or note id; do not drive the same approval
twice.

## Task mapping

- A branch `<BRANCH_PREFIX><n>-...` maps to the task id convention configured for
  this deployment (`<TASK_PREFIX><n>` by default).
- Verify the task's branch matches the MR `source_branch` before continuing it.
- A review request searches existing tasks whose title contains
  `<PROJECT>!<IID>` or `<REPO>!<IID>`.
- If a matching task is active, do not create another task.
- If it is done, create a new task only when the head revision changed.

## Review request

Create a review task in the configured task system and start it:

```bash
$TASK_CLI add "Review $PROJECT!$IID <short title>" \
  --repo "$TASK_REPO" --delegate \
  --desc "<brief>"
```

Brief template:

```text
GitLab review request: <MR_URL>

Repository: <REPO>
Project: <PROJECT>
MR: !<IID>
Head: <HEAD_SHA>
Base: <TARGET_BRANCH>
Author: <AUTHOR>
Event: <EVENT_VARIANT> (entry <ENTRY_ID>)

Use the project's review playbook.

1. Read the project instructions and the reviewer role.
2. Read all human notes before the diff.
3. Fetch origin <SOURCE_BRANCH>.
4. Create a detached worktree under:
   <REVIEW_WORKSPACE>/<REVIEW_PROJECT>/mr-<IID>
5. Inspect the diff and dependency impact with project-approved tooling.
6. Review against the project's spec, standards, and structure. Write notes to:
   <REVIEW_WORKSPACE>/<REVIEW_PROJECT>/mr-<IID>.md
7. Publish a review comment only under an explicit standing authorization.
   Do not approve, merge, close, resolve, commit, or push.
```

## Feedback

Find the task by `source_branch`. If the task is idle, send the original note:

```text
GitLab MR !<IID> has new review feedback (note <NOTE_ID>, <AUTHOR>, <CREATED_AT>):
<ORIGINAL NOTE>

MR: <MR_URL>
Continue <TASK> from the original text. Do not rewrite it into a conclusion.
```

For an approval or unapproval, send the state change and the head revision:

```text
GitLab MR !<IID> was <approved|unapproved> by <USER> at <TIME> (head <HEAD_SHA>).
Review the current state and continue <TASK>. Do not merge automatically.
```

After sending, update `last_note_id`, `head_sha`, and `last_driven_at`.

## Issue update

Search existing task descriptions for the issue URL. If found and idle, send the
original update. If the issue is new and has no task, add it without starting it.
Do not auto-start new issue work.

## Lifecycle

On merge or close, update or close the matching task. Do not approve, merge, or
close anything yourself.
