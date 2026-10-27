# GitLab source adapter

Fill the configuration block before use. This is a template, not a zero-config
policy for a real GitLab instance.

## Configuration

```bash
ME='<gitlab-username>'
BOARD_REPO='<board-repo>'
REVIEW_ROOT='/path/to/review'
DEFAULT_BRANCH_PREFIX='work/'
BOARD_SHORT_KEY='<board-short-key>'
```

`ME`, `BOARD_REPO`, `REVIEW_ROOT`, and `BOARD_SHORT_KEY` are deployment values.
Keep them here or read them from the coordinator's standing instructions.

## Event to intent

| GitLab event | Intent | Condition |
| :--- | :--- | :--- |
| `merge_request.opened` / `reopened` / `updated` | `REVIEW_REQUEST` | author is not `ME`, `ME` is reviewer or assignee, not Draft |
| `note.created` on a merge request | `REVIEW_REQUEST` | same as above and the note is a human review request |
| `note.created` on a merge request | `FEEDBACK` | MR author is `ME`, note author is not `ME`, note is not system |
| `merge_request.approved` / `unapproved` | `FEEDBACK` | MR author is `ME`; treat as task continuation, never auto-merge |
| `issue.opened` | `ISSUE_UPDATE` | assigned to `ME`; queue the task, do not auto-start |
| `issue.updated` / issue note | `ISSUE_UPDATE` | `ME` is assignee or an existing task references the issue |
| `merge_request.merged` / `closed` | `LIFECYCLE` | update or close the matching task |
| `issue.closed` | `LIFECYCLE` | update or close the matching task |
| `pipeline.*`, `push`, duplicate delivery | `NOISE` | inspect, then ack |

When an MR can be both a review request and feedback, decide by author:
`author == ME` is feedback; otherwise it is a review request if `ME` is a
reviewer or assignee.

## Resolve current state

Prefer GitLab's current state over the webhook snapshot:

```bash
glab mr view <iid> --repo "$REPO" --output json
glab issue view <iid> --repo "$REPO" --output json
```

`REPO` is the full path (`group/project`). `PROJECT` is the last segment.
`REVIEW_PROJECT` is the path slug (`group-project`):

```bash
REPO='group/project'
PROJECT='project'
REVIEW_PROJECT="${REPO//\//-}"
KEY="$PROJECT!$IID"
FULL_KEY="$REPO!$IID"
```

Keep for an MR: `author.username`, `reviewers[].username`, `assignees[].username`,
`state`, `draft`, `source_branch`, `target_branch`, `sha`, `web_url`, `title`.
For a note, also keep `rawPayload.user.username`,
`rawPayload.object_attributes.note`, `rawPayload.object_attributes.id`, and
`created_at`.

Skip closed or merged MRs and closed issues.

## Dedupe keys

State file: `$REVIEW_ROOT/intake-state.json`, key `gitlab:<REPO>!<IID>`.

For a review request, skip when both are true:

1. `head_sha == sha`
2. no human note is newer than `last_note_id`

For feedback, skip when the note id is not newer than `last_note_id`, or when
`last_driven_at` is newer than the note.

For an approval, record the event id or note id; do not drive the same approval
twice.

## Task mapping

- A branch `work/<n>-...` maps to board task `<BOARD_SHORT_KEY>-<n>`.
  Verify `herdr-projects details <task>` branch equals the MR `source_branch`.
- A review request searches existing tasks whose title contains `<PROJECT>!<IID>`
  or `<REPO>!<IID>`.
- If a matching task is `working`, `reviewing`, or `approval`, do not create
  another task.
- If it is `done`, create a new task only when the head sha changed.

## Review request

Create a review task in the board and start it:

```bash
herdr-projects add "Review $PROJECT!$IID <short title>" \
  --repo "$BOARD_REPO" --research --delegate \
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

Use workflow-dsx playbook: review.

1. Read the project's AGENTS.md and the workflow-gitlab Role: Reviewer.
2. Read all human notes before the diff.
3. git fetch origin <SOURCE_BRANCH>
4. Create a detached worktree:
   <REVIEW_ROOT>/worktrees/<REVIEW_PROJECT>/mr-<IID>
5. Run code-review-graph detect-changes / impact / query. No --brief.
6. Review Spec / Standards / Structure. Write:
   <REVIEW_ROOT>/<REVIEW_PROJECT>/mr-<IID>.md
7. Publish the review comment only under an explicit standing authorization.
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

For an approval or unapproval, send the state change and the head sha:

```text
GitLab MR !<IID> was <approved|unapproved> by <USER> at <TIME> (head <HEAD_SHA>).
Review the current state and continue <TASK>. Do not merge automatically.
```

After sending, update `last_note_id`, `head_sha`, and `last_driven_at`.

## Issue update

Search existing task descriptions for the issue URL. If found and idle, send the
original update. If the issue is new and has no task, add it without `--delegate`.
Do not auto-start new issue work.

## Lifecycle

On merge or close, update or close the matching task. Do not approve, merge, or
close anything yourself.
