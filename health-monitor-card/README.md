# health-monitor-card

A dense console card for this integration, sized for a wall tablet: one
sortable, filterable table of every monitored device and helper, with the
history behind each row one tap away.

It reads **one** entity, `sensor.entity_availability_<group>_group_summary`, which
carries every row's state, integration, area, battery and signal source. The
table therefore costs one state subscription, however many devices are monitored.

## Requirements

- This integration, with at least one group.
- **[state-history-card](https://github.com/db-wally007/state-history-card) v0.1.6
  or later**, loaded as a dashboard resource. An expanded row draws its availability
  timeline with it, and uses its `default_color` option, which exists only in that
  fork. Without the card the row shows a notice instead of a timeline. With
  upstream state-history-card, every non-`unavailable` state gets its own colour
  instead of green.

## Install

1. Copy `health-monitor-card.js` to `config/www/health-monitor-card/`.
2. Add it as a dashboard resource (**Settings → Dashboards → ⋮ → Resources**):
   `/local/health-monitor-card/health-monitor-card.js?v=3.23.0`, type
   *JavaScript module*. Raise the `?v=` after every update. Browsers keep the
   old module otherwise, even after a hard reload.

```yaml
type: custom:health-monitor-card
group: home_devices      # group slug (required)
title: Device Health     # optional
hours: 24                # optional, default history window: 6 | 24 | 72 | 168
page_size: 50            # optional, rows per page (min 10)
embedded: false          # optional: true inside page-switcher-card - no title row or
                         # panel of its own (the tablet's Alerts view, page System Health)
url_params: true         # optional: false keeps the view out of the address
layout: phone            # optional: the iPhone page (see "Phone layout")
grid_options:
  columns: full          # required inside a sections-view grid, or it renders
                         # at one column width regardless of column_span
```

## What it shows

- **Summary tiles.** Devices offline, helper problems (unavailable or failed), low
  battery and weak signal, each as bad/total. A tile reads as the good state ("Devices Online")
  when nothing is wrong, and hides when the group does not measure that check.
  Tapping a tile filters the table to exactly those rows - its status, shown in the
  Status menu - and scrolls to it.
- **Problem history chart.** Problems over time from the recorder, as grouped bars
  in clock-aligned slots (1 h on 24h …), each at least ~48px wide for
  touch. A bar counts the devices that had the problem at any moment of its slot.
  *Problems* (red) is one count: devices unavailable, devices or helpers not updating, and
  jobs whose last run failed - each for as long as it lasts. Unavailable and not updating
  name theirs (`offline_count`, `stale_entities`); a failed run is counted from the group
  summary's recorded `failed`, which keeps no names (a tap on a bar of failed runs alone
  opens Helpers · Failed). Low battery and Weak signal are their own bars.
  Hover, or drag a finger across it, and a tooltip names them; tap or click a bar and
  the table shows exactly those devices (a chip in the filter row clears it). The
  legend toggles series; 24h / 3d / 7d set the window, for the chart and for an open
  row's history alike. Low battery and weak
  signal name their devices from integration v0.5.3+hm.4 on; older bars show only
  the count.
- **Four tabs.** *Monitored Devices* and *Monitored Helpers* (availability only),
  *Battery* and *Signal*. Status is scoped to the tab: *Devices* says Unavailable
  or OK, never Weak signal. *Signal* says that. *Ignored* (dark grey) is the one
  status every tab shares.
- **Filters.** Free-text search, plus multi-select Status, Integration and Area menus
  with the tab's counts per value, Select all and Clear. *Status* lists the tab's own
  statuses, worst first; on *Signal* it adds a *Signal quality* section (Poor / OK /
  Good). A menu's button names what is picked, as Grafana does: a chip per value
  (statuses in their colours, as in the table), as many as fit, then *+N*. Integration,
  area, status and quality values in the table are also chips: tapping one toggles the
  same filter. Any press outside an open menu closes it, and so does Escape. While any
  filter is set (a search too), *Reset* stands out in the selection white.
- **Non-devices are marked `_`.** Anything without a device (automations,
  scripts, helpers, template sensors, calendars) has `_` in front of its name and
  its integration. They sort to the top of the integration menu, and typing `_`
  into search lists only them. What follows the `_` comes from the integration's
  own declared type: things Home Assistant computes (helper and system
  integrations) are named by that integration (`_template`, `_automation`,
  `_script`, `_helper`); anything else without a device is named by what it is,
  its entity type, so a Google calendar and OpenSprinkler's calendar are both
  `_calendar`, not `_google` and `_opensprinkler`.
- **Last seen** is `now` for anything available, the time it went offline for
  anything unavailable, and `last_triggered` for automations and scripts.
- **Failed runs.** An automation or script whose latest run failed reads *Failed*, and
  the Helpers tile counts it ("Helper Problems"). Expanded, it shows its last run: the
  error, and an **Open trace** button that lands on that run.
- **More Info and Ignore.** An expanded row starts with two buttons, top left, in
  the Alerts card's *New alert* style. **More Info** opens the device's page (an
  entity's settings when it has no device). **Ignore** offers *For 1 day*, *For 1 week*
  or *Until I stop it*, and suppresses every entity of the row at once (the
  integration's suppress actions). An ignored row leaves every problem list, so
  nothing alerts on it, and reads *Ignored* in every tab and in the Status menu.
  While it holds, the button reads *Ignored until …* in the selection white and its
  menu starts with *Stop ignoring*. Needs integration v0.5.3+hm.4 (the ignore log,
  and suppress taking a list of entities).
- **The Ignored tile** - there while anything is ignored, so nothing set aside is
  forgotten - counts the ignored devices and helpers, in white like a healthy count
  (a reminder, not a problem). Tapping it lists them together, with no tab chosen
  and an *Ignored* chip in the filter row; the chip, Reset or a tab leaves it
  (the chip and Reset for *Monitored Devices*). Stop ignoring the last one there and
  the list reads *Nothing Ignored* (the tile fades away). An ignored device's *Last seen* comes from its entities' own
  states, so one that is still down reads how long, not *now*.
- **Expanded row.** *Devices* and *Helpers* show availability, and only
  availability - a band per member entity, as the integration judges it:
  - **green** *Available* - anything but `unavailable`/`unknown`;
  - **red** *Unavailable* - unavailable for at least the group's cooldown (120 s
    here): what the integration counts as offline;
  - **amber** *Brief drop-out* - unavailable for less than that: real (a Hue bulb
    losing its connection for 30 s), but it never counted;
  - **grey** *Restarting* - unavailable because Home Assistant was restarting (a gap
    that began while it stopped or started, or in the few minutes after, before the
    integration counts anything), from the integration's restart log.

  Below it the timeline, 10 entries a page (‹ › under it; a page slides out the way
  you are going and the next slides in). Each row (a chevron at its end) opens the whole
  event in a popup over the dimmed page - what happened and when, the device, the entity's
  full name and its entity id, how long a drop-out lasted or Home Assistant was down - as
  the Alerts card's timeline does. The rows: each Home Assistant restart once, in grey,
  with how long it was down; a brief drop-out as one line with its length; going unavailable and
  coming back; an ignore set or stopped, with who did it and until when (*Ignore
  ended* when one runs out by itself). The entities' states themselves (on, off, values) are never shown; a
  light switching on and off is one long green band. A label opens the entity's
  more-info. *Battery* and *Signal* chart the bound battery or RSSI sensor as a step
  line, with the time along the bottom marked exactly as under the availability band
  (state-history-card's own marks: "2:00 PM … Mon … 4:00 AM"). Where the sensor had no
  reading (unavailable, unknown) the line stops and a faint grey band marks the gap - the
  last reading is never carried across it; "now" says *unavailable* while it has none.
  (A sensor its integration keeps at its last value, as Ecowitt's RSSI, shows no gap: there
  was no unavailable reading.) Each history is headed with the range it shows (24h, 3d,
  7d), the chart's.
- **One date-time format,** shared with the Alerts card: *Today, 9:21 PM*,
  *Yesterday, 8:24 PM*, otherwise *Sun, Oct 4, 9:21 PM* - in the tooltip, the
  axis, the timeline and a job's last run.
- **The address is the view** (Grafana-style). Every filter is a URL parameter, read when a
  link lands on the view and written back as you use it (no Back-button steps), so a reload
  keeps the view and any view can be linked - an alert's link opens Health already filtered:

  `/dashboard/health?hm_tab=devices&hm_status=unavailable&hm_area=garage,studio`

  | Parameter | Values | Sets |
  |---|---|---|
  | `hm_tab` | `devices` (default), `helpers`, `battery`, `signal`, `ignored` | the tab, or the Ignored list |
  | `hm_status` | `unavailable`, `not_updating`, `low_battery`, `failed`, `weak_signal`, `ok`, `ignored` | Status |
  | `hm_quality` | `poor`, `ok`, `good` | Signal quality |
  | `hm_integration` | `shelly`, `hue`, `_template` … | Integration |
  | `hm_area` | `garage`, `guest_bedroom`, `internal` … | Area |
  | `hm_q` | any text | the search |
  | `hm_range` | `24h`, `3d`, `7d` | the charts' range |
  | `hm_rows` | entity ids (any entity of a row names the row) | exactly those rows, under a *From link* chip that lets go |
  | `hm_alert` | an alert's entity id (`alert2.…`) | with `hm_rows`: the chip names the alert, in its priority's colour, and counts its rows against the rest - *2 of 6 unavailable* |
  | `hm_open` | an entity id | that row open, and scrolled to |

  A value is the name shown, lowercase with `_` for spaces; several are joined with commas,
  and one that does not exist is ignored. A link is the whole view: what it does not set
  goes back to its default. Opened without any (from the menu), the view stays as it was.
  The rows a link names always show: a status filter that would hide one of them (an
  alert's device that has recovered since) is dropped. Tapping the chip lets go of the
  rows and leaves the other filters - every unavailable device, say.
  The parameters live in one table in the code - a new filter is one line. The address is
  only touched while the view is on screen (not from a page a page switcher has marked
  `inert` as it slides away), and the view's last filters - not the rows a link pinned - are
  kept on the device (`localStorage`, `hm-health-view`) for the Alerts editor's "as you last
  set it".
  `url_params: false` turns it off.
- **Sticky header.** Tabs, filters and column row stay pinned while the table
  scrolls. The pin line is measured from Home Assistant's own toolbar, so it
  follows kiosk-mode's `hide_header` (pins at the very top) and the iOS safe
  area. Below 700px width only the column row pins.

## Phone layout

`layout: phone` draws the page for an iPhone in the Alerts card's phone design. The mobile
dashboard's Alerts view uses it as page-switcher-card's Health page (`ios: true`), with the
header button `{ label: Hide, icon: filter, method: openHide }`.

- **Summary.** Category cards two by two: Devices, Helpers, Batteries and Signal. A card shows
  what is wrong in its colour (e.g. "1 / 208 Failed"), otherwise how many are fine. Batteries
  shows the lowest level. With an odd number of cards, Ignored is a card of its own, with when
  the ignore ends; otherwise it is a row below them. Then Problems Over Time: offline, low
  battery and weak signal over 24H or 7D (another range slides it out and the new one in), on
  a scale of two or three whole numbers, folded to its count while nothing happened. A finger on it names the rows behind a slot; a tap lists
  them under a red chip.
- **Lists.** A card opens its list over the summary. It has a title, search and the tabs
  Devices | Helpers | Battery | Signal (the list slides, the title follows), then Needs
  Attention and every row. Batteries are lowest first, radios weakest first. The header's ‹
  goes back to the summary (`handleBack()`), and from the summary it leaves.
- **Rows.** One line each: the row's name, and its problem or what the list is about (room,
  last run, battery, signal). Swipe left to Ignore. A tap opens a bottom sheet with:
  - the status, More Info and Ignore (a day, a week or until stopped);
  - an automation's or script's last run, with its error and trace;
  - Battery, Signal, Timeline & Availability and Entities behind rows. Timeline &
    Availability has its own 24 Hours | 3 Days | 7 Days pills (it opens on the chart's range;
    the content slides with them), a bar per entity, then every change, newest first.
- **Hide.** The header's filter button hides kinds of problem from the whole page. For now
  that is Weak Signal, hidden by default: its card, tab, bars, callout names and summary line
  all go. The choice is kept in the viewer's Home Assistant profile (frontend user data,
  `health_phone_hide`), so it follows them to every device. The button is white while
  something is hidden.
- **Links.** The tablet's address works here too, so one link serves both: `hm_tab`,
  `hm_status`, `hm_integration`, `hm_area`, `hm_quality`, `hm_q`, `hm_range`, `hm_rows` with
  `hm_alert`, and `hm_open`. They open the list they name with their filters as chips. An
  alert's rows get the alert's chip ("1 of 73"); ✕ lets each go.

## Design rules

**No uptime score.** "97% available" is not actionable. Availability is meant to
be 100%, so any figure below it is just a broken thing wearing a percentage. The
first panel is a *history of problem counts*, because the real questions are
when things broke and whether it is getting worse.

**The context follows the view.** In Battery a row charts its battery sensor. In
Signal it charts its RSSI sensor. In Devices and Helpers it shows an up/down
timeline. The row entity itself usually answers none of those, which is why the
integration publishes `battery_sources` / `signal_sources`.

**Touch first.** Every hit target is at least `--tap` (52px) and body type is
16px. All sizing derives from the tokens at the top of the stylesheet, so the
card rescales coherently when those change.

**Four type roles.** Title, body, meta and label. A new element gets its type by
joining a role, not by inventing a font size.

History comes from the recorder over the websocket API
(`history/history_during_period`). Series are drawn as
**step** lines: these are sampled readings that hold until the next one, so
interpolating would draw slopes that never happened.

No build step: one vanilla custom element, no dependencies.
