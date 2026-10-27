---
name: workflow-event-intake
description: "Triggered by: a flume activation arrived for AgentInbox, inbox event, event intake. Source-agnostic dispatcher: read the inbox, classify by envelope.source, dedupe, route to the task system, ack. Do NOT use for periodic scans or task execution."
---

# Workflow Event Intake

This is the **agent-side** policy for a flume activation. flume verifies the
webhook, normalizes the event, writes the inbox, and wakes the agent. It does not
execute this file and it does not carry the event body.

> This file is a template. Copy it into the agent workspace and configure
> `sources/<source>.md` before use. Nothing here is a built-in default policy.

## Contract

- activation carries `agentId`, `newEntryCount`, and optionally `intakeSkill`.
  It does **not** carry the event body.
- Always read the inbox before acting.
- The event envelope is `{source, event, subject, payload}`.
- Source-specific mapping lives in `sources/<source>.md`.
- This skill decides **whether** an event becomes or continues a task.
  The task's own execution playbook decides **how** that task runs.

## Hard rules

- Read at most 50 unacked entries per batch.
- Never ack an entry you did not inspect. Ack only through the last inspected entry.
- Never modify project code, commit, push, approve, merge, close, or resolve.
- Use the task system configured for this deployment; do not invent a second backlog.
- Send original text, not a summary.
- If a mapping is uncertain, report it; do not guess.

## 1. Read

```bash
agentinbox inbox read --agent-id "$AGENT_ID" --limit 50 --full
```

Record every `entryId` and the last one you actually inspect. `entryId` identifies
a delivery, not an event: the same source event can appear as multiple entries.
Dedupe by the source's stable key (review id, comment id, revision, issue id),
never by `entryId` alone.

## 2. Classify

Group the batch by `envelope.source`. Load `sources/<source>.md` for that group.
The source policy returns one of these intents:

| Intent | Meaning |
| :--- | :--- |
| `REVIEW_REQUEST` | Someone asks you to review a change |
| `FEEDBACK` | Someone reviewed or commented on your change |
| `ISSUE_UPDATE` | An issue you own or track changed |
| `LIFECYCLE` | The object was merged, closed, or cancelled |
| `NOISE` | Duplicate, status-only, or not actionable |

Do not hardcode source fields in this file. If a source policy is missing, report
the source and ack only after inspection.

## 3. Dedupe

Read the configured intake state file. The source policy defines its path and
keys. Example shape:

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

Skip when the source policy says the same revision or event id was already
handled. Do not use the task result state as the intake cursor.

## 4. Route

### REVIEW_REQUEST

Create a task in the configured task system and start it:

```bash
<task-cli> add "Review <subject> <title>" \
  --repo <task-repo> --delegate \
  --desc "<brief>"
```

The brief must include: source, subject, URL, head revision, author, event
variant, entry id, dedupe key, and the instruction to use the project's review
playbook.

### FEEDBACK

Find the existing task using the mapping in the source policy. If the task is
idle, send the original text:

```bash
<task-cli> tell <task-id> "<original text>

<source URL>
Continue <task-id> from the original text; do not rewrite it into a conclusion."
```

Update the source policy's last-event cursor after sending.

### ISSUE_UPDATE

Find a task whose description contains the issue URL. If found and idle, send the
original update. If a new issue has no task, add it to the queue **without**
starting it; do not auto-start new issue work.

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
- review tasks created and started
- feedback messages sent, with task ids and source event ids
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

The intake flow stays the same; only the source policy changes. The task
execution layer is separate and should not be duplicated here.
