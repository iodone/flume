---
name: workflow-event-intake
description: "Triggered by: A flume activation arrived for AgentInbox, event intake, inbox event. Agent-side dispatcher for flume activations: read the inbox, classify by metadata.source, dedupe, create or continue board tasks, then ack. Do NOT use for periodic full scans, task execution, or the review itself."
---

# Workflow Event Intake

This is the **agent-side** policy for a flume activation. flume verifies the webhook,
normalizes the event, writes the inbox, and wakes the agent. It does not execute this
file, and the activation does not carry the event body.

**Boundary.** This file decides *whether* an event becomes or continues a task. The
task's own playbook decides *how* it runs. A review task's brief points at the
project's review playbook — in this workspace `workflow-dsx/playbooks/review.md`,
which is a standalone playbook in dsx. Do not copy review axes, verification gates,
or code standards into this file.

> Template. Copy it into the agent workspace and write `sources/<source>.md` before
> use. Nothing here is a built-in default policy.

## Contract

- The activation carries `agentId`, `newEntryCount`, and optionally `intakeSkill`.
  It does **not** carry the event body.
- Always read the inbox before acting.
- An inbox entry carries `metadata.source`, `eventVariant`, `metadata.subject`, and
  `rawPayload`; there is no separate `envelope` field. `entryId` identifies the
  delivery, not the event.
- Source-specific mapping lives in `sources/<source>.md`.
- Board commands are the ones the source policy names; do not invent a second backlog.

## Hard rules

- Read at most 50 unacked entries per batch. Ack only `--through` the last entry you
  actually inspected. Never `--all`.
- Never modify project code, commit, push, approve, merge, close, or resolve from
  intake.
- Delegate and change task status only where the source policy explicitly authorizes
  it. Anything else needs a human.
- Send original text, not a summary.
- Dedupe by the source's stable key (review id, note id, revision, issue id), never
  by `entryId` alone: one source event can arrive as several deliveries.
- If a mapping is uncertain, report it; do not guess.

## 1. Read

```bash
agentinbox inbox read --agent-id "$AGENT_ID" --limit 50 --full
```

Record every `entryId` and the last one you actually inspect. That entry is the only
legal ack boundary.

## 2. Classify

Group the batch by `metadata.source` (fall back to the `summary` field's second
segment when a source does not set it) and load `sources/<source>.md` for that group.
The source policy returns one of these intents:

| Intent | Meaning |
| :--- | :--- |
| `REVIEW_REQUEST` | Someone asks you to review a change |
| `FEEDBACK` | Someone reviewed or commented on your change |
| `ISSUE_UPDATE` | An issue you own or track changed |
| `LIFECYCLE` | The object was merged, closed, or cancelled |
| `NOISE` | Duplicate, status-only, or not actionable |

If a source policy is missing, report the source and ack only after inspection.

## 3. Dedupe

Read the intake state file the source policy names. Keys and fields are the source
policy's; the usual shape is:

```json
{
  "<source>:<subject>": {
    "head": "<revision>",
    "last_event_id": "<id>",
    "last_driven_at": "<timestamp>",
    "task_id": "<task-id>"
  }
}
```

Skip when the source policy says this revision or event id was already handled. The
intake cursor is not the task's state: a task finishing does not mean its event was
handled.

## 4. Route

### REVIEW_REQUEST

Create a task in the configured board and start it:

```bash
$TASK_CLI add "Review <subject> <title>" \
  --repo "$TASK_REPO" --research --delegate \
  --review.when never \
  --desc "<brief>"
```

**Disable the board's post-work automatic review for this task.** A review task
changes nothing, so an automatic review has nothing to review and only burns a
reviewer round. herdr spells this `--review.when never`.

The brief must include: source, subject, URL, head revision, author, event variant,
entry id, dedupe key, the exact worktree command, and the path to the project's
review playbook. The worktree is built from the target project, not from the board's
own worktree.

### FEEDBACK

Find the existing task using the mapping in the source policy, then:

| Task state | Action |
| :--- | :--- |
| `idle` | `$TASK_CLI tell <id> "<original text>"` — the task starts and reports its own state |
| `working` | Record the cursor only; do not interrupt |
| `blocked` / `question`, event answers it | `tell` the original text |
| `blocked` / `question`, event does not answer it | Report to the human |
| `blocked` / `permission` or `auth` | Report to the human; never infer consent |
| `done` | Do not reopen |
| `error` | Report to the human; do not retry on your own |

An approval is a continuation signal, not a merge authorization.

### ISSUE_UPDATE

Policy comes from the source policy: `ignore` or `queue`. `ignore` (the default) means
inspect and ack, no task and no message. `queue` means `add` the task **without**
`--delegate`; the human decides whether to claim it.

### LIFECYCLE

Map the merged/closed object back to its task and mark the work finished:

```bash
$TASK_CLI report <id> --state done --msg "<what happened and when>"
```

The message must say whether it was merged or closed, so a close without merge is not
hidden. Do not approve, merge, or close anything yourself.

### NOISE

No action. Ack it with the batch.

## 5. Ack

```bash
agentinbox inbox ack --agent-id "$AGENT_ID" --through "$LAST_INSPECTED_ENTRY_ID"
```

## 6. Report

Report briefly:

- entries reviewed
- review tasks created and started
- feedback messages sent, with task ids and source event ids
- lifecycle changes
- entries skipped as noise
- unmatched or ambiguous entries

## Adding a source

Create `sources/<source>.md` and define:

1. event to intent table
2. dedupe keys and state file
3. task mapping (branch, title, URL)
4. command recipes
5. review brief and feedback templates
6. lifecycle mapping

The intake flow stays the same; only the source policy changes. The task execution
layer is separate and must not be duplicated here.
