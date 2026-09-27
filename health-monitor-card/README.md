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
   `/local/health-monitor-card/health-monitor-card.js?v=3.21.1`, type
   *JavaScript module*. Raise the `?v=` after every update. Browsers keep the
   old module otherwise, even after a hard reload.

```yaml
type: custom:health-monitor-card
group: home_devices      # group slug (required)
title: Device Health     # optional
hours: 24                # optional, default history window: 6 | 24 | 72 | 168
page_size: 50            # optional, rows per page (min 10)
grid_options:
  columns: full          # required inside a sections-view grid, or it renders
                         # at one column width regardless of column_span
```

## What it shows

- **Summary tiles.** Devices offline, helpers unavailable, low battery and weak
  signal, each as bad/total. A tile reads as the good state ("Devices Online")
  when nothing is wrong, and hides when the group does not measure that check.
  Tapping a tile filters the table to exactly those rows and scrolls to it.
- **Problem history chart.** Counts over time from the recorder, as grouped bars
  per time slot. The legend toggles series; 6h / 24h / 3d / 7d set the window.
- **Four tabs.** *Monitored Devices* and *Monitored Helpers* (availability only),
  *Battery* and *Signal*. Status is scoped to the tab: *Devices* says Unavailable
  or OK, never Weak signal. *Signal* says that.
- **Filters.** Free-text search, plus multi-select Integration and Area menus with
  per-value counts, Select all and Clear. Integration, area and status values in
  the table are also chips: tapping one toggles the same filter. Any press
  outside an open menu closes it, and so does Escape.
- **Non-devices are marked `_`.** Anything without a device (automations,
  scripts, helpers, template sensors) has `_` in front of its name and its
  integration. They sort to the top of the integration menu, and typing `_`
  into search lists only them. An integration that has both kinds appears
  twice, for example `opensprinkler` and `_opensprinkler`.
- **Last seen** is `now` for anything available, the time it went offline for
  anything unavailable, and `last_triggered` for automations and scripts.
- **Expanded row.** *Devices* and *Helpers* show an availability timeline for
  every member entity (red = unavailable/unknown, green = anything else) and the
  logbook. *Battery* and *Signal* chart the bound battery or RSSI sensor as a
  step line.
- **Sticky header.** Tabs, filters and column row stay pinned while the table
  scrolls. The pin line is measured from Home Assistant's own toolbar, so it
  follows kiosk-mode's `hide_header` (pins at the very top) and the iOS safe
  area. Below 700px width only the column row pins.

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
(`history/history_during_period`, `logbook/get_events`). Series are drawn as
**step** lines: these are sampled readings that hold until the next one, so
interpolating would draw slopes that never happened.

No build step: one vanilla custom element, no dependencies.
