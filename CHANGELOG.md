# Changelog

## v2.0.1

Added bulk date editing, at a glance per-date indicators for one's own status.

## v2.0.0

A major release — availability confirmation workflow, richer Discord integration, and a round of scheduling/numbering fixes. Includes several DB migrations; back up your database before upgrading.

### Added
- **Per-block availability confirmation.** Players explicitly confirm their availability for a scheduling block, separate from their actual Yes/No/Maybe responses. Editing your availability silently un-confirms so a confirmation can never go stale.
- **One-tap Discord confirm links.** Advance/final reminders are now sent per-person, each with their own day-by-day availability grid and a one-tap confirm link. Requires the confirming session to match the link's identity — no confirming on someone else's behalf via a forwarded link.
- **DM/root confirmation override.** Confirm or unconfirm on another member's behalf (e.g. they confirmed out-of-band), from the Schedule tab or a day's detail view.
- **Confirm-ahead window.** New `confirm_ahead_sessions` setting lets players confirm several upcoming blocks at once instead of only the immediate next one.
- **Lock-warning reminder.** A third, independent reminder that pings the DM if no session has been locked in yet as the block's start approaches. All reminder types (advance, final, lock-warning, day-of) are independently enabled/disabled per campaign.
- **Per-member scoring exclusion.** DM/root can exclude a specific member's availability from all scoring calculations (score sum, DM veto, minimum-player headcount) without removing them from the campaign.
- **Minimum players required.** New per-campaign setting — dates under the threshold score 0, same mechanism as a DM veto.
- **Calendar score heatmap.** Open candidate dates are now shaded by score intensity (relative to a fixed theoretical maximum) so the best options are visually obvious.
- **Dark mode.** Manual toggle, defaults to system preference, remembered per-device.
- **Discord display names.** The web UI now shows each member's Discord display name (refreshed on login) instead of their raw account handle.
- **Audit log.** Every mutating action (session lifecycle, invites, membership changes, availability edits, confirmations, reminders sent) is now recorded to a database table, viewable at Core Settings → Audit Log (root-only). Durable across container restarts and log rotation.
- A "Today" button on the calendar.

### Changed
- **Session numbering is now fully automatic**, derived purely from chronological date order among scheduled/completed sessions — no more manually specifying a session number when backfilling, and no more stale/orphaned numbers after cancellations. Backfilling, cancelling, and rescheduling all renumber the sequence as needed.
- **Discord announcements rebuilt as rich embeds** (session locked/rescheduled/cancelled/skipped) instead of plain code-block text, with calendar-add links and countdowns. Day-of and reminder messages now use real `@mentions` for highlighting instead of plain usernames.
- The Sessions tab now only lists sessions that happened or are upcoming — cancelled/skipped entries no longer clutter the list.
- "Best open date(s)" now scopes to the nearest actual open scheduling block instead of the entire generated candidate window, and lists every date tied for the top score rather than just the soonest one.

### Fixed
- Invite links now correctly redirect to the campaign after Discord OAuth instead of the root page.
- A mobile layout bug (unbounded CSS grid tracks) that could clip a whole calendar column and, in the worst case, inflate the page wider than the viewport.
- `100vw`-based width constraints replaced with `100%` — `100vw` can measure wider than the true visible viewport on mobile, which was silently eating right-side padding.
- Dark mode's primary button was unreadable (white-on-white) due to reusing a text-color variable that intentionally inverts between themes.
- Testing the day-of reminder with no session selected now gives a specific, actionable error instead of a generic "Test failed."
- Read-only availability indicators (viewing another member's response) now show a visible status label, not just a hover-only tooltip.

### Removed
- SMTP/email invite delivery. Invites are always shared as links now.
