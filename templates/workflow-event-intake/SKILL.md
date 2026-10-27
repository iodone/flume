---
name: workflow-event-intake
description: "Route flume/AgentInbox events into board tasks. Use when a flume activation arrives, or when an inbox event must become or continue a task. Not for periodic scans or task execution."
---

# Workflow Event Intake

A flume activation is a wake signal, not the event: flume verified a webhook, wrote it
to AgentInbox, and asked the agent to look. The body stays in the inbox.

This skill is the **admission layer**. It decides which events become or continue a
board task. It does not execute them. Every task admitted here is executed under
`workflow-dsx`.

Intents are peers. A review request, a review comment, an issue update, and a merge
are each one admission decision; no intent is the default.

## Three layers

| Layer | Owns | Never does |
| :--- | :--- | :--- |
| flume | verify, normalize, write the inbox, wake | classify, create tasks |
| this skill | read, classify, dedupe, admit or continue, ack | implement, review, write code |
| workflow-dsx | pick the playbook, execute, verify | decide whether an event is actionable |

## Execution

All admitted work runs under `workflow-dsx`. This file names the handoff; the playbook
owns the steps.

- `REVIEW_REQUEST` → `workflow-dsx/playbooks/review.md` (standalone review; nothing is
  implemented in that run).
- `FEEDBACK` → the task's existing playbook. If none is recorded, route with dsx's
  `allowedNext`, falling back to `figure-it-out`.
- `ISSUE_UPDATE` queued → no execution until a human claims it.
- `LIFECYCLE` / `NOISE` → no execution.

Do not restate dsx steps here. dsx owns execution; this file owns admission.

## Process

### 1. Read

```bash
agentinbox inbox read --agent-id "$AGENT_ID" --limit 50 --full
```

Record every `entryId`, and the last one you actually inspect. That entry is the only
legal ack boundary.

The activation carries `agentId`, `newEntryCount`, optionally `latestEntryId` and
`intakeSkill`. It carries no event body. An inbox entry carries `metadata.source`,
`eventVariant`, `metadata.subject`, and `rawPayload`; there is no separate `envelope`
field.

### 2. Classify

Group the batch by `metadata.source` (fall back to the second segment of `summary` when
a source does not set it) and load `sources/<source>.md` for that group. Each event
maps to exactly one intent:

| Intent | Meaning |
| :--- | :--- |
| `REVIEW_REQUEST` | Someone asks you to review a change |
| `FEEDBACK` | Someone reviewed or commented on your change |
| `ISSUE_UPDATE` | An issue you own or track changed |
| `LIFECYCLE` | The object was merged, closed, or cancelled |
| `NOISE` | Duplicate, status-only, or not actionable |

If a source policy is missing, report the source and ack only after inspection.

### 3. Dedupe

Read the state file the source policy names. Keys and fields are the source policy's;
the usual shape is:

```json
{
  "<subject>": {
    "head": "<revision>",
    "last_event_id": "<id>",
    "last_driven_at": "<timestamp>",
    "task_id": "<task-id>"
  }
}
```

Skip when the source policy says this revision or event id was already handled. The
intake cursor is not the task's state: a task finishing does not mean its event was
handled. Dedupe by the source's stable key, never by `entryId` alone.

### 4. Route

| Intent | Admission | Execution |
| :--- | :--- | :--- |
| `REVIEW_REQUEST` | create a research task and delegate it | dsx `review` |
| `FEEDBACK` | continue the matching task | the task's playbook |
| `ISSUE_UPDATE` | `ignore` (default) or queue without starting | none until claimed |
| `LIFECYCLE` | mark the matching task done | none |
| `NOISE` | no task | none |

#### REVIEW_REQUEST

Create the task with `--research --delegate`, and turn off the board's automatic
review for it (`--review.when never`). A review task changes nothing, so an automatic
review has nothing to review and only burns a reviewer round.

The brief must include: source, subject, URL, head revision, author, event variant,
entry id, dedupe key, the exact worktree command, and the path to the review playbook.
Build the evidence worktree from the target project, not from the board's own
worktree.

#### FEEDBACK

Find the task using the source policy's mapping, then:

| Task state | Action |
| :--- | :--- |
| `idle` | send the original text; the task starts and reports its own state |
| `working` | record the cursor only; do not interrupt |
| `blocked` / `question`, event answers it | send the original text |
| `blocked` / `question`, event does not answer it | report to the human |
| `blocked` / `permission` or `auth` | report to the human; never infer consent |
| `done` | do not reopen |
| `error` | report to the human; do not retry on your own |

Send original text, not a summary. An approval is a continuation signal, not a merge
authorization.

#### ISSUE_UPDATE

Policy comes from the source policy: `ignore` or `queue`. `ignore` (the default) means
inspect and ack, no task and no message. `queue` means add the task **without**
starting it; the human decides whether to claim it.

#### LIFECYCLE

Map the merged/closed object back to its task and mark the work finished:

```bash
$TASK_CLI report <id> --state done --msg "<what happened and when>"
```

The message must say whether it was merged or closed, so a close without merge is not
hidden.

#### NOISE

No task. Ack it with the batch.

### 5. Ack

```bash
agentinbox inbox ack --agent-id "$AGENT_ID" --through "$LAST_INSPECTED_ENTRY_ID"
```

### 6. Report

Report briefly:

- entries reviewed
- tasks created and started
- feedback messages sent, with task ids and source event ids
- lifecycle changes
- entries skipped as noise
- unmatched or ambiguous entries

## Rules

- Read at most 50 unacked entries per batch. Ack only `--through` the last entry you
  actually inspected. Never `--all`.
- Never modify project code, commit, push, approve, merge, close, or resolve from
  intake.
- Delegate and change task status only where the source policy explicitly authorizes
  it. Anything else needs a human.
- If a mapping is uncertain, report it; do not guess.
- Board commands are the ones the source policy names; do not invent a second backlog.

## Adding a source

Create `sources/<source>.md` and define:

1. event to intent table
2. dedupe keys and state file
3. task mapping (branch, title, URL)
4. command recipes
5. review brief and feedback templates
6. lifecycle mapping

The intake flow stays the same; only the source policy changes.
