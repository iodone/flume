# GitLab source policy

Reference policy, not a default. Copy it into the agent workspace and fill in the
deployment values before use.

## Configuration

```bash
export GITLAB_HOST='<gitlab-host>'
GITLAB_USERNAME="${GITLAB_USERNAME:-$(glab api user | jq -r .username)}"
TASK_CLI='<task-cli>'
TASK_REPO='<review-task-repo>'
PROJECTS_ROOT='<projects-root>'
REVIEW_ROOT='<review-root>'
REVIEW_PLAYBOOK='<path-to-review-playbook>'
REVIEW_STATE='<review-state.json>'
FEEDBACK_STATE='<feedback-state.json>'
PUBLISH_REVIEW_COMMENTS=true   # standing authorization for comments only
ISSUE_POLICY='ignore'          # ignore | queue
BRANCH_PREFIX='work/'
```

`TASK_REPO` is where review tasks live. Own-MR tasks live in the project's own board
repo, named after the GitLab project's last path segment.

## Event to intent

| GitLab event | Intent | Condition |
| :--- | :--- | :--- |
| `merge_request.opened` / `reopened` / `updated` | `REVIEW_REQUEST` | author is not `GITLAB_USERNAME`, `GITLAB_USERNAME` is reviewer or assignee, not Draft |
| human `note.created` on an MR | `REVIEW_REQUEST` | same condition, and the note asks for review |
| human `note.created` on an MR | `FEEDBACK` | MR author is `GITLAB_USERNAME`, note author is not, note is not system |
| `merge_request.approved` / `unapproved` | `FEEDBACK` | MR author is `GITLAB_USERNAME`; continuation signal only |
| `merge_request.merged` / `closed` | `LIFECYCLE` | map to the task and finish it |
| `issue.opened` / `updated` / issue note | `ISSUE_UPDATE` | ignored while `ISSUE_POLICY=ignore` |
| `issue.closed` | `LIFECYCLE` | identical mapping; normally no task exists |
| `pipeline.*`, `push` without an MR, duplicate delivery | `NOISE` | inspect, then ack |

When an MR could be both a review request and feedback, decide by author: author is
`GITLAB_USERNAME` means feedback; otherwise it is a review request only if
`GITLAB_USERNAME` is a reviewer or assignee.

## Resolve current state

Prefer GitLab's current state over the webhook snapshot:

```bash
glab mr view "$IID" --repo "$REPO" --output json
glab issue view "$IID" --repo "$REPO" --output json
```

`REPO` is `<group>/<project>`, `PROJECT` is its last segment, `REVIEW_PROJECT` is
`${REPO//\//-}`. For an MR keep author, reviewers, assignees, state, draft,
`source_branch`, `target_branch`, `sha`, `web_url`, `title`. For a note also keep the
note id, author, body, and timestamp.

Skip closed or merged MRs and closed issues, except on `LIFECYCLE`.

## Local project directory

Build review worktrees from the target project's own checkout, found by remote:

```bash
PROJECT_DIR=
for d in "$PROJECTS_ROOT"/*/; do
  if git -C "$d" remote -v 2>/dev/null | grep -qF "$REPO"; then
    PROJECT_DIR="${d%/}"
    break
  fi
done
```

If it is empty, report `unmatched-project` and create no task.

## Dedupe keys

State key `<PROJECT>!<IID>`, with `<REPO>!<IID>` as a fallback. Skip when a review
task is active, when the task is done and `head_sha == sha`, or when the note or
approval id was already driven. One GitLab note can arrive as several inbox entries
with different `entryId`s; never dedupe by `entryId`.

## Review request

Open, non-draft MR, author is not `GITLAB_USERNAME`, `GITLAB_USERNAME` is reviewer or
assignee. Search existing tasks by title for `<PROJECT>!<IID>` or `<REPO>!<IID>`.

Create and start it:

```bash
$TASK_CLI add "Review $PROJECT!$IID <short title>" \
  --repo "$TASK_REPO" --research --delegate \
  --review.when never \
  --desc "<brief>"
```

`--review.when never` turns off the board's post-work automatic review. A review task
changes nothing, so an automatic review has nothing to review and only burns a
reviewer round.

Brief template:

```text
GitLab review request: <MR_URL>

Repository: <REPO>
Project: <PROJECT> (review slug: <REVIEW_PROJECT>)
MR: !<IID>
Head: <HEAD_SHA>
Base: <TARGET_BRANCH>
Source: <SOURCE_BRANCH>
Author: <AUTHOR>
Event: <EVENT_VARIANT> (entry <ENTRY_ID>)

Evidence worktree (from the project, not from the board worktree):
  git -C <PROJECT_DIR> fetch origin <SOURCE_BRANCH>
  git -C <PROJECT_DIR> worktree add --detach \
    <REVIEW_ROOT>/worktrees/<REVIEW_PROJECT>/mr-<IID> FETCH_HEAD

1. Read the project instructions and <REVIEW_PLAYBOOK>.
2. glab mr view <IID> --repo <REPO>; read all human notes before the diff.
3. Review Spec / Standards / Structure. Write <REVIEW_ROOT>/<REVIEW_PROJECT>/mr-<IID>.md
4. Publish one review comment per head sha, only when PUBLISH_REVIEW_COMMENTS is true.
   Do not approve, merge, close, resolve, commit, or push.
5. Record head_sha, last_note_id, review_doc, reviewed_at, verdict, task_id,
   comment_note_ids in <REVIEW_STATE>.
```

## Review publishing

`PUBLISH_REVIEW_COMMENTS=true` authorizes posting the review as an MR comment, and
nothing else. Publish at most one comment per `(MR, head sha)`; add a second only when
a human note arrived after the previous round. Record `comment_note_ids`.

## Feedback

Map `BRANCH_PREFIX<n>-...` to the project's task number, then confirm the task's
`branch` field equals the source branch:

```bash
N="$(printf '%s' "$SOURCE_BRANCH" | sed -n 's#^work/\([0-9][0-9]*\)-.*#\1#p')"
test -n "$N" || { echo unmatched; exit 0; }
```

Apply the FEEDBACK state table in `../SKILL.md`. Send the original text:

```text
GitLab MR !<IID> has new review feedback (note <NOTE_ID>, <AUTHOR>, <CREATED_AT>):
<ORIGINAL NOTE>

MR: <MR_URL>
Continue <TASK_ID> from the original text. Do not rewrite it into a conclusion.
```

For approval or unapproval send the state change instead. After sending, update
`last_note_id` / `last_event_id`, `head_sha`, `last_driven_at`, `task`.

## Issue update

`ISSUE_POLICY=ignore`: inspect, ack, no task, no message. `queue`: add the task
without `--delegate`; the human decides whether to claim it.

## Lifecycle

On merge or close, finish the matching task:

```bash
$TASK_CLI report <id> --state done --msg "GitLab MR !<IID> <merged|closed> at <TIME>"
```

Own MR: map `source_branch` to the project's task. Review task: search by title for
`<PROJECT>!<IID>` or `<REPO>!<IID>`. No match: report `unmatched`. Never approve,
merge, or close anything yourself.
