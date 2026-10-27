# GitHub source adapter

Fill the configuration block before use. This is a reference policy, not a
default skill. Copy it into your agent workspace and adapt it to your board.

## Configuration

```bash
ME='<github-login>'
BOARD_REPO='<board-repo>'
REVIEW_ROOT='/path/to/review'
DEFAULT_BRANCH_PREFIX='work/'
BOARD_SHORT_KEY='<board-short-key>'
```

## Event to intent

| GitHub event | Intent | Condition |
| :--- | :--- | :--- |
| `pull_request.opened` / `reopened` / `ready_for_review` / `review_requested` | `REVIEW_REQUEST` | author is not `ME`, `ME` is requested reviewer or assignee, not draft |
| `pull_request.synchronize` | `REVIEW_REQUEST` | author is not `ME`, `ME` is reviewer, head sha changed since last review |
| `pull_request_review.submitted` | `FEEDBACK` | PR author is `ME`; inspect `review.state` (`approved`, `changes_requested`, `commented`) |
| `pull_request_review.dismissed` | `FEEDBACK` | PR author is `ME`; an approval was dismissed |
| `pull_request_review_comment.created` | `FEEDBACK` | PR author is `ME` |
| `issue_comment.created` on a PR | `FEEDBACK` | PR author is `ME`; comment author is human |
| `issue_comment.created` on an issue | `ISSUE_UPDATE` | issue is assigned to `ME` or an existing task references it |
| `issue.opened` | `ISSUE_UPDATE` | assigned to `ME`; queue the task, do not auto-start |
| `issue.closed` / `pull_request.closed` | `LIFECYCLE` | update or close the matching task |
| `pull_request.merged` | `LIFECYCLE` | update or close the matching task |
| `push`, `workflow_run.*`, `check_run.*`, duplicate delivery | `NOISE` | inspect, then ack |

When an event can be both a review request and feedback, decide by PR author:
`author == ME` is feedback; otherwise it is a review request if `ME` is a
requested reviewer or assignee.

## Resolve current state

Prefer GitHub's current state over the webhook snapshot:

```bash
gh pr view <number> --repo "$REPO" --json \
  number,title,url,state,isDraft,author,baseRefName,headRefName,headRefOid,\
reviewDecision,reviewRequests,assignees,comments,reviews
gh pr diff <number> --repo "$REPO"
gh issue view <number> --repo "$REPO" --json \
  number,title,url,state,author,assignees,comments
```

`REPO` is `owner/repo`. `PROJECT` is the last segment. `REVIEW_PROJECT` is the
path slug (`owner-repo`):

```bash
REPO='owner/repo'
PROJECT='repo'
REVIEW_PROJECT="${REPO//\//-}"
KEY="$PROJECT#$NUMBER"
FULL_KEY="$REPO#$NUMBER"
```

Keep for a PR: `author.login`, `reviewRequests[].login` (or `requested_reviewers`),
`assignees[].login`, `state`, `isDraft`, `baseRefName`, `headRefName`,
`headRefOid`, `url`, `title`.
For a review or comment, also keep `review.state`, `review.id`, `comment.id`,
`user.login`, `body`, `submitted_at` / `created_at`.

Skip closed/merged PRs and closed issues, except when the event is `LIFECYCLE`.

## Dedupe keys

State file: `$REVIEW_ROOT/intake-state.json`, key `github:<REPO>#<NUMBER>`.
The same GitHub delivery can produce multiple inbox entries; dedupe by the
source key, never by `entryId` alone.

For a review request, skip when both are true:

1. `head_sha == headRefOid`
2. no review or human comment is newer than `last_review_id` / `last_comment_id`

For feedback, skip when the review/comment id is not newer than the recorded
id, or when `last_driven_at` is newer than the review/comment timestamp.

For an issue, dedupe by `updatedAt` plus the latest human comment id.

## Task mapping

- A branch `work/<n>-...` maps to board task `<BOARD_SHORT_KEY>-<n>`.
  Verify `herdr-projects details <task>` branch equals the PR `headRefName`.
- A review request searches existing tasks whose title contains `<PROJECT>#<NUMBER>`
  or `<REPO>#<NUMBER>`.
- If a matching task is `working`, `reviewing`, or `approval`, do not create
  another task.
- If it is `done`, create a new task only when the head sha changed.

## Review request

Create a review task in the board and start it:

```bash
herdr-projects add "Review $REPO#$NUMBER <short title>" \
  --repo "$BOARD_REPO" --research --delegate \
  --desc "<brief>"
```

Brief template:

```text
GitHub review request: <PR_URL>

Repository: <REPO>
Project: <PROJECT>
PR: #<NUMBER>
Head: <HEAD_SHA>
Base: <BASE_BRANCH>
Author: <AUTHOR>
Event: <EVENT_VARIANT> (entry <ENTRY_ID>)

Use workflow-dsx playbook: review.

1. Read the project's AGENTS.md and the workflow-github Role: Reviewer.
2. Read all human reviews and comments before the diff.
3. git fetch origin <HEAD_BRANCH>
4. Create a detached worktree:
   <REVIEW_ROOT>/worktrees/<REVIEW_PROJECT>/pr-<NUMBER>
5. Run code-review-graph detect-changes / impact / query. No --brief.
6. Review Spec / Standards / Structure. Write:
   <REVIEW_ROOT>/<REVIEW_PROJECT>/pr-<NUMBER>.md
7. Publish the review comment only under an explicit standing authorization.
   Do not approve, request changes, merge, close, commit, or push.
```

## Feedback

Find the task by `headRefName`. If the task is idle, send the original review or
comment text:

```text
GitHub PR #<NUMBER> has new review feedback (id <ID>, <AUTHOR>, <TIME>):
<ORIGINAL BODY>

PR: <PR_URL>
Continue <TASK> from the original text. Do not rewrite it into a conclusion.
```

For an approval or changes-requested review, include the review state:

```text
GitHub PR #<NUMBER> review <STATE> by <USER> at <TIME> (head <HEAD_SHA>).
Review the current state and continue <TASK>. Do not merge automatically.
```

After sending, update `last_review_id` / `last_comment_id`, `head_sha`, and
`last_driven_at`.

## Issue update

Search existing task descriptions for the issue URL. If found and idle, send the
original update. If the issue is new and has no task, add it without `--delegate`.
Do not auto-start new issue work.

## Lifecycle

On merge or close, update or close the matching task. Do not approve, merge, or
close anything yourself.
