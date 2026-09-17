# Bart final-reply reminder

The Harness Renderer `projectBartDock` contract returns `{ activity, reply }`, where `reply` is the last successful answer as `{ id, executionId, excerpt, target }` or `null`. The owning Harness projects a native assistant identity scoped by its Execution. Codex already retains native item identity. Claude carries an optional native message ID through its text segments and sums the segments that share it, so an answer interrupted by reasoning or tool activity is one reply. Pi keys the assistant message directly. A stale or foreign `target` resolves to nothing; the navigation still opens the Execution it was given.

Core does not inspect native timelines. It namespaces the opaque reply identity by Bart Thread and Harness, compacts only the excerpt, and hands the Bart Dock a reading key plus the `target` untouched. The reminder shows the *opening* of the answer: the Harness bounds the text first, and Core keeps the head whole so a truncated preview never starts mid-sentence. Failures and interventions keep their own channels; they are never advertised as a final reply.

## Reminder lifecycle

The reminder appears only while the answer is unread, the Session is idle, and the role is Bart's own idle shape. A new Execution hides it; a failed or cancelled one restores the same answer identity. Hidden windows and the app being backgrounded never consume a read.

The reminder is a static red badge with the numeral one and the answer's excerpt available only to assistive technology. Hovering Bart or the badge, or focusing the badge with the keyboard, does not expand a bubble or mark the answer as read. Activating the badge opens the Session at the answer. The badge has no preview timer or dedicated Worker surface; Bart's quick-action hover menu keeps its normal behavior.

Read state persists per Bart Thread, Harness and reply identity in local storage (`openagent.bart.reply-read`), so a restart does not remind again for an answer that was read. Entering the Session consumes the reminder, unless the window is hidden at that moment. A later successful answer is a new identity and reminds on its own, while a successful turn that produced no answer is not an answer of its own: it leaves an earlier unread reminder standing instead of hiding it.

## Locating the answer

Activating the badge opens the Session at the answer. Core carries the Harness's opaque `target` back into `HarnessRendererThreadInput.readingTarget.message`, and the Harness resolves it against its own timeline into a `ThreadDetailSurface.readingTarget` row. See [thread-document-reading](thread-document-reading.md) for the consume-once and degradation rules. When a Harness cannot supply a target, activation still opens the Session without navigating.

## Regression

```
pnpm --dir apps/desktop exec vitest run tests/bart-reply-lifecycle.dom.test.tsx tests/bart-reply-navigation.dom.test.tsx
```

`bart-reply-lifecycle` drives the real Store through the production Codex projection, covering hover/focus without consuming unread state, visibility changes, Session entry, read persistence, and new answer identities. `bart-reply-navigation` covers the three Harnesses' opaque targets, one-shot locating, and degradation. Native-event to public-projection coverage lives with each Harness: `packages/harness-*/tests/*-bart-presentation.test.ts`, and `*BartReplyAnchor` cases in the navigation suite.
