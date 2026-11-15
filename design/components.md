# Golem components

The look is Ember: black, white, and one accent, square corners, pixel icons, and a 1 pt dither. Every value lives in
`tokens.json`; layouts and motion are measured from Linear's light and dark themes (Inter 4.1, the same font file).
`accent` is the only color of Golem; `gold` takes its value and marks steps and what waits for a person. Golem's logo
is a badge whose right half is its shadow.
Every component exists on the web (`public/styles.css`, `web/ui/`) and looks like Linear's web app. Native selects and
pickers are never used; menus, selects, switches, and checkboxes are our own.

## Type and color

- Inter Variable for body text, Geist Mono for times, counts, and values (Markdown bold inside an agent's reply is
  Inter `semibold`, `text`), Geist Mono `fontSize.label` in capitals for section labels. All three are in the
  repository (`public/fonts/`): the app's content policy loads
  fonts only from Golem. Inter line height `normal` for controls, `font-display: block`. Pages link styles and scripts with a hash
  of their content, and the server keeps them and the font in the browser for good, so text never paints in a
  fallback font first.
- Text: `text` for titles and values, `textSecondary` for controls and body, `textTertiary` for descriptions,
  inactive navigation, and meta, `textQuaternary` for placeholders and times.
- Weights: `book` (450) for body and menus, `medium` (500) for labels, navigation, and buttons, `strong` (550) for
  the workspace name, `regular` (400) for field and select values.
- Icons: the 16 × 16 pixel set in `icon` of `tokens.json`, lines 1 pt wide (16 pt): `bun run tokens` writes
  `web/ui/pixels.ts`. A new icon is drawn there on the same grid. A section's chevron is 8 pt, 1 pt a pixel.
- Dither: 0.5 pt cells, an 8 × 8 Bayer threshold, on or off (`web/ui/dither.ts`). Used only for the right edge of a
  selected row (48 pt wide, `accent`; its label stops 36 pt before the end) and the corner of an avatar tile. Never
  over text or a transcript. Each cell is a whole number of device pixels.
- Dark theme: Linear lifts each layer, so roles that share one light color split in dark. Cards, fields, buttons,
  and dialogs use `surfaceRaised`; a select trigger on a card `surfaceControl`; action menus, tooltips, and toasts
  `surfaceMenu`; select menus `surfaceListbox`; the composer `surfaceComposer`. Controls take `ringControl`, cards
  `ring`. `ghostHover` is translucent, so a ghost button fits every surface. Shadows have their own dark layers.

## Motion

- Hover states start at once and fade out in `duration.fast` (150 ms, `ease`): every transition has a zero duration
  while hovered or pressed. Hover styles apply only to fine pointers.
- Menus, selects, and dialogs open and close at once.
- Tooltips spring: opacity reaches 1 in 40 ms while the scale goes from 0.98 to 1 in 48 ms; on close the scale goes
  back in 33 ms and the opacity fades in 180 ms after a 27 ms hold. CSS `linear()` curves trace Linear's spring.
- Toasts slide up from their own height and fade in `duration.toast` (400 ms, `ease`), and leave the same way.
- Reduced motion: no transitions or animations.

## Buttons

| Variant | Look | Hover |
| --- | --- | --- |
| secondary | `surfaceRaised`, `textSecondary`, a 0.5 px `ringControl` and shadow `low` | `surfaceHover`, `ringHover` |
| primary | `text`, `surface`, shadow `low` | `textSecondary` |
| send | `accent`, `onAccent` | `accentHover` |
| ghost | transparent, `textTertiary` | `ghostHover`; `text` |
| danger | ghost with `danger` text | `dangerSubtle` |

- All are square: 32 high, 12 px side padding, `fontSize.md` `medium`. A leading 16 px pixel icon takes the
  left padding to 10 px and sits 6 px from the label.
- `small`: 28 high, 10 px padding (8 px before an icon), `fontSize.sm`. `large`: 40 high, full width.
- Icon buttons are squares: 28 (`icon`) or 24 (`tiny`), with a 16 px pixel icon.
- Pressed (`aria-pressed`) and open (`aria-expanded`) ghost buttons keep the hover look. Disabled: 60 % opacity.
- Busy: while a message sends or files upload, the send or upload button shows a 14 px spinner in place of its icon
  and takes no clicks.
- Focus: 1 px `accent` outline, offset 2 px. The cursor stays the arrow, as in Linear.

## Text field

- 32 high, padding 6 × 12, `radius.md`, `surfaceRaised`, 0.5 px `borderStrong`, `fontSize.md` `regular` `text`.
  Hover: `borderHover`. Focus: 1 px `accent` outline at offset −1 px.
- Placeholder `textQuaternary`. Large (sign-in, search): 40 high, `fontSize.lg`.
- Label above: `fontSize.md` `medium` `textSecondary` on a 24 px line, 4 px gap. Errors use a toast.
- In a settings row a field is 180 wide.

## Select

- Trigger: 30 high with 1 px margins, `radius.md`, padding 1 × 28 × 1 × 10, `surfaceControl`, `ringControl` and
  shadow `low`, value `fontSize.md` `regular` `textSecondary`, a 16 px chevron 7 px from the right. Hover:
  `surfaceControlHover`, `ringHover`.
- The menu opens over the trigger with the selected option centered on it and its text on the value, as macOS menus
  do; at least as wide as the trigger. It moves only to stay 8 px inside the window.
- Menu: `surfaceListbox`, 4 px vertical padding, a 0.5 px `ringListbox` ring and shadow `menu`, `radius.xl`.
  Options: 32 high, padding 0 × 35 × 0 × 12, `regular`; the highlight is inset 4 px, `radius.md`, `listboxHover`. The selected option
  shows a 16 px check 12 px from the right.
- Keyboard: Enter, Space, or ↓ opens; ↑ ↓ Home End move; Enter selects; Escape closes; typing jumps to a match.
- Selecting closes the menu and updates the value. `autosubmit` submits the surrounding form at once.

## Menu

Used by the workspace switcher and action menus.

- `surfaceMenu`, 0.5 px `borderMenu` border, `radius.xl`, shadow `menu`, 6 px vertical padding, min width
  `size.menuMinWidth`. Opens 4 px below its trigger, start- or end-aligned, or above when there is no room.
- Item: 32 high, padding 0 × 18 × 0 × 14, `fontSize.md` `book` `textSecondary`, a 16 px icon 8 px before the label
  in the same color. The highlight is inset 6 px, `radius.md`, `menuHover`, and turns the text `text`.
- A click highlights nothing until the pointer moves; the keyboard highlights the first item.
- A current item shows a 16 px check at the right. Shortcuts are plain text: `fontSize.xs` `medium` `textTertiary`.
- Separator: 0.5 px `borderSubtle` with 6 px above and below. Section label: `fontSize.sm` `medium` `textTertiary`,
  28 high.

## Switch

- Track 30 × 20, `radius.full`. Off: `switchTrack`, hover `switchTrackHover`. On: `accent`, hover `accentHover`. The
  color changes in 150 ms ease-out.
- Knob 14, `onAccent`, 3 px from the edges; it travels 10 px. Its leading and trailing edges move in 100 ms
  ease-out, the trailing edge 50 ms later, so it stretches on the way. Under the pointer it widens 2 px toward the
  middle.
- The touch target is 42 × 32. `autosubmit` submits the form on change.

## Checkbox

- 14 square, `radius.xxs`, 1 px `borderControl`, transparent; hover turns the border `accentHover`.
- Checked: `accent` fill and border, a white 10 × 9 check. Colors change in 80 ms ease-out.
- Label to the right, `fontSize.md` `textSecondary`, 8 px gap; the whole row toggles.

## Tooltip

- Shows 450 ms after the pointer or keyboard focus arrives and hides when it leaves. Within 300 ms of one closing,
  the next shows at once and the old one goes at once.
- Padding 5 × 8, `radius.md`, `surfaceMenu`, 0.5 px `borderMenu`, shadow `low`. Text `fontSize.xs` `book`
  `textSecondary` on a 16.5 px line; an optional keycap 8 px after it.
- Placed 8 px below the target, centered, or above when there is no room. Motion as above.

## Dialog

- `overlay` backdrop. Card `surfaceRaised`, 0.5 px `borderDialog`, `radius.xl`, shadow `modal`, width
  min(`size.dialog`, 100 % − 32), centered over the panel.
- Header: padding 16 × 48 × 16 × 16, title `fontSize.lg` `book` on a 23 px line, a ghost close icon button 16 px from
  the right. Body: padding 12 × 16, fields 12 px apart. Footer: padding 16 × 16 × 12, buttons right-aligned 8 px
  apart, secondary then primary. Escape and the backdrop close it.

## Toast

- Bottom right, 24 px from the window edges. Width `size.toast`, padding 12, `radius.xl`,
  `surfaceMenu`, a 0.5 px `ringControl` and shadow `menu`.
- A 16 px icon (info in `textSecondary`, success in `success`, error in `danger`), the text in `fontSize.md`
  `medium` `text`, and a 12 px close mark in `textTertiary` (hover `text`).
- Goes after 4 s or on a click; the pointer on it keeps it.

## Sidebar

- 244 wide on the canvas, 12 px side padding. It starts with Golem, with no workspace name above it. Golem's icon is
  its face in one color (`golem`): the logo with its marks cut out, 16 cells across, 1 px a cell.
- Item: 28 high, 1 px apart, padding 0 × 9 × 0 × 8, `radius.md`, a 14 px icon 6 px before the label,
  `fontSize.md` `medium` `textTertiary`. Hover: `fillHover` at once and `text` in 150 ms. Current: `fillActive`, `text`.
  Count: `fontSize.xs` `book`. A channel with an emoji shows it in place of the `#` icon, `fontSize.sm`, centered in
  the 14 px slot.
- Private channels are in their own group, Private, after Channels, each with a 14 px lock after its name in
  `textTertiary`. The group shows only when the person has a private channel.
- Groups are 16 px apart. Section header: 28 high, the label 9 px in, `fontSize.sm` `medium` `textTertiary`; its action
  button shows on hover or focus (always on touch screens).
- Threads sit under their channel, indented 19 px with 6 px inner padding; each shows its settle button on hover or
  focus (always on touch screens). A channel with active threads has a disclosure arrow at its right, which shows on
  hover or focus (always on touch screens, and while folded) and turns 90° in 150 ms when open; it unfolds the channel's
  threads, and the device remembers it. Channels start folded; the channel of the open thread stays open and has no arrow. Settled threads leave the active lists and appear in a collapsed Settled shelf at
  the bottom, newest settlement first; its disclosure arrow turns 90° in 150 ms. A settled thread remains readable
  and can receive messages.

## Panel and header

- The panel sits 8 px from the window, `surface`, 0.5 px `border`, `radius.xl`, shadow `low`.
- Header: 44 high including its 0.5 px `border` bottom line, padding 0 × 8 × 0 × 18, title `fontSize.md` `medium`
  `textSecondary`, the parents of a breadcrumb in `textTertiary`. Actions are ghost icon buttons.

## Tabs

- Tabs 28 high, square, padding 0 × 10, `fontSize.sm` `medium`, 8 px apart. Unselected: `surfaceRaised`, `ringControl`, shadow
  `low`, `textTertiary`; hover `ghostHover` and `ringHover`. Selected: `fillSelected`, `ringControl` without
  shadow, `text`.

## Settings page

- A 640 px column, 64 px from the top of the panel, 40 px side margins. Page title `fontSize.xxl` `medium`, 32 px line,
  −0.16 px letter spacing, 32 px above the first section. Sections are 48 px apart; section title `fontSize.lg`
  `medium` on a 23 px line, 16 px above its card. Titles and text sit 16 px in, level with the row text.
- Card: `surfaceRaised`, `radius.lg`, a 0.5 px `ring` and shadow `low`. Rows are separated by 0.5 px `ring` lines
  inset 16 px.
- Row: min 60 high, padding 16, 12 px gaps, label `fontSize.md` `medium` `text`, description `fontSize.sm` `book`
  `textTertiary` 3 px below, control at the right. Compact rows (lists of people, runs) are min 44 high with
  8 px vertical padding.
- A leading icon sits in a 32 px `fillIcon` square with `radius.sm`; a leading avatar is 24 px.
- An integration is one card. Its first row has the name and the count of accounts, and at the right its actions as
  small buttons: Client (for the server's owner, when it has one), then the way to connect (Connect, Link number, or
  Add credential), then the info button of its guide. Each credential is a compact row under it. On a narrow page the
  buttons wrap under the name. Under each of the person's own credentials of an integration that Golem can read for
  them, a compact row with the `check` icon, "Read for me", and its switch.
- Places: a compact row per place with its name and its radius and Shared or Private, then the Private switch and the
  change and remove icon buttons. Add place opens a dialog: the Name field; the Address field, where Enter or Return
  moves the map to the address (it asks OpenStreetMap's search through Golem); a map `size.map` high with `radius.md`
  and a 0.5 px `border`; and a Radius select. The pin stays in the middle of the map, which moves under it, so a
  place always has one: a 16 px `accent` circle with a 2 px `onAccent` ring. The place's circle is `accent`, 1.5 px,
  filled at 12 %. The map is OpenStreetMap through Golem, with only "© OpenStreetMap".
- A text field for long text, such as the workspace's facts, fills the card with 16 px padding, min 160 high, a 1.5
  line height, and its Save button at the bottom right.
- Text in a section, such as a channel summary: `fontSize.md` `textSecondary` on a 22 px line, with its line breaks.

## Badge, keycap, and avatar

- Badge: square, 24 high, padding 0 × 8, 0.5 px `borderStrong`, a 9 px dot (`textQuaternary`, or the tone's color)
  6 px before the label in `fontSize.sm` `book` `textTertiary`.
- Keycap: min 18 × 17, padding 2, `radius.xs`, 0.5 px `borderSubtle`, `fontSize.xs` `regular` `textTertiary`,
  slashed zero. In menus a shortcut is plain text.
- Avatar: a 24 px square with the person's profile picture, cropped to fill it; without one, the first letter of their
  name on an `accent` tile, in the 5 × 7 pixel letters of `letter` in `tokens.json`, 2 pt a pixel, in `onAccent`, whose
  bottom right corner dissolves into `canvas`.
- Golem's logo: one drawing everywhere, `logo` in `scripts/icon.ts`. An 8 × 8 white face with black marks and a solid
  `accent` forehead mark that dissolves to the right through interleaved-gradient noise. One noise cell is 1 pt at the
  size where it shows, also on a home screen, where a finer grain blurs into a gradient. It has one expression. On a
  transparent tile; in light, on a black tile, so the white face stays apart from a white surface. An avatar is
  24 pt, the sign-in 48 pt, and an empty state 96 pt. `golem` is the same logo in one color.

## Lists

- Rows: min 32 high, padding 0 × 8, `radius.md`, a 16 px `textTertiary` icon 8 px before the name in `fontSize.md`
  `medium` `text`, meta at the right in `fontSize.sm` `book` `textTertiary`. Rows that open something turn
  `fillSubtle` under the pointer at once.

## Inbox

- The sidebar's Inbox item, after Golem, shows the unread count. The page lists notifications newest first as search
  rows: an icon (the thread's, or `hash` for a channel), the title, the text in `textTertiary`, the day, and a
  `size.dot` `accent` dot while unread. A click reads it and opens its thread or channel. The header's check button
  reads them all.

## Upcoming

- The sidebar's Upcoming item, after Inbox, has the `clock` icon. The page is the Settings column; its groups, each
  only with items, are Needs you, Suggested, Today, Tomorrow, This week (the next 7 days), Later, At a place, Routines at a place, and Paused,
  each a section title over a card of compact rows. A routine row has the `play` icon, its name, its schedule in words and its
  channel, a failed badge after a failed run, and its switch; a reminder row has the `clock` icon, its text, its time,
  and a secondary Cancel button; a reminder at a place has the `place` icon and "Arrive at Cottage" or "Leave Office"
  in place of the time; so does a routine at a place, in place of its schedule, also in a channel's Routines.
- Suggestion: a compact row with its kind's icon, the name, when it runs, and secondary Decline and primary Accept
  buttons. In the person's orchestrator the waiting suggestions sit in one card over the composer, as wide as it.

## What Golem learned and Usage

- What Golem learned is a Settings section: a sub-heading (`fontSize.sm` `medium` `textTertiary`, 16 px in) per person
  ("About Anna") and per channel, each over a card of compact rows with the text, a 14 px `lock` for a private entry,
  and edit and delete icon buttons at the right. Edit turns the text into a field in place: Enter saves, Escape stops.
- Usage is a Settings section: rows for tokens, cost at API prices, and cache rate, then a bar for each of the last 30
  days, 80 px high, in `accent`, each with a tooltip; then cards by source, by model, the top threads as links, and,
  for the server's owner, by person with avatars.

## Conversation

- Message: avatar, then the author in `medium` `text` and the time in `fontSize.sm` `textQuaternary`; the text in
  `fontSize.lg` `book` `textSecondary` on a 1.6 line with −0.1 px letter spacing and its line breaks. A turn of Golem
  that the answer of another thread started, such as the result of work that Golem asked that thread for, continues
  Golem's message before it: no avatar, author, or time, 12 px under it, and its work summary says "From <thread>".
- Work log: between the meta and the text of an agent's answer, what the agent did before it. A summary in
  `fontSize.md` `textTertiary` with tabular numbers, "Working for 12s" counting up each second while it works, then
  "Worked for 14s", or "Stopped after 14s" when someone stopped it, with a disclosure arrow that turns 90° when open;
  hover turns it `text`. The steps sit under it in `fontSize.md` behind a 1 px `border` line, 8 px in, at most
  `size.workLog` high, scrolling, and keeping the newest step in view until the person scrolls up: thoughts in
  `textQuaternary`, words in `textSecondary`, and each tool call as a 7 px step pixel (`gold` when it finished,
  `danger` when it failed, the `accent` blinking while it runs), then its name in `medium` `textTertiary` (`danger`
  when it failed), then the thread it reached or its arguments on one truncated line in `textQuaternary`. A tool call
  opens to show its arguments and result in `fontSize.sm` monospace on `fillSubtle`, `radius.sm`. Calls of one tool in
  a row fold into one row, "Web search 4 times", open while one of them runs. The log is open while the agent works and
  folds when the answer comes; a person's choice to open or fold it stays until then. While it works, the working
  spinner and a shimmer lead the summary, and the step it is at follows in `textQuaternary` after a "·": the tool's
  name, "Thinking", or "Writing". Once done, one step pixel for each tool call (the last 24) follows the arrow, 2 px
  apart.
- Golem's avatar on an answer is the logo. The work log, the spinner, and an approval say how the work goes.
- Working spinner: four 4 px `accent` squares, 1 px apart, that light in turn clockwise each 0.25 s, after a thread in
  the sidebar, in a channel's thread list, and after each thread link while that thread's agent works.
- Shimmer: the words Golem is at now, in `textTertiary` with a light of `text` running over them every 2.2 s.
- Stop: while the agent works and the composer is empty, the composer's send button is Stop, with a stop icon. With
  text or files in the composer, it is Send again, with a steer icon (`arrow.turn.left.up`) and "Steer". Stop also
  stops the threads the agent asked for something, which still work on that message.
- Approval: in the transcript after the messages, in line with their text, for the person it asks only, while the
  agent waits for them to allow an action. `surfaceRaised`, a 0.5 px `ringControl`, `radius.md`, padding 8 × 12, and a
  3 px `gold` edge at its start; the action in `fontSize.md` monospace `textSecondary`, wrapped; 8 px below, at the
  start, far from the composer's Send, small buttons: primary "Allow" and danger "Deny". Each allows or denies this
  one call.
- Cards: an agent writes a fenced `card` block with a JSON object, or a list of them (`value`, and optionally `title`,
  `detail`, and `icon`). Each shows as a card: `surfaceRaised`, a 0.5 px `ringControl`, shadow `low`, `radius.md`,
  padding 8 × 12, in a grid of equal columns at least 160 px wide, 8 px apart; a 28 px pixel icon (temperature, heat, rain, sun,
  battery, bolt, car, home, lock) in `accent` on a black tile, the title in `fontSize.xs` `medium` capitals
  `textTertiary`, the value in `fontSize.lg` `semibold` `text` with tabular numbers, and the detail in `fontSize.sm`
  `textTertiary`. A block that is not valid shows as code.
- The sidebar shows the threads and channels that agents start while they work, without a reload.
- Composer: `surfaceComposer`, `radius.lg`, padding 12, shadow `low`, no focus ring. The text is `fontSize.lg` on a
  24 px line with padding 2 × 6; placeholder `textQuaternary`. Actions sit 8 px below: a tiny ghost attach button and a
  tiny primary send button.

## Thread link

- Agents write a thread as `[title](thread:<id>)` in a message. It shows as the title in `accent`, no underline;
  hover turns it `accentHover` and underlined. A click opens the thread in the app.

## Channel threads

- Active threads appear newest first under their channels in the sidebar and on the channel page, each with its
  settle button. Settled threads leave the active lists; a settled thread can be un-settled.

## File chip

- A file attached to a message, or picked in the composer: 28 high, padding 0 × 10 × 0 × 8,
  `radius.md`, `fillSubtle`, a 0.5 px `ring`, a 14 px paperclip in `textTertiary`, the name in `fontSize.sm`
  `textSecondary`, cut with an ellipsis at 240 wide. Chips wrap with a 4 px gap.
- In a message a picture shows itself instead of a chip, from its JPEG (`/files/:fileId/picture`): at most 320 wide
  and 240 high, `radius.md`, a 0.5 px `ring`. A picture that the server cannot convert shows as a chip.
- In a message the chip opens the file preview; hover turns it `fillHover` and the name `text`. Picked files show
  above the composer's buttons until the message is sent, each with a close icon in `textTertiary` (hover `text`)
  that takes the file out.
- The composer and the Files tab take dropped files, and the composer takes pasted files. While a file is dragged
  over them they show a 1 px `accent` outline.

## File preview

- A click on a file (a Files row, a file chip, a file link in a message, a search result) shows it over the page, as
  Quick Look does on a Mac. A click with a modifier key opens the file itself. Nothing downloads until Download.
- The web: the window less 24 px (all of it below 720 px), `surfaceRaised`, 0.5 px `borderDialog`, `radius.xl`, shadow
  `modal`, on the `overlay` backdrop. A 44 px header with a 0.5 px `border` below: the name in `fontSize.md` `medium`,
  cut with an ellipsis, the size in `fontSize.sm` `textTertiary`, then ghost icon buttons on the right: previous and
  next (when there is more than one file), Download, and Close.
- Space on a focused file opens it; Space, Escape, or the backdrop close it; ← and → show the file before or after.
- Pictures, video, and audio show centered at their size or smaller; PDFs in the browser's viewer; Markdown as prose
  in a 760 px column; code and text in the mono font with colors; CSV and spreadsheets as a table with a sticky
  header, with one tab per sheet; Word documents as their pages; slides one under the other on the background;
  zip files as a list of their files. Any other file, or one over 20 MB that the preview must read whole, shows
  "No preview" and a primary Download button.

## Artifact preview

- The panel has two tabs, Files and then Artifacts, and opens on Files.
- The Artifacts tab lists the thread's artifacts as list rows: artifact icon, title, and the number of people who
  opened it as meta. A row opens the artifact in the panel, with a close button that returns to the Artifacts list.
- The artifact has a bar (padding 4 16, 0.5 px `border` below): the title in `medium`, cut with an ellipsis, a
  badge (`accent` "Public" or plain "Members"), a small ghost "Data" button that is pressed while the data shows, and
  the actions menu (Open, Copy link, Make public or Make members only, Clear data, Delete).
- Under the bar the artifact runs and fills the panel. "Data" shows its records instead, as a settings card of compact
  rows: the key, then who (the visitor's name, "Visitor", or "Shared") and the JSON value, and a delete icon button.
