# GitHub source policy

This is a reference policy, not a default skill. Copy it into the agent workspace
and adapt it to your task system before use.

## Configuration

```bash
GITHUB_LOGIN='<github-login>'
TASK_CLI='<task-cli>'
TASK_REPO='<task-repo>'
TASK_PREFIX='<task-prefix>'
BRANCH_PREFIX='work/'
ISSUE_POLICY='ignore'          # ignore | queue
PUBLISH_REVIEW_COMMENTS=true   # standing authorization for comments only
REVIEW_WORKSPACE='<review-workspace>'
```

These are deployment values. Keep them here or read them from the coordinator's
standing instructions.

## Event to intent

| GitHub event | Intent | Condition |
| :--- | :--- | :--- |
| `pull_request.opened` / `reopened` / `ready_for_review` / `review_requested` | `REVIEW_REQUEST` | author is not `GITHUB_LOGIN`, `GITHUB_LOGIN` is requested reviewer or assignee, not draft |
| `pull_request.synchronize` | `REVIEW_REQUEST` | author is not `GITHUB_LOGIN`, `GITHUB_LOGIN` is reviewer, head revision changed since last review |
| `pull_request_review.submitted` | `FEEDBACK` | PR author is `GITHUB_LOGIN`; inspect `review.state` (`approved`, `changes_requested`, `commented`) |
| `pull_request_review.dismissed` | `FEEDBACK` | PR author is `GITHUB_LOGIN`; an approval was dismissed |
| `pull_request_review_comment.created` | `FEEDBACK` | PR author is `GITHUB_LOGIN` |
| `issue_comment.created` on a PR | `FEEDBACK` | PR author is `GITHUB_LOGIN`; comment author is human |
| `issue_comment.created` on an issue | `ISSUE_UPDATE` | issue is assigned to `GITHUB_LOGIN` or an existing task references it |
| `issue.opened` | `ISSUE_UPDATE` | assigned to `GITHUB_LOGIN`; queue the task, do not auto-start |
| `issue.closed` / `pull_request.closed` | `LIFECYCLE` | update or close the matching task |
| `pull_request.merged` | `LIFECYCLE` | update or close the matching task |
| `push`, `workflow_run.*`, `check_run.*`, duplicate delivery | `NOISE` | inspect, then ack |

When an event can be both a review request and feedback, decide by PR author:
`author == GITHUB_LOGIN` is feedback; otherwise it is a review request if
`GITHUB_LOGIN` is a requested reviewer or assignee.

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

`REPO` is `<owner>/<repo>`. `PROJECT` is the last segment. `REVIEW_PROJECT` is a
path-safe project name:

```bash
REPO='<owner>/<repo>'
PROJECT='<repo>'
REVIEW_PROJECT='<repo-path-slug>'
KEY="$REPO#$NUMBER"
```

Keep for a PR: `author.login`, `reviewRequests[].login` (or
`requested_reviewers`), `assignees[].login`, `state`, `isDraft`, `baseRefName`,
`headRefName`, `headRefOid`, `url`, `title`.
For a review or comment, also keep `review.state`, `review.id`, `comment.id`,
`user.login`, `body`, `submitted_at` / `created_at`.

Skip closed or merged PRs and closed issues, except when the event is
`LIFECYCLE`.

## Dedupe keys

State file: `$REVIEW_WORKSPACE/intake-state.json`, key
`github:<REPO>#<NUMBER>`. The same GitHub delivery can produce multiple inbox
entries; dedupe by the source key, never by `entryId` alone.

For a review request, skip when both are true:

1. `head_sha == headRefOid`
2. no review or human comment is newer than `last_review_id` /
   `last_comment_id`

For feedback, skip when the review or comment id is not newer than the recorded
id, or when `last_driven_at` is newer than the review or comment timestamp.

For an issue, dedupe by `updatedAt` plus the latest human comment id.

## Task mapping

- A branch `<BRANCH_PREFIX><n>-...` maps to the task id convention configured for
  this deployment (`<TASK_PREFIX><n>` by default).
- Verify the match through the task's worktree branch when the task system
  exposes one; otherwise fall back to the task title. Never trust a guess.
- A review request searches existing tasks whose title contains
  `<PROJECT>#<NUMBER>` or `<REPO>#<NUMBER>`.
- If a matching task is active, do not create another task.
- If it is done, create a new task only when the head revision changed.

## Review request

Create a review task in the configured task system and start it:

```bash
$TASK_CLI add "Review $REPO#$NUMBER <short title>" \
  --repo "$TASK_REPO" --research --delegate \
  --review.when never \
  --desc "<brief>"
```

`--review.when never` turns off the board's post-work automatic review. A review
task changes nothing, so an automatic review has nothing to review and only burns
a reviewer round.

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

Use the project's review playbook.

1. Read the project instructions and the reviewer role.
2. Read all human reviews and comments before the diff.
3. Fetch origin <HEAD_BRANCH>.
4. Create a detached worktree under:
   <REVIEW_WORKSPACE>/<REVIEW_PROJECT>/pr-<NUMBER>
5. Inspect the diff and dependency impact with project-approved tooling.
6. Review against the project's spec, standards, and structure. Write notes to:
   <REVIEW_WORKSPACE>/<REVIEW_PROJECT>/pr-<NUMBER>.md
7. Publish one review comment per head revision, only when
   PUBLISH_REVIEW_COMMENTS is true. Do not approve, request changes, merge,
   close, commit, or push.
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

`ISSUE_POLICY=ignore`: inspect and ack, no task and no message. `queue`: search
existing task descriptions for the issue URL; if found and idle, send the original
update, otherwise add the task without starting it. Never auto-start issue work.

## Lifecycle

On merge or close, finish the matching task:

```bash
$TASK_CLI report <id> --state done --msg "<merged|closed> at <TIME>"
```

Say whether it was merged or closed, so a close without merge is not hidden. Do not
approve, merge, or close anything yourself.
