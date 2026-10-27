---
name: workflow-event-intake
description: "Triggered by: A flume activation arrived for AgentInbox, inbox event, event intake. Source-agnostic dispatcher: read AgentInbox, classify by envelope.source, route review requests / feedback / issue updates, ack. Do NOT use for periodic scans or task execution."
---

# Workflow Event Intake

This is the **agent-side** policy for a flume activation. flume only verifies,
normalizes, writes the inbox, and wakes the agent; it does not execute this file.
The coordinator reads it after wake.

> This file is a template. Copy it into the agent workspace and customize
> `sources/<source>.md` before use.

## Contract

- activation carries `agentId`, `newEntryCount`, and optionally `intakeSkill`.
  It does **not** carry the event body.
- Always read AgentInbox before acting.
- The event envelope is `{source, event, subject, payload}`.
- Source-specific mapping lives in `sources/<source>.md`.
- This skill decides **whether** an event becomes or continues a task.
  `workflow-dsx` decides **how** that task runs.

## Hard rules

- Read at most 50 unacked entries per batch.
- Never ack an entry you did not inspect. Use `ack --through <last inspected entryId>`.
- Never modify project code, commit, push, approve, merge, close, or resolve.
- Review requests may create a board task and delegate it immediately.
- Feedback and issue updates may call `herdr-projects tell <task>`.
- Send original text, not a summary.
- If a mapping is uncertain, report it; do not guess.

## 1. Read

```bash
agentinbox inbox read --agent-id "$AGENT_ID" --limit 50 --full
```

Record every `entryId` and the last one you actually inspect.

## 2. Classify

Group the batch by `envelope.source`. Load `sources/<source>.md` for that group.
The source adapter returns one of these intents:

| Intent | Meaning |
| :--- | :--- |
| `REVIEW_REQUEST` | Someone asks you to review a change |
| `FEEDBACK` | Someone reviewed or commented on your change |
| `ISSUE_UPDATE` | An issue you own or track changed |
| `LIFECYCLE` | The object was merged, closed, or cancelled |
| `NOISE` | Duplicate, status-only, or not actionable |

Do not hardcode source fields in this file. If a source adapter is missing, report
the source and ack only after inspection.

## 3. Dedupe

Read the configured intake state file (default `review/intake-state.json`).
The source adapter defines the keys. Example:

```json
{
  "gitlab:group/project!48": {
    "head_sha": "e6b2620",
    "last_note_id": 22794576,
    "last_driven_at": "2026-10-27T14:48:49+08:00",
    "task_id": "board/212"
  }
}
```

Skip when the source adapter says the same head or note was already handled.
Do not use the review result state as the intake cursor.

## 4. Route

### REVIEW_REQUEST

Create a task in the configured board and start it:

```bash
herdr-projects add "Review <subject> <title>" \
  --repo <board-repo> --research --delegate \
  --desc "<brief>"
```

The brief must include: source, subject, URL, head sha, author, event variant,
entry id, dedupe key, and `Use workflow-dsx playbook: review`.

### FEEDBACK

Find the existing task. The source adapter defines the mapping (for GitLab,
`source_branch` `work/<n>-...` maps to task `<KEY>-<n>`).

If the task is idle (not `working`, `reviewing`, `approval`, `done`, or archived):

```bash
herdr-projects tell <task> "<original text>

<source URL>
Please continue <task> from the original text; do not rewrite it into a conclusion."
```

Update `last_note_id` and `last_driven_at` after sending.

### ISSUE_UPDATE

Find a task whose description contains the issue URL. If found and idle, send the
original update. If a new issue has no task, add it to the queue **without**
`--delegate`; do not auto-start it.

### LIFECYCLE

Update or close the matching task. Do not merge or approve anything.

### NOISE

No action. Ack it with the batch.

## 5. Ack

```bash
agentinbox inbox ack --agent-id "$AGENT_ID" --through "$LAST_INSPECTED_ENTRY_ID"
```

## 6. Report

Report briefly:

- entries reviewed
- review tasks added and started
- feedback messages sent, with task ids and note ids
- issue tasks or messages
- lifecycle changes
- entries skipped as noise
- unmatched or ambiguous entries

## Adding a source

Create `sources/<source>.md` and define:

1. event to intent table
2. dedupe keys
3. task mapping
4. command recipes
5. task brief and feedback templates

No change to this file is needed. `workflow-dsx` also stays unchanged.
