# Ghazzy's Video Pipeline (webapp) — notes for future Claude sessions

No README, no package.json, nothing to build — this is intentional, not neglect.
`git log --diff-filter=A --name-only` across the whole history shows exactly one
file has ever been added to this repo: `index.html`. It's a single static HTML
file (~2800 lines: inline `<style>`, inline `<script type="module">`, no bundler,
no build step) that talks directly to a shared Firestore project. Open it in a
browser and it works — that's the whole deployment story as far as this repo's
own history knows; how/where it's actually served (GitHub Pages settings,
some other static host) isn't recorded in this repo, so don't assume without
checking with the user first.

**What it actually is**: a Trello-style board for a two-person YouTube
production pipeline (an editor — the account this file's author signs in as —
and Ghazzy, the streamer). Folders (one per game/project, one pinned "Main")
each hold a two-column board (Recorded → Finished) of video-clip cards written
by a separate local Windows app running on Ghazzy's streaming PC (that's
`../ghazzy-video-pipeline`). On top of the board: a global "To-Do Videos" idea
list, a global "Shorts" list, a live-status strip (is the streaming PC online,
is OBS recording, is a clip currently open), a Config panel that edits knobs
the streaming-PC app reads back out of Firestore, and a read-only "Rerun
Status" panel mirroring a *third*, unrelated PC (`../ghazzytv-24-7-stream-tool`,
a 24/7 rerun/raid-bot channel). This file only ever reads two of those three
systems' Firestore docs and writes config/board state back — it has no code
of its own for OBS, Drive sync, or disk cleanup; all of that lives in the
sibling repos and this file just displays/edits what they report.

## The embedded Firebase `apiKey` is not a leaked secret — don't flag it

`firebaseConfig` (in the `<script type="module">` near the top, `apiKey:
'AIzaSyCHy...'`) is meant to be public — Firebase web config identifies which
project to talk to, it isn't a credential. The actual gate is Firestore
Security Rules, enforced server-side, defined in the **sibling** repo
`../ghazzy-video-pipeline/webapp/SETUP.md` ("Access model"): a request needs
both a real signed-in identity (`request.auth != null`) *and* a matching
document in Firestore's `allowlist` collection (keyed by email) before any
read/write succeeds. A signed-in-but-not-allowlisted Google account gets
Firestore's generic `Missing or insufficient permissions` error, which
`onError()` (around line 756) specifically pattern-matches on to show a "not
approved, ask the editor" screen instead of a cryptic error banner behind a
board that'll never load (`showNotApproved()`).

**Stale comment gotcha**: the code comment right above `firebaseConfig` still
says the rules "require signed-in, **even anonymously**" — that's leftover
prose from the original `signInAnonymously()` implementation (commit
`41f42ca`) and was never updated when anonymous auth was replaced by real
Google Sign-In + the allowlist gate (commit `7efdb41`, "Replace anonymous
sign-in with Google Sign-In + Firestore allowlist gate"). Trust the allowlist
description above (and `SETUP.md` in the sibling repo) over that comment if
they ever seem to disagree — the allowlist collection itself and the actual
`.rules` file are not in this repo at all, so this file has no way to verify
who's on it; it only reacts to the permission-denied error Firestore hands
back.

## One Firestore collection, four kinds of row

`pipeline` holds clips, to-do ideas, Shorts, *and* sub-videos, all in the same
collection, distinguished purely by fields — there's no separate
`ideas`/`shorts` collection to keep in sync:
- `status: 'Idea'` → shown only in the global To-Do Videos panel (`rowsForFolder`
  explicitly excludes these from every folder's board).
- `status: 'Shorts'` → shown only in the global Shorts panel, reuses `renderCard`
  as-is (Shorts just happens to have no `NEXT_STATUS`/`PREV_STATUS` entries, so
  those controls silently don't render).
- `status: 'Recorded' | 'Finished' | 'Recording' | 'Archived'` → real board cards,
  scoped to whichever `folder` id they carry (a missing/empty `folder` field is
  legacy data or a not-yet-categorized Drive find, and is treated as living in
  whichever folder currently has `isMain: true` — see the comment on
  `rowsForFolder`, and this matches the streaming-PC app's own `driveSync.js`
  convention, not just a display quirk).
- `parentId` set on any row → a sub-video, one level deep only. It's excluded
  from every top-level list (`rowsForFolder` filters on `if (r.parentId) return
  false`) and rendered nested under its parent via `childrenOf()` instead.
  `setupSubVideoDrag`'s `onUp` handler explicitly refuses to attach a row that
  already has its own children — one level deep is enforced there, not by
  schema.

Delete is soft: `pendingDelete: true` is set, the row disappears from `boot()`'s
`onSnapshot` filter immediately client-side, and the real Drive-file trashing
happens later on the streaming-PC app's own side. Don't "fix" this into a real
`deleteDoc` for pipeline rows — the two-sided delete is deliberate so the UI
never has to wait on a Drive API round-trip.

## "24/7 Stream" panel (renamed 2026-09-15, was "Rerun Status")

Same `#rerunPanel`/`renderRerunPanel()` this file already had - just
renamed the nav button and heading to "24/7 Stream" to match how the
sibling project (`../ghazzytv-24-7-stream-tool`) and its own user actually
refer to it, and added one new element: an inline Twitch-purple link
(`.btn-twitch-inline`, a non-header-positioned twin of `.btn-twitch`)
straight to the rerun channel's own Twitch page, pulsing red via `is-live`
when `rerunStatus.isStreaming` is true - same visual language as the main
channel's header button, so "is the rerun channel live" reads the same way
across both panels. Needs `rerunStatus.rerunChannelLogin` (added to that
project's `rerunStatusStore.js` publish payload the same day) - on an
older/stale `system/rerunStatus` doc that field is just absent and the
link silently doesn't render, same graceful-degradation pattern as every
other optional field on this panel.

Still deliberately read-only, unchanged - no button here writes back to
Firestore. If real remote controls (force-resume the loop, skip the next
raid) are ever wanted, that's a new write-path + Firestore rule + the
orchestrator polling for a command doc, not something to bolt on quietly -
flagged as an open option in the sibling repo's `PLAN.md` §5, not built.

## Two independent PCs' status, two independent staleness windows

`system/liveStatus` (main streaming PC, `../ghazzy-video-pipeline`) and
`system/rerunStatus` (rerun-channel PC, `../ghazzytv-24-7-stream-tool`) are
separate docs from separate physical machines, each just mirrored read-only —
`#rerunPanel` has no remote controls at all, on purpose (see the comment above
`#rerunPanel`'s CSS: "just a status view, since that's all this was actually
asked for"). Both use the same "hide the nav entry until it's reported in at
least once" convention (`rerunNavBtn.style.display` toggles off `system/
rerunStatus` not existing) so a panel for a PC that's never been deployed
doesn't show up as a permanently-broken button.

**The 180s/90s thresholds are not arbitrary and not interchangeable** — each is
tuned to its own PC's heartbeat interval with headroom, and copying one value
onto the other panel would reintroduce a real, previously-shipped bug:
- Main live-status banner: heartbeat every 60s → offline threshold 180s (3x).
  This used to be 45s and flickered "offline" every single cycle because 45s
  is *shorter* than a 60s heartbeat — fixed in commit `fcb7230`. If the
  streaming-PC app's heartbeat interval ever changes, this 180s has to move
  with it, not stay fixed.
- Rerun panel: heartbeat every 30s (`STATUS_HEARTBEAT_SECONDS` in that
  project's `.env`) → offline threshold 90s (same 3x convention, smaller
  because the source heartbeat is smaller).

Both panels also re-render on a local `setInterval(..., 1000)` independent of
Firestore, purely so elapsed-time/countdown text (clip-open duration, Shorts
countdown, rerun countdown) ticks smoothly between real updates — that tick
reads already-subscribed local state, it never touches Firestore, so don't
"optimize" it into a shared debounce with the real listeners.

## Sub-video attach is a separate native pointer-drag, not a second SortableJS

`setupSubVideoDrag()` (grabbing a card's dedicated `.card-attach-handle`, top-
right corner) implements its own `pointerdown`/`pointermove`/`pointerup` drag
with a floating ghost chip — it deliberately does **not** reuse SortableJS,
even though ordinary card reordering (drag anywhere else on the card) already
uses SortableJS for exactly the same columns. This was tried multiple times
and repeatedly broke ordinary reordering:
- A per-card nested `Sortable` competing with the column's own drag/drop for
  the same hover events (broke reordering outright — fixed by removing it in
  `062c2fa`).
- `onMove` checking `evt.to` (the column container, constant throughout a
  drag) instead of `evt.related` (the actual hovered sibling) — attach never
  armed at all (`cee6fbf`).
- Final shape (`8282461` onward): the attach handle starts a plain native
  pointer drag that never registers with SortableJS, so the column's Sortable
  instance is completely undisturbed during an attach-drag, and ordinary
  card dragging is unaffected by anything attach-related.

If sub-video attach ever needs rework, keep it isolated from `cardSortable` —
don't fold it back into a nested/second Sortable instance, that's the specific
approach already proven unreliable here. `DROP_DWELL_MS` is 40ms (practically
instant) rather than the ~600ms it started at, because starting this drag at
all already requires deliberately grabbing the dedicated handle — there's
nothing accidental left to guard against once that's true.

## Do Fast pinning uses two independent order counters, not one

When a column's on-screen order is persisted (`cardSortable`'s `onEnd`), cards
are split into `do-fast` and everything-else, each getting its own 0-based
`order` counter (`fastIdx`/`restIdx`). This is why a card dragged to visually
sit "above" a Do Fast card doesn't unpin anything — it only ever records its
position within its own group. The sort in `renderFolderBody` (`if (a.doFast
!== b.doFast) return a.doFast ? -1 : 1;` before the `order` comparison) is
what actually keeps Do Fast on top regardless of stored `order` values. The
same two-tier pattern is reused for To-Do Videos (`doFastTodos`/`otherTodos`
in `renderTodoPanel`). Recording-status cards get a third tier above even Do
Fast (see the sort comment in `renderFolderBody`) since "happening right now"
outranks priority — don't merge these into a single sort key without
re-deriving all three tiers' precedence.

Reordering only ever persists for the fully-rendered list: a collapsed
"Finished" column only shows `FINISHED_COLLAPSED_COUNT` (3) cards, so
`onEnd` checks `evt.to.dataset.fullList === 'true'` and, if false, calls
`renderFolders()` to snap the drag back to canonical order instead of
persisting a reorder computed from a partial on-screen list.

## Advanced Config panel and the GitHub PAT note

The `<details class="advanced-config">` block in the Config panel deliberately
mixes two unrelated things: real dangerous controls (disk-cleanup on/off,
dry-run off, Drive-root-folder migration) and a plain-text, non-interactive
note near the bottom naming a GitHub PAT (`ghazzy-streaming-rig-readonly`,
read-only, used for `git clone`/`git pull` of a "clip-tool" repo onto Ghazzy's
separate physical streaming rig) with its expiry date (Jul 7 2027). This is
not a leaked credential — no token value is present, only its name, purpose,
and expiry — and it's there on purpose (commit `9c196b0`): so that if clip-tool
auth on the streaming rig starts failing around that date, there's an obvious
explanation on hand instead of a mystery. Don't remove this note as "stray
scope creep in a video-pipeline board" — it's a deliberately-placed reminder,
not documentation drift. If the token is ever rotated or actually expires,
update the date/name here rather than deleting the note.

Every other Advanced Config field follows the same "explicit Save + confirm"
pattern as the main Config panel (see below) — nothing here saves on blur.

## Config panel: every save requires an explicit click + confirm, not just the dangerous ones

`renderConfig()`'s Save button only appears once a field's value actually
differs from what's loaded (commit `4fe64e6` replaced auto-save-on-blur with
this for exactly this reason: tabbing through fields or clicking the info tag
next to a field shouldn't be able to silently commit a value nobody meant to
finalize). `DISK_CLEANUP_DRY_RUN` turning `false` and `DISK_CLEANUP_ENABLED`
turning `false` get their own specific, scarier confirm text (real files start
getting permanently deleted; the drive stops being watched at all,
respectively) — every other key still gets a confirm, just a generic one. If
adding a new config key, don't skip the confirm dialog even for something that
looks harmless; the pattern here is "always confirm," not "confirm only the
scary ones."

`CONFIG_KEYS` / `ADVANCED_CONFIG_KEYS` / `SHORTS_CONFIG_KEYS` are three
separate arrays feeding the same `renderConfig()`/`CONFIG_DESCRIPTIONS` — a
key's presence in `ADVANCED_CONFIG_KEYS` (currently just the two disk-cleanup
booleans) is what puts it behind the Advanced `<details>` instead of the main
panel; there's no other flag or convention marking a key as dangerous.

## Cross-repo relationship — this repo has zero visibility into the other two

This repo cannot see `../ghazzy-video-pipeline` or
`../ghazzytv-24-7-stream-tool`'s code at all; every comment in `index.html`
that references "the streaming-PC app," "`driveSync.js`," "`clipState.js`,"
`STATUS_HEARTBEAT_SECONDS`, or `webapp/SETUP.md` is pointing at files that
physically live in those sibling repos on disk, not anywhere in this one.
When a comment's claim about *why* the other side behaves a certain way needs
verifying, go read it there — don't guess from this file alone. Rough division
of responsibility, as far as this file's own comments describe it:
- `../ghazzy-video-pipeline`: the actual streaming-PC app — writes `pipeline`/
  `folders` docs, `system/liveStatus`, `system/diskCleanupStatus`,
  `system/appLog`; reads `config/settings` (the knobs this Config panel
  writes) and reacts to `liveStatus.forceCloseRequestedAt` /
  `liveStatus.diskCleanupCheckRequestedAt` commands this file sets. Also owns
  the Firestore Security Rules / `allowlist` collection referenced above.
- `../ghazzytv-24-7-stream-tool`: the rerun-channel PC — writes
  `system/rerunStatus` only. This file only ever reads it; nothing here
  writes back (there's no rerun equivalent of the Force-Close/Check-Now
  buttons, deliberately).
