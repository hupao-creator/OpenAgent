# Settings automatic save

Settings changes use the existing Main-owned `updateAppSettings` command. The
Renderer owns only editing, submission timing and feedback; persistence, native
appearance and Harness lifecycle remain with their existing owners.

- Choices submit immediately. Text waits 500 ms after editing, or submits on blur
  and when closing the page. IME composition is never submitted mid-composition.
- One request runs at a time, with subsequent edits coalesced into the latest
  snapshot. A response cannot replace newer input. Ordinary saves keep the page
  open and allow continued editing.
- Empty custom routing guidance stays visible with validation feedback and does
  not replace the latest valid guidance. Other valid preferences can still save.
  Main/plugin validation and persistence failures retain the draft and offer retry.
- Back, Close and Escape flush completed text and wait for pending saves before
  closing. Validation or persistence failure keeps the page open for correction.
- History deletion remains an explicit, separately confirmed action.

Behavioral coverage lives in `settings-dialog-plugin-validation.dom.test.tsx`
and `settings-autosave.dom.test.tsx`; the native appearance regression exercises
UI application, reopening and cold-start persistence.
