/*
 * health-monitor-card — v3
 *
 * A dense, Grafana-shaped console for the Health Monitor integration, sized for
 * a wall tablet rather than a desktop mouse.
 *
 * Design rules:
 *
 *  - No uptime score. "97% available" is not actionable: availability is meant to
 *    be 100%, so any figure below it is just a broken thing wearing a percentage.
 *    The first panel is a HISTORY of problem counts over time.
 *
 *  - The context follows the view. In Battery a row charts its BATTERY sensor; in
 *    Signal, its RSSI sensor; in Availability, an up/down state timeline plus the
 *    logbook. The row entity is usually a switch or binary sensor whose own
 *    history answers none of those — which is why the integration publishes
 *    battery_sources / signal_sources: the id of the sensor holding the number.
 *

 *  - Devices and helpers are separate tabs. They share a health model but nothing
 *    else: a Shelly has an area, a radio and a battery; an automation has none of
 *    those and fails by not running.
 *
 *  - Every column sorts. Integration and Area are MULTI-select, and their values
 *    are also chips in the table: tapping one ticks it in its dropdown. A flat
 *    list of 280 rows is a list you cannot use.
 *
 *  - Four type roles and nothing else (see the top of STYLES). Every element
 *    declares which role it plays; a new element gets type by joining a role, not
 *    by inventing a font-size.
 *
 *  - Touch first. Every interactive element is at least --tap high and type is
 *    sized to be read at arm's length on a wall tablet. All sizing flows from the
 *    tokens at the top of STYLES, so the whole card rescales coherently.
 *
 *  - One scrollbar. Nothing inside the card scrolls except the filter popover.
 *
 * History comes from the recorder over the websocket API
 * (history/history_during_period, logbook/get_events).
 *
 * Config:
 *   type: custom:health-monitor-card
 *   group: home_devices      # group slug (required)
 *   title: Device Health     # optional
 *   hours: 24                # optional: 6 | 24 | 72 | 168
 *   grid_options: {columns: full}   # required inside a sections-view grid
 */

const VERSION = "3.22.0";

/* One colour per problem CATEGORY, used in every place that category is shown —
   chart line, chart fill, legend, row dot, status text, detail chart. A category
   that changes colour between the chart and the table is not a colour scheme, it
   is two colour schemes.

   `info` (blue) is deliberately NOT in that set: it means "interactive" (active
   tab, checked box, sorted column, filtered chip) and never encodes data. Keeping
   it out of the data palette is what stops a blue line reading as a category. */
const COL = {
  ok: "#3FB950",          // healthy
  bad: "#F85149",         // offline — the only red
  battery: "#DB6D28",     // low battery — dark orange
  signal: "#EFC53F",      // weak signal — yellow, well clear of the orange
  stale: "#8B949E",       // stale — deliberately colourless
  info: "#58A6FF",        // INTERACTIVE ONLY, never a data category
  grid: "rgba(255,255,255,.07)",
  axis: "rgba(255,255,255,.45)",
};

/* Worst category present, so an aggregate badge shows the colour of the thing you
   should look at first. Order is severity, not alphabet. */
/* STATUS IS SCOPED TO THE TAB. A tab asks exactly one question, so its Status
   column and row dot must answer only that one. The Devices tab showing "Weak
   signal" was wrong twice over: the device is available (which is what that tab
   is about) and there is a whole Signal tab for the radio. Never fold the
   categories back into one "worst problem" here — they are separate tabs. */
function statusOf(d, view) {
  if (d.offline) return { text: "Unavailable", tone: COL.bad };
  if (view === "battery")
    return d.lowBattery ? { text: "Low battery", tone: COL.battery }
                        : { text: "OK", tone: COL.ok };
  if (view === "signal")
    return d.poorSignal ? { text: "Weak signal", tone: COL.signal }
                        : { text: "OK", tone: COL.ok };
  // devices / helpers: availability only. Staleness belongs here — an entity
  // that stopped reporting is an availability problem, not a battery or radio one.
  // An automation/script whose latest run failed is Failed — every failed run, at once.
  if (d.failed) return { text: "Failed", tone: COL.bad };
  if (d.stale) return { text: "Not updating", tone: COL.stale };
  return { text: "OK", tone: COL.ok };
}

const isJob = (d) => /^(automation|script)\./.test(d.id);

/* "Last seen" = when we last had EVIDENCE the row was alive, which is not the
   same as when its state last CHANGED. A light on for 10h and an Ecowitt whose
   anchor entity is Yearly Rain were both reporting fine yet read "10h ago",
   because the integration publishes last_seen as the anchor entity's
   last_changed. Availability is the evidence: the coordinator re-checks every
   30s, so an available row was seen at that poll. A row that is down was last
   seen when it went down. */
function lastSeenOf(d, hass) {
  const st = hass?.states?.[d.id];
  // Automations and scripts are asked "Last run", which is a real timestamp.
  if (/^(automation|script)\./.test(d.id)) {
    const t = st?.attributes?.last_triggered;
    return t ? ago(t) : "never";
  }
  if (d.offline) return ago(d.offlineSince || d.lastSeen);
  return "now";
}

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/* iOS's own curve for sheets and list moves: leaves immediately, lands slowly.
   IOS_SOFT is the same character with a touch of overshoot for small controls
   (segment pill, checkbox) where a little bounce reads as responsive rather than
   sloppy. Nothing in this card uses a linear or ease-in-out curve. */
/* The CSS media query only silences CSS animations and transitions. Motion driven
   from JS has to opt out itself, or "reduce motion" quietly stops meaning anything
   in this card — which, now that the list is choreographed from JS, is most of it. */
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const IOS = "cubic-bezier(0.32, 0.72, 0, 1)";
const IOS_SOFT = "cubic-bezier(0.34, 1.26, 0.64, 1)";
const RANGES = [
  { id: "6h", label: "6h", hours: 6 },
  { id: "24h", label: "24h", hours: 24 },
  { id: "3d", label: "3d", hours: 72 },
  { id: "7d", label: "7d", hours: 168 },
];
/* Devices and helpers are different kinds of thing that happen to share a health
   model. A Shelly has an area, a radio and a battery; an automation has none of
   those and fails by not running. Splitting them into their own tabs is what makes
   "how many real devices am I watching" answerable at a glance, and lets each side
   show only the columns that mean anything for it. */
const VIEWS = [
  { id: "devices", label: "Monitored Devices" },
  { id: "helpers", label: "Monitored Helpers" },
  { id: "battery", label: "Battery" },
  { id: "signal", label: "Signal" },
];

// A row is a device when the registry gave it one. Automations, scripts, helpers
// and template sensors have no device — that is exactly what separates them.
const isDevice = (r) => !!r.deviceId;

/* "_" marks everything that is NOT a device (automations, scripts, helpers,
   template sensors) in its name AND its integration, so it reads as not-hardware
   in every list, row, chip and dropdown. It collates ahead of letters, which puts
   those entries together at the top of the integration dropdown, and it can be
   typed into search. One rule, the same one that splits the Devices and Helpers
   tabs: no device, "_". An integration with both kinds therefore appears twice
   (opensprinkler: the controller, and its device-less calendar as _opensprinkler). */
const NON_DEVICE_MARK = "_";

/* Integration labels. Helper domains are a dozen separate "integrations" in the
   registry (input_boolean, input_number, timer …) which is technically true and
   useless as a filter — nobody thinks "show me my input_numbers". They collapse to
   one bucket. automation/script/template stay distinct because they fail in
   different ways and you chase them separately. */
const PLATFORM_GROUP = {
  input_boolean: "helper", input_number: "helper", input_text: "helper",
  input_datetime: "helper", input_select: "helper", counter: "helper",
  timer: "helper", schedule: "helper",
};
const groupPlatform = (p) => PLATFORM_GROUP[p] || p;

// Things with no area are not "nowhere" — they are Home Assistant itself:
// automations, scripts, helpers, template sensors from packages.
const AREA_INTERNAL = "Internal";
const areaLabel = (a) => (!a || a === "(No Area)" || a === "—" ? AREA_INTERNAL : a);

/* The status strip. Each tile is a live count and a shortcut: tapping one takes
   you to the view that explains it, which is what the number is for. `tone` is the
   colour the number takes once it is non-zero; Devices has none because a device
   count is never a problem. */
/* One name per state, used by the tile, the table and the chart legend alike.
   "Offline" was a device word applied to helpers, where it is simply wrong — an
   automation is not offline, it is unavailable. "Unavailable" is what Home
   Assistant itself shows on the entity, so it needs no explaining.
   `needs` ties a tile to the feature that produces it: a tile for a measurement
   this group does not take is a control that can only ever read 0. */
/* One tile per thing being watched, each reading "bad / total" — the fraction is
   the whole design. A bare "1 Offline" said nothing about how many devices that was
   out of, and a bare "69 Devices" said nothing about whether they were healthy; the
   pair answers both at once, and the denominator is also the only place the count of
   monitored batteries and radios ever appears. At zero the fraction collapses to the
   total and the wording flips to the good state, so a healthy card reads as a list
   of plain facts rather than a row of zeros. */
const STATS = [
  { id: "devices", bad: "Devices Offline", ok: "Devices Online", tone: COL.bad },
  { id: "helpers", bad: "Helper Problems", ok: "Helpers OK", tone: COL.bad },
  { id: "battery", bad: "Low Battery", ok: "Batteries OK",
    tone: COL.battery, needs: "battery_enabled" },
  { id: "signal", bad: "Weak Signal", ok: "Signals OK",
    tone: COL.signal, needs: "signal_enabled" },
];

const COLUMNS = {
  devices: [
    { id: "name", label: "Device", w: "minmax(180px,2.2fr)" },
    { id: "platform", label: "Integration", w: "minmax(120px,1fr)" },
    { id: "area", label: "Area", w: "minmax(120px,1fr)" },
    { id: "status", label: "Status", w: "120px", align: "right" },
    { id: "lastSeen", label: "Last seen", w: "130px", align: "right" },
  ],
  // No Area column: a helper has no area by definition, so a column of identical
  // "Internal" is a column of nothing.
  helpers: [
    { id: "name", label: "Name", w: "minmax(220px,3fr)" },
    { id: "platform", label: "Type", w: "minmax(130px,1fr)" },
    { id: "status", label: "Status", w: "120px", align: "right" },
    { id: "lastSeen", label: "Last run", w: "130px", align: "right" },
  ],
  battery: [
    { id: "name", label: "Device", w: "minmax(180px,2.2fr)" },
    { id: "platform", label: "Integration", w: "minmax(120px,1fr)" },
    { id: "area", label: "Area", w: "minmax(120px,1fr)" },
    { id: "battery", label: "Battery", w: "170px", align: "right" },
    { id: "status", label: "Status", w: "130px", align: "right" },
  ],
  signal: [
    { id: "name", label: "Device", w: "minmax(180px,2.2fr)" },
    { id: "platform", label: "Integration", w: "minmax(120px,1fr)" },
    { id: "area", label: "Area", w: "minmax(120px,1fr)" },
    { id: "rssi", label: "Signal", w: "170px", align: "right" },
    { id: "quality", label: "Quality", w: "110px", align: "right" },
  ],
};

class HealthMonitorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "devices";
    this._range = "24h";
    this._sort = { col: "status", dir: "asc" };
    this._platforms = new Set();
    this._areas = new Set();
    // Status/quality are VIEW-SCOPED vocabularies ("Unavailable" in Devices,
    // "Low battery" in Battery), so both are cleared whenever the tab changes.
    this._statuses = new Set();
    this._qualities = new Set();
    this._q = "";
    this._open = null;
    this._page = 0;
    this._series = new Set([0, 1, 2]);   // chart series shown; toggled from the legend
    this._built = false;
    this._sig = "";
    this._overview = null;
    /* Any press outside an open menu closes it, INCLUDING presses elsewhere in
       this card. The old test was "outside the card", and on the Health view the
       card is the whole screen, so nothing ever qualified. pointerdown, not click:
       iOS does not deliver click to a document listener when the tapped element
       is not itself clickable (table cell, blank background). Capture phase, so
       nothing inside can stopPropagation it away. */
    this._onDocPress = (e) => {
      const path = e.composedPath?.() || [];
      this.shadowRoot?.querySelectorAll(".ms.open").forEach((m) => {
        if (!path.includes(m)) m.classList.remove("open");
      });
    };
    this._onDocKey = (e) => { if (e.key === "Escape") this._closeMenus(); };
  }

  setConfig(config) {
    if (!config || !config.group) {
      throw new Error("health-monitor-card: 'group' is required (the group slug)");
    }
    this._config = { title: "Device Health", hours: 24, page_size: 50, ...config };
    this._pageSize = Math.max(10, Number(this._config.page_size) || 50);
    const r = RANGES.find((x) => x.hours === Number(this._config.hours));
    this._range = r ? r.id : "24h";
    this._built = false;
    this.shadowRoot.innerHTML = "";
  }

  getCardSize() { return 18; }
  static getStubConfig() { return { type: "custom:health-monitor-card", group: "home_devices" }; }

  connectedCallback() {
    document.addEventListener("pointerdown", this._onDocPress, true);
    document.addEventListener("keydown", this._onDocKey, true);
    this._trackHaHeader();
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDocPress, true);
    document.removeEventListener("keydown", this._onDocKey, true);
    this._hdrRo?.disconnect(); this._hdrRo = null; this._hdr = null;
    this._ro?.disconnect(); this._ro = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // The embedded state-history-card is a live element, not markup we re-emit,
    // so it needs hass handed to it on every tick or its "now" edge freezes.
    if (this._shc?.isConnected) this._shc.hass = hass;
    // hui-root can re-render its header (edit mode); follow the new element.
    if (this._hdr && !this._hdr.isConnected) this._trackHaHeader();
    const base =`sensor.entity_availability_${this._config.group}`;
    const summary = hass.states[`${base}_group_summary`];
    if (!summary) return this._fail(`${base}_group_summary`);
    this._base = base;
    this._data = this._read(summary, hass);
    if (!this._built) this._build();
    this._paint();
    if (first) this._loadOverview();
  }

  // ------------------------------------------------------------------ data

  _read(summary, hass) {
    const a = summary.attributes;
    const setOf = (k) => new Set(a[k] || []);
    const offline = setOf("offline_entities");
    const lowBat = setOf("low_battery_entities");
    const poor = setOf("poor_signal_entities");
    const stale = setOf("stale_entities");
    const okSig = setOf("ok_signal_entities");
    const failed = setOf("failed_entities");

    const rows = (a.entities_collapsed || []).map((id) => {
      const members = (a.row_members || {})[id] || [id];
      const pick = (map) => {
        for (const m of members) if ((map || {})[m] !== undefined) return (map || {})[m];
        return null;
      };
      let battery = null;
      for (const m of members) {
        const x = (a.battery_levels || {})[m];
        if (typeof x === "number") battery = battery === null ? x : Math.min(battery, x);
      }
      let rssi = null, unit = "";
      for (const m of members) {
        const x = (a.signal_levels || {})[m];
        if (typeof x === "number" && (rssi === null || x < rssi)) {
          rssi = x; unit = (a.signal_units || {})[m] || "dBm";
        }
      }
      const isPoor = members.some((m) => poor.has(m));
      const isOk = members.some((m) => okSig.has(m));
      const deviceId = pick(a.device_ids);
      const mark = deviceId ? "" : NON_DEVICE_MARK;
      const baseName = (a.display_names || {})[id] || id;
      return {
        id, members,
        name: mark + baseName,
        baseName,   // unmarked; member friendly names start with this, not with name
        platform: mark + groupPlatform(pick(a.platforms) || "—"),
        area: areaLabel(pick(a.areas)),
        deviceId,
        batterySource: pick(a.battery_sources),
        signalSource: pick(a.signal_sources),
        offline: members.some((m) => offline.has(m)),
        lowBattery: members.some((m) => lowBat.has(m)),
        poorSignal: isPoor,
        stale: members.some((m) => stale.has(m)),
        failed: members.some((m) => failed.has(m)),
        run: pick(a.job_runs),
        battery, rssi, unit,
        quality: rssi === null ? null : isPoor ? "Poor" : isOk ? "OK" : "Good",
        lastSeen: pick(a.last_seen),
        offlineSince: pick(a.offline_since),
      };
    });

    const n = (id) => {
      const s = hass.states[id];
      const v = s ? Number(s.state) : NaN;
      return Number.isFinite(v) ? v : 0;
    };
    return {
      rows,
      offline: a.offline || 0,
      lowBattery: a.low_battery || 0,
      poorSignal: a.poor_signal || 0,
      stale: a.stale || 0,
      devices: Number(summary.state) || rows.length,
      entities: n(`${this._base}_monitored`),
      // What this group actually measures. A tile for a check that is switched off
      // can only ever read zero, so it is hidden rather than shown as a false calm.
      features: {
        battery_enabled: !!a.battery_enabled,
        signal_enabled: !!a.signal_enabled,
        staleness_enabled: !!a.staleness_enabled,
      },
      thresholds: {
        cooldown: a.cooldown_seconds,
        battery: a.battery_threshold,
        staleness: a.staleness_minutes,
      },
    };
  }

  _visible() {
    let out = this._data.rows;
    if (this._view === "devices") out = out.filter(isDevice);
    if (this._view === "helpers") out = out.filter((r) => !isDevice(r));
    if (this._view === "battery") out = out.filter((r) => r.battery !== null);
    if (this._view === "signal") out = out.filter((r) => r.rssi !== null);
    if (this._platforms.size) out = out.filter((r) => this._platforms.has(r.platform));
    if (this._areas.size) out = out.filter((r) => this._areas.has(r.area));
    if (this._statuses.size)
      out = out.filter((r) => this._statuses.has(statusOf(r, this._view).text));
    if (this._qualities.size) out = out.filter((r) => this._qualities.has(r.quality));
    if (this._q) {
      const q = this._q.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
    }
    const { col, dir } = this._sort;
    // Sort by the status the tab actually SHOWS, or the order contradicts the column.
    const sev = (r) => {
      if (r.offline) return 0;
      if (this._view === "battery") return r.lowBattery ? 1 : 4;
      if (this._view === "signal") return r.poorSignal ? 1 : 4;
      if (r.failed) return 1;
      return r.stale ? 2 : 4;
    };
    const key = (r) => {
      switch (col) {
        case "status": return sev(r);
        case "battery": return r.battery === null ? Infinity : r.battery;
        case "rssi": return r.rssi === null ? Infinity : r.rssi;
        case "quality": return { Poor: 0, OK: 1, Good: 2 }[r.quality] ?? 3;
        case "lastSeen": {
          if (/^(automation|script)\./.test(r.id)) {
            const t = this._hass?.states?.[r.id]?.attributes?.last_triggered;
            return t ? -Date.parse(t) : Infinity;
          }
          if (!r.offline) return -Infinity;          // seen just now
          const t = r.offlineSince || r.lastSeen;
          return t ? -Date.parse(t) : Infinity;
        }
        case "platform": return r.platform;
        case "area": return r.area;
        default: return r.name.toLowerCase();
      }
    };
    return [...out].sort((x, y) => {
      const a = key(x), b = key(y);
      const c = typeof a === "string" ? a.localeCompare(b) : a - b;
      return (dir === "asc" ? c : -c) || x.name.localeCompare(y.name);
    });
  }

  // --------------------------------------------------------------- history

  async _ws(msg) { try { return await this._hass.callWS(msg); } catch { return null; } }

  _window() {
    const hours = RANGES.find((r) => r.id === this._range).hours;
    const end = new Date();
    return { start: new Date(end.getTime() - hours * 3600e3), end, hours };
  }

  async _loadOverview() {
    const { start, end } = this._window();
    const ids = [
      `${this._base}_offline_count`,
      `${this._base}_low_battery_count`,
      `${this._base}_poor_signal_count`,
    ];
    const res = await this._ws({
      type: "history/history_during_period",
      start_time: start.toISOString(), end_time: end.toISOString(),
      entity_ids: ids, minimal_response: true, no_attributes: true,
      significant_changes_only: false,
    });
    this._overview = { res: res || {}, ids, start, end };
    this._drawOverview();
  }

  async _loadDetail(row) {
    const { start, end } = this._window();
    const box = this.shadowRoot.getElementById("detailBody");
    if (!box) return;
    // Each renderer below measures the panel BEFORE swapping content and animates
    // from that height to the new one, so the panel grows instead of jumping.
    const panel = box.parentElement;
    if (!box.querySelector(".loading")) box.innerHTML = `<div class="loading">Loading history…</div>`;

    if (this._view === "devices" || this._view === "helpers") {
      const res = await this._ws({
        type: "history/history_during_period",
        start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: row.members, minimal_response: true, no_attributes: true,
        significant_changes_only: false,
      });
      const log = await this._ws({
        type: "logbook/get_events",
        start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: row.members,
      });
      const h = panel.offsetHeight;
      this._drawTimeline(box, row, res || {}, log || [], start, end);
      this._resizeDetail(panel, h);
      return;
    }

    const target = this._view === "battery" ? row.batterySource : row.signalSource;
    if (!target) {
      const h = panel.offsetHeight;
      box.innerHTML = `<div class="loading">No ${
        this._view === "battery" ? "battery" : "signal"} sensor is bound to this device.</div>`;
      this._resizeDetail(panel, h);
      return;
    }
    const res = await this._ws({
      type: "history/history_during_period",
      start_time: start.toISOString(), end_time: end.toISOString(),
      entity_ids: [target], minimal_response: true, no_attributes: true,
      significant_changes_only: false,
    });
    const h = panel.offsetHeight;
    this._drawSeries(box, row, target, (res || {})[target] || [], start, end);
    this._resizeDetail(panel, h);
  }

  // ----------------------------------------------------------------- build

  _fail(id) {
    this.shadowRoot.innerHTML = `<ha-card style="padding:24px;font:16px system-ui;color:#fff">
      <b>health-monitor-card</b><br>Entity not found: <code>${id}</code></ha-card>`;
    this._built = false;
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <header class="top">
          <span class="h1 t-title">${escapeHtml(this._config.title)}</span>
        </header>

        <section class="status">
          <div class="ptitle"><span class="phead">Current status</span></div>
          <div class="tiles" id="tiles">
            ${STATS.map((s) => `
              <button class="tile" data-stat="${s.id}">
                <span class="tval num">
                  <span class="tbig" id="t_${s.id}">0</span>
                  <span class="tden" id="d_${s.id}"></span>
                </span>
                <span class="tlab" id="s_${s.id}">${s.ok}</span>
              </button>`).join("")}
          </div>
        </section>

        <section class="panel">
          <div class="ptitle">
            <span class="phead">Problems over time</span>
            <span class="legend" id="legend">
              <button class="lg on" data-s="0"><i style="--c:${COL.bad}"></i>Unavailable</button>
              <button class="lg on" data-s="1"><i style="--c:${COL.battery}"></i>Low battery</button>
              <button class="lg on" data-s="2"><i style="--c:${COL.signal}"></i>Weak signal</button>
            </span>
            <div class="ranges" id="ranges">
              ${RANGES.map((r) => `<button class="rg${r.id === this._range ? " on" : ""}" data-r="${r.id}">${r.label}</button>`).join("")}
            </div>
          </div>
          <div class="chartwrap" id="overview"></div>
        </section>

        <div class="stickyhead" id="stickyhead">
        <nav class="views" id="views">
          ${VIEWS.map((v) => `<button class="vw${v.id === this._view ? " on" : ""}" data-v="${v.id}">${v.label}</button>`).join("")}
        </nav>

        <div class="filters">
          <label class="search">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input id="q" type="search" placeholder="Search devices…" autocomplete="off">
          </label>
          <div class="ms" id="msPlatform">
            <button class="msbtn" data-for="platform"><span class="mslabel">All integrations</span>
              <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
            <div class="mspanel"></div>
          </div>
          <div class="ms" id="msArea">
            <button class="msbtn" data-for="area"><span class="mslabel">All areas</span>
              <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
            <div class="mspanel"></div>
          </div>
          <button class="clear" id="clear">Reset</button>
        </div>

        </div>

        <div class="tablewrap">
          <div class="thead" id="thead"></div>
          <div class="tbody" id="tbody"></div>
        </div>
        <div class="pager" id="pager">
          <button class="pg" id="pgPrev" aria-label="Previous page">
            <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
          <span class="pgtext" id="pgText"></span>
          <button class="pg" id="pgNext" aria-label="Next page">
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        </div>
        <div class="tfoot" id="tfoot"></div>
      </ha-card>`;

    const $ = (id) => this.shadowRoot.getElementById(id);
    this._el = {
      ranges: $("ranges"), legend: $("legend"), overview: $("overview"), views: $("views"),
      ...Object.fromEntries(STATS.map((s) => [`t_${s.id}`, $(`t_${s.id}`)])),
      ...Object.fromEntries(STATS.map((s) => [`s_${s.id}`, $(`s_${s.id}`)])),
      ...Object.fromEntries(STATS.map((s) => [`d_${s.id}`, $(`d_${s.id}`)])),
      q: $("q"), msPlatform: $("msPlatform"), msArea: $("msArea"), clear: $("clear"),
      thead: $("thead"), tbody: $("tbody"), tfoot: $("tfoot"),
      pager: $("pager"), pgPrev: $("pgPrev"), pgNext: $("pgNext"), pgText: $("pgText"),
    };

    /* A count you cannot act on is decoration. Each tile jumps to the view that
       explains its number, clearing any filter that would hide the very rows it
       just counted. */
    this.shadowRoot.getElementById("tiles").addEventListener("click", (e) => {
      const t = e.target.closest(".tile");
      if (!t) return;
      const id = t.dataset.stat;
      this._platforms.clear();
      this._areas.clear();
      this._statuses.clear();
      this._qualities.clear();
      this._q = "";
      this._el.q.value = "";

      // Every tile is now exactly one tab, so there is nothing to disambiguate.
      this._setView(id);

      /* The tile counts the BAD rows, so it lands on the bad rows — showing the
         healthy ones too answers a question nobody asked by tapping "1 Offline".
         At zero there is nothing to isolate, so the tab is left unfiltered
         rather than filtered down to an empty table. */
      const badHelpers = this._data.rows.filter((r) => !isDevice(r) && (r.offline || r.failed));
      const bad = { devices: this._data.rows.filter((r) => isDevice(r) && r.offline).length,
                    helpers: badHelpers.length,
                    battery: this._data.lowBattery, signal: this._data.poorSignal }[id];
      if (bad > 0) {
        if (id === "signal") this._qualities.add("Poor");
        else if (id === "battery") this._statuses.add("Low battery");
        // Helper problems come in two kinds; select exactly the ones present.
        else if (id === "helpers")
          for (const r of badHelpers) this._statuses.add(statusOf(r, "helpers").text);
        else this._statuses.add("Unavailable");
      }
      this._paintFilters();
      this._paintTable();
      // On a tablet the tiles and the table are a screen apart; without this the
      // table changes out of sight and the tap looks like it did nothing.
      this._scrollToTable();
    });

    this._el.legend.addEventListener("click", (e) => {
      const b = e.target.closest(".lg");
      if (!b) return;
      const k = Number(b.dataset.s);
      // Last one standing stays on: an empty chart is not a useful state to be in.
      if (this._series.has(k) && this._series.size === 1) return;
      this._series.has(k) ? this._series.delete(k) : this._series.add(k);
      b.classList.toggle("on", this._series.has(k));
      this._drawOverview();
    });

    this._el.ranges.addEventListener("click", (e) => {
      const b = e.target.closest(".rg"); if (!b) return;
      this._range = b.dataset.r;
      this.shadowRoot.querySelectorAll(".rg").forEach((x) => x.classList.toggle("on", x === b));
      this._loadOverview();
      if (this._open) this._loadDetail(this._data.rows.find((r) => r.id === this._open));
    });

    this._el.views.addEventListener("click", (e) => {
      const b = e.target.closest(".vw"); if (!b) return;
      this._setView(b.dataset.v);
      this._paint();
    });

    this._el.q.addEventListener("input", () => {
      this._q = this._el.q.value.trim(); this._sig = ""; this._paintTable();
    });

    for (const [host, which] of [[this._el.msPlatform, "platform"], [this._el.msArea, "area"]]) {
      host.querySelector(".msbtn").addEventListener("click", (e) => {
        e.stopPropagation();
        const open = host.classList.contains("open");
        this._closeMenus();
        if (!open) host.classList.add("open");
      });
      host.querySelector(".mspanel").addEventListener("click", (e) => {
        e.stopPropagation();
        const opt = e.target.closest(".msopt");
        const act = e.target.closest(".msact");
        const set = which === "platform" ? this._platforms : this._areas;
        if (act) {
          if (act.dataset.a === "none") set.clear();
          else for (const v of this._optionValues(which)) set.add(v);
        } else if (opt) {
          const v = opt.dataset.v;
          set.has(v) ? set.delete(v) : set.add(v);
        } else return;
        // Update the open menu IN PLACE. Re-rendering its innerHTML would detach
        // the very element the finger is on, so a second tick lands on a dead node
        // and silently does nothing — and it would throw away the scroll position
        // mid-selection, which is exactly when you are furthest down the list.
        this._syncMenu(host, which);
        this._sig = "";
        this._paintTable();
      });
    }

    this._el.pgPrev.addEventListener("click", () => this._goPage(this._page - 1));
    this._el.pgNext.addEventListener("click", () => this._goPage(this._page + 1));

    this._el.clear.addEventListener("click", () => {
      this._q = ""; this._platforms.clear(); this._areas.clear();
      this._statuses.clear(); this._qualities.clear();
      this._el.q.value = ""; this._sig = "";
      this._closeMenus(); this._paintFilters(); this._paintTable();
    });

    /* One delegated listener for the whole table. Rows are reused across repaints
       now, so attaching handlers per row would either leak them or need rewiring
       every patch. */
    this._el.tbody.addEventListener("click", (e) => {
      const info = e.target.closest(".info");
      if (info) { e.stopPropagation(); this._openSettings(info.dataset.info); return; }
      const nav = e.target.closest("[data-nav]");
      if (nav) {
        e.stopPropagation();
        history.pushState(null, "", nav.dataset.nav);
        this.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
        return;
      }
      const tag = e.target.closest(".tag[data-f]");
      if (tag) { e.stopPropagation(); this._toggleFilter(tag.dataset.f, tag.dataset.v); return; }
      const tr = e.target.closest(".tr");
      if (tr) this._toggle(tr.dataset.id);
    });

    this._ro?.disconnect();
    this._ro = new ResizeObserver(() => this._drawOverview());
    this._ro.observe(this._el.overview);

    /* The column row pins directly beneath the tabs+filters block, so it needs
       that block's live height: it changes whenever the filters wrap to another
       row (width change, rotation, a long area name). */
    const head = this.shadowRoot.getElementById("stickyhead");
    this._headRo?.disconnect();
    this._headRo = new ResizeObserver(() => {
      this.shadowRoot.host.style.setProperty("--sticky-h", `${head.offsetHeight}px`);
    });
    this._headRo.observe(head);
    this._built = true;
  }

  /* Reflect the current selection onto an already-rendered menu: checkbox states,
     the button label and the active outline. No innerHTML, so nothing detaches. */
  _syncMenu(host, which) {
    const set = which === "platform" ? this._platforms : this._areas;
    const allLabel = which === "platform" ? "All integrations" : "All areas";
    host.querySelectorAll(".msopt").forEach((o) =>
      o.classList.toggle("on", set.has(o.dataset.v)));
    host.querySelector(".mslabel").textContent =
      set.size === 0 ? allLabel : set.size === 1 ? [...set][0] : `${set.size} selected`;
    host.classList.toggle("active", set.size > 0);
    const panel = host.querySelector(".mspanel");
    panel._sig = this._optionValues(which).join("|") + "::" + [...set].sort().join(",");
  }

  /* Clicking a value in the Integration or Area column is the same action as
     ticking it in that column's dropdown — same Set, so the menu shows it checked
     and the button label updates. Clicking it again removes it, which is what a
     toggle that looks like a chip is expected to do. */
  _toggleFilter(which, value) {
    const set = { platform: this._platforms, area: this._areas,
                  status: this._statuses, quality: this._qualities }[which];
    if (!set) return;
    set.has(value) ? set.delete(value) : set.add(value);
    this._sig = "";
    this._paintFilters();
    this._paintTable();
  }

  /* Put the top of the table under the toolbar, and nothing else off screen.
   *
   * The previous version called scrollIntoView on the column header, which is
   * `position: sticky`. Scrolling a sticky element into view aligns it to the
   * viewport top — behind Home Assistant's 56px toolbar — and drags everything
   * above it (tabs, search, the two dropdowns) off screen, while the first row
   * ends up underneath the header that just re-stuck. Hence "it hides the header,
   * the dropdowns and the first item".
   *
   * So anchor on the TABS instead and compute the offset by hand: the tab strip
   * lands just below the toolbar, and tabs → filters → column header → first row
   * are all visible, which is the whole point of scrolling there.
   */
  _scrollToTable() {
    /* Measure the NON-sticky body, never the header block. A sticky element
       reports its STUCK rect once it has pinned, so anchoring on it lands the
       scroll wherever it already is — which is how the old version buried the
       tabs and the first row. Target: first row sits just under the pinned block,
       pinned block sits just under HA's toolbar. */
    const head = this.shadowRoot.querySelector(".stickyhead");
    const thead = this.shadowRoot.querySelector(".thead");
    const body = this.shadowRoot.querySelector(".tbody");
    if (!head || !thead || !body) return;
    const scroller = document.scrollingElement || document.documentElement;
    // The column row is the lowest pinned layer, so where it pins (its used
    // `top`, which already includes HA's toolbar and the header block above it
    // when that is sticky) plus its own height is where the first row must land.
    const pinnedTo = (parseFloat(getComputedStyle(thead).top) || 0) + thead.offsetHeight;
    const top = scroller.scrollTop + body.getBoundingClientRect().top - pinnedTo - 12;
    scroller.scrollTo({
      top: Math.max(0, top),
      behavior: reduceMotion() ? "auto" : "smooth",
    });
  }

  /* Publish where Home Assistant's own toolbar ends, as --hm-top, for the sticky
     layers to pin under. Measured from the element, never read from
     --header-height: kiosk-mode hides the header (and publishes its own
     --kiosk-header-height: 0) but leaves --header-height at 56px, so the block
     pinned 56px down with rows scrolling through the empty band above it. The
     measured bottom also includes the safe-area inset the header adds on an
     iPhone, which --header-height does not. Hidden header → 0, and the CSS
     floors that at the safe-area inset so nothing pins under the status bar.
     The ResizeObserver watches the BORDER box: hiding sets display:none (size 0)
     and a rotation changes the inset, which is padding, not content. */
  _trackHaHeader() {
    let hdr = null;
    for (let n = this, i = 0; n && i < 40; i++) {
      const host = n.getRootNode()?.host;
      if (!host) break;
      if (host.localName === "hui-root") { hdr = host.shadowRoot?.querySelector(".header"); break; }
      n = host;
    }
    this._hdrRo?.disconnect();
    this._hdr = hdr;
    // Not inside a dashboard view (card editor preview): keep the CSS fallback.
    if (!hdr) { this.style.removeProperty("--hm-top"); return; }
    const measure = () => {
      const r = hdr.getBoundingClientRect();
      const shown = r.height > 0 && getComputedStyle(hdr).display !== "none";
      this.style.setProperty("--hm-top", `${shown ? Math.max(0, Math.round(r.bottom)) : 0}px`);
    };
    this._hdrRo = new ResizeObserver(measure);
    this._hdrRo.observe(hdr, { box: "border-box" });
    measure();
  }

  _goPage(n) {
    const total = Math.max(1, Math.ceil(this._matching / this._pageSize));
    const next = Math.min(Math.max(0, n), total - 1);
    if (next === this._page) return;
    this._page = next;
    this._open = null;          // the open row is not on this page any more
    this._sig = "";
    this._paintTable();
    // Put the reader at the top of the new page rather than wherever the old one
    // happened to leave them.
    this._scrollToTable();
  }

  _setView(view, sort) {
    // "Unavailable"/"Low battery"/"Poor" only mean something inside the tab that
    // offers them, so carrying one across a tab change can only hide everything.
    if (view !== this._view) { this._statuses.clear(); this._qualities.clear(); }
    this._view = view;
    this.shadowRoot.querySelectorAll(".vw").forEach((x) =>
      x.classList.toggle("on", x.dataset.v === view));
    this._sort = sort || (
      view === "battery" ? { col: "battery", dir: "asc" }
      : view === "signal" ? { col: "rssi", dir: "asc" }
      : { col: "status", dir: "asc" });
    // Column sets differ per view; a sort on a column this view does not have
    // would silently do nothing.
    if (!COLUMNS[view].some((c) => c.id === this._sort.col)) {
      this._sort = { col: "status", dir: "asc" };
    }
    this._open = null;
    this._sig = "";
  }

  _closeMenus() {
    this.shadowRoot?.querySelectorAll(".ms.open").forEach((m) => m.classList.remove("open"));
  }

  _optionValues(which) {
    const key = which === "platform" ? "platform" : "area";
    return [...new Set(this._data.rows.map((r) => r[key]))].sort((a, b) => a.localeCompare(b));
  }

  // ----------------------------------------------------------------- paint

  _paint() {
    const d = this._data;
    const issues = d.offline + d.lowBattery + d.poorSignal + d.stale;

    /* "1 Offline" does not say offline WHAT. Devices and helpers are now separate
       tabs, so a bare problem count is genuinely ambiguous — and it hides whether
       the other kind is affected at all. Each problem tile therefore carries the
       device/helper split, and the count is derived from the same rows rather than
       from the integration's group totals, so the tile and the tab can never
       disagree about what they are counting. */
    /* Each tile is a pair: how many are bad, out of how many are watched. The
       denominator is drawn from the same rows the tabs filter, so a tile can never
       disagree with the table it links to. */
    const devices = d.rows.filter(isDevice);
    const helpers = d.rows.filter((r) => !isDevice(r));
    const withBattery = d.rows.filter((r) => r.battery !== null);
    const withSignal = d.rows.filter((r) => r.rssi !== null);
    const pair = {
      devices: { bad: devices.filter((r) => r.offline).length, total: devices.length },
      // A helper is a problem when it is down OR its latest run failed.
      helpers: { bad: helpers.filter((r) => r.offline || r.failed).length, total: helpers.length },
      battery: { bad: withBattery.filter((r) => r.lowBattery).length, total: withBattery.length },
      signal: { bad: withSignal.filter((r) => r.poorSignal).length, total: withSignal.length },
    };
    this._pair = pair;

    for (const s of STATS) {
      // Hide a tile whose check is switched off: it could only ever read zero,
      // which looks like a clean bill of health for something nobody is watching.
      const tile = this._el[`t_${s.id}`].parentElement.parentElement;
      const on = !s.needs || d.features[s.needs];
      if (tile.hidden !== !on) tile.hidden = !on;
      if (!on) continue;

      const { bad, total } = pair[s.id];
      const big = this._el[`t_${s.id}`];
      const den = this._el[`d_${s.id}`];
      const lab = this._el[`s_${s.id}`];

      big.textContent = bad > 0 ? bad : total;
      den.textContent = bad > 0 ? `/ ${total}` : "";
      lab.textContent = bad > 0 ? s.bad : s.ok;

      big.style.color = bad > 0 ? s.tone : "";
      lab.style.color = bad > 0 ? s.tone : "";
      tile.style.setProperty("--tc", s.tone);
      tile.classList.toggle("hot", bad > 0);

      const key = `${bad}/${total}`;
      if (big._k !== key) {
        big._k = key;
        if (!reduceMotion()) {
          big.animate(
            [{ transform: "translateY(-4px) scale(.94)", opacity: 0 },
             { transform: "none", opacity: 1 }],
            { duration: 320, easing: IOS_SOFT }
          );
        }
      }
    }
    this._paintFilters();
    this._paintTable();
  }

  _paintFilters() {
    for (const [host, which, allLabel] of [
      [this._el.msPlatform, "platform", "All integrations"],
      [this._el.msArea, "area", "All areas"],
    ]) {
      const set = which === "platform" ? this._platforms : this._areas;
      const values = this._optionValues(which);
      const counts = {};
      for (const r of this._data.rows) counts[r[which]] = (counts[r[which]] || 0) + 1;

      host.querySelector(".mslabel").textContent =
        set.size === 0 ? allLabel
        : set.size === 1 ? [...set][0]
        : `${set.size} selected`;
      host.classList.toggle("active", set.size > 0);

      const sig = values.join("|") + "::" + [...set].sort().join(",");
      const panel = host.querySelector(".mspanel");
      if (panel._sig === sig) continue;
      panel._sig = sig;
      panel.innerHTML =
        `<div class="msacts">
           <button class="msact" data-a="all">Select all</button>
           <button class="msact" data-a="none">Clear</button>
         </div>` +
        values
          .map((v) => `<button class="msopt${set.has(v) ? " on" : ""}" data-v="${escapeHtml(v)}">
              <span class="box"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span>
              <span class="msname">${escapeHtml(v)}</span>
              <span class="mscount">${counts[v] || 0}</span></button>`)
          .join("");
    }
  }

  _paintTable() {
    const cols = COLUMNS[this._view];
    const all = this._visible();
    const grid = cols.map((c) => c.w).join(" ") + " 74px";

    /* Reset to page 1 whenever the SCOPE changes. Centralised here because a page
       number that survives a filter change silently strands you on an empty page. */
    const scope = this._view + this._sort.col + this._sort.dir +
      [...this._platforms].sort().join(",") + [...this._areas].sort().join(",") + this._q;
    if (scope !== this._scope) { this._scope = scope; this._page = 0; }

    this._matching = all.length;
    const pages = Math.max(1, Math.ceil(all.length / this._pageSize));
    if (this._page > pages - 1) this._page = pages - 1;
    const from = this._page * this._pageSize;
    const rows = all.slice(from, from + this._pageSize);

    const headSig = this._view + JSON.stringify(this._sort);
    if (this._el.thead._sig !== headSig) {
      this._el.thead._sig = headSig;
      this._el.thead.style.gridTemplateColumns = grid;
      this._el.thead.innerHTML =
        cols.map((c) => {
          const on = this._sort.col === c.id;
          return `<button class="th t-label${on ? " on" : ""}${c.align === "right" ? " r" : ""}" data-c="${c.id}">
                    <span>${c.label}</span><span class="ar">${on ? (this._sort.dir === "asc" ? "▲" : "▼") : ""}</span></button>`;
        }).join("") + `<span></span>`;
      this._el.thead.querySelectorAll(".th").forEach((b) => {
        b.addEventListener("click", () => {
          const c = b.dataset.c;
          this._sort = this._sort.col === c
            ? { col: c, dir: this._sort.dir === "asc" ? "desc" : "asc" }
            : { col: c, dir: "asc" };
          this._paintTable();
        });
      });
    }

    const sig = scope + this._page + "|" +
      rows.map((r) => `${r.id}${r.offline}${r.lowBattery}${r.poorSignal}${r.battery}${r.rssi}${r.failed}`).join("|");
    if (sig === this._sig) return;
    this._sig = sig;

    this._reconcile(rows, cols, grid);

    this._el.pager.style.display = pages > 1 ? "" : "none";
    this._el.pgPrev.disabled = this._page === 0;
    this._el.pgNext.disabled = this._page >= pages - 1;
    this._el.pgText.textContent = `${this._page + 1} of ${pages}`;
    this._el.tfoot.textContent = all.length
      ? `Showing ${from + 1}–${from + rows.length} of ${all.length} · ` +
        `${this._data.entities} entities monitored`
      : `${this._data.entities} entities monitored`;
  }

  /* Keyed reconcile with FLIP.
   *
   * Rebuilding the list's innerHTML on every filter or tab change is what made it
   * flash: every row was destroyed and recreated from opacity 0, so the whole
   * table blanked for a frame no matter how the entry animation was tuned. On iOS
   * a filtered list never blanks — the rows that survive stay on screen and glide
   * to their new place, the ones that go fade out, the new ones fade in.
   *
   * So rows are keyed by entity id and reused: survivors keep their DOM node (and
   * therefore their pixels), get their cells patched only if the markup actually
   * changed, and are moved with FLIP — measure before, measure after, apply the
   * inverse transform, then animate it away.
   *
   * Only rows near the viewport are animated. Choreographing 280 rows the user
   * cannot see costs real frames and buys nothing.
   */
  _reconcile(rows, cols, grid) {
    const body = this._el.tbody;

    if (!rows.length) {
      if (!body._empty) {
        body.innerHTML = `<div class="none">No devices match these filters</div>`;
        body._empty = true;
        if (!reduceMotion()) body.firstElementChild.animate(
          [{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }],
          { duration: 320, easing: IOS }
        );
      }
      return;
    }
    if (body._empty) { body.innerHTML = ""; body._empty = false; }

    const near = (top) => top > -320 && top < window.innerHeight + 320;
    const existing = new Map();
    for (const el of body.children) if (el.dataset.rowid) existing.set(el.dataset.rowid, el);

    // FIRST: where the survivors are now.
    const before = new Map();
    for (const [id, el] of existing) before.set(id, el.getBoundingClientRect().top);

    const wanted = new Set(rows.map((r) => r.id));
    const entering = [];

    for (const r of rows) {
      let w = existing.get(r.id);
      if (!w) { w = this._makeRow(r); entering.push(w); }
      this._fillRow(w, r, cols, grid);
      body.appendChild(w);           // append in order == reorder, cheaply
    }

    // Exits. Take them out of flow first so the survivors' FLIP measures the
    // final layout, not one that still includes rows on their way out.
    const leaving = [...existing].filter(([id]) => !wanted.has(id)).map(([, el]) => el);
    for (const el of leaving) {
      const top = el.getBoundingClientRect().top;
      el.remove();
      if (!near(top) || leaving.length > 30 || reduceMotion()) continue;
      const ghost = el;
      ghost.style.position = "absolute";
      ghost.style.pointerEvents = "none";
      ghost.style.width = `${body.clientWidth}px`;
      ghost.style.top = `${top + body.scrollTop - body.getBoundingClientRect().top}px`;
      body.appendChild(ghost);
      ghost.animate(
        [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px) scale(.985)" }],
        { duration: 220, easing: IOS }
      ).onfinish = () => ghost.remove();
    }

    // LAST + INVERT + PLAY for everything that stayed.
    let flipped = 0;
    for (const [id, el] of existing) {
      if (!wanted.has(id)) continue;
      const wasTop = before.get(id);
      const nowTop = el.getBoundingClientRect().top;
      const dy = wasTop - nowTop;
      if (Math.abs(dy) < 1 || !near(nowTop) || flipped > 60 || reduceMotion()) continue;
      flipped++;
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: 420, easing: IOS }
      );
    }

    // Enters, stagger only what is on screen.
    let staged = 0;
    for (const el of entering) {
      if (reduceMotion()) break;
      const top = el.getBoundingClientRect().top;
      if (!near(top)) continue;
      el.animate(
        [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
        { duration: 380, easing: IOS, delay: Math.min(staged++, 14) * 22, fill: "backwards" }
      );
    }
  }

  _makeRow(r) {
    const w = document.createElement("div");
    w.className = "trwrap";
    w.dataset.rowid = r.id;
    const tr = document.createElement("div");
    tr.className = "tr";
    tr.dataset.id = r.id;
    w.appendChild(tr);
    return w;
  }

  /* Patch a row in place, and only when its markup actually differs. A background
     data tick usually changes nothing, and writing identical innerHTML would still
     destroy and rebuild the row's children — the cheapest way to make a list flash. */
  _fillRow(w, r, cols, grid) {
    const tr = w.firstElementChild;
    const { text: statusText, tone } = statusOf(r, this._view);
    const cell = (c) => {
      switch (c.id) {
        case "name":
          return `<span class="nm"><span class="dot" style="--c:${tone}"></span>
                    <span class="nmt"><b>${escapeHtml(r.name)}</b>
                    <i>${r.members.length > 1 ? r.members.length + " entities" : escapeHtml(r.id)}</i></span></span>`;
        case "platform":
          return `<button class="tag${this._platforms.has(r.platform) ? " on" : ""}" data-f="platform" data-v="${escapeHtml(r.platform)}"
                    title="Filter by ${escapeHtml(r.platform)}">${escapeHtml(r.platform)}</button>`;
        case "area":
          return `<button class="tag${this._areas.has(r.area) ? " on" : ""}" data-f="area" data-v="${escapeHtml(r.area)}"
                    title="Filter by ${escapeHtml(r.area)}">${escapeHtml(r.area)}</button>`;
        case "status":
          return `<button class="tag stt${this._statuses.has(statusText) ? " on" : ""}"
                    data-f="status" data-v="${escapeHtml(statusText)}" style="--c:${tone}"
                    title="Filter by ${escapeHtml(statusText)}">${statusText}</button>`;
        case "battery": return batteryCell(r.battery);
        case "rssi": return signalCell(r.rssi, r.unit, r.quality);
        case "quality": {
          if (!r.quality) return `<span class="muted">—</span>`;
          return `<button class="tag stt${this._qualities.has(r.quality) ? " on" : ""}"
                    data-f="quality" data-v="${escapeHtml(r.quality)}" style="--c:${qualityTone(r.quality)}"
                    title="Filter by ${escapeHtml(r.quality)} signal">${r.quality}</button>`;
        }
        case "lastSeen": return `<span class="muted">${lastSeenOf(r, this._hass)}</span>`;
        default: return "";
      }
    };
    const open = this._open === r.id;
    const html =
      cols.map((c) => `<span class="td${c.align === "right" ? " r" : ""}">${cell(c)}</span>`).join("") +
      `<span class="td acts">
         <button class="iconbtn info" data-info="${escapeHtml(r.id)}"
                 title="${r.deviceId ? "Device settings" : "Entity settings"}">
           <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>
         </button>
         <span class="chev${open ? " up" : ""}"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span>
       </span>`;

    if (tr.style.gridTemplateColumns !== grid) tr.style.gridTemplateColumns = grid;
    if (tr._html !== html) {
      // Columns change wholesale on a tab switch; cross-fade the contents so the
      // swap reads as the same row changing subject, not as a new row.
      const swapping = tr._html !== undefined && tr._cols !== cols.length;
      tr._html = html;
      tr.innerHTML = html;
      if (swapping && !reduceMotion()) {
        tr.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: IOS });
      }
    }
    tr._cols = cols.length;
    tr.classList.toggle("open", open);
  }

  /* Jump to where the thing can actually be CHANGED. A health view's most common
     finding is "this device has no area", and neither this card nor the more-info
     dialog can fix that — the device page can. Entities with no device (automations,
     scripts, helpers) have no device page, so they get more-info, which is where
     their settings live. */
  _openSettings(rowId) {
    const row = this._data.rows.find((r) => r.id === rowId);
    if (!row) return;
    if (row.deviceId) {
      history.pushState(null, "", `/config/devices/device/${row.deviceId}`);
      this.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
      return;
    }
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: row.id }, bubbles: true, composed: true }));
  }

  _toggle(id) {
    const body = this._el.tbody;
    const wasOpen = this._open === id;

    const prevDetail = body.querySelector(".detail");
    if (prevDetail) this._collapseDetail(prevDetail);
    body.querySelector(".tr.open")?.classList.remove("open");
    body.querySelector(".chev.up")?.classList.remove("up");

    this._open = wasOpen ? null : id;
    if (!this._open) return;

    const row = body.querySelector(`.tr[data-id="${id}"]`);
    if (!row) return;
    row.classList.add("open");
    row.querySelector(".chev")?.classList.add("up");

    const detail = document.createElement("div");
    detail.className = "detail";
    detail.innerHTML = `<div class="detailBody" id="detailBody"><div class="loading">Loading history…</div></div>`;
    row.parentElement.appendChild(detail);
    this._expandDetail(detail);
    this._renderDetail(this._open);
  }

  /* The panel has no height until it has content, and its content arrives twice —
     a loading line, then the chart. Both transitions are animated from the height
     it currently has to the height it wants, so it never jumps. */
  _expandDetail(detail) {
    if (reduceMotion()) return;
    const to = detail.scrollHeight;
    detail.style.overflow = "hidden";
    detail._anim?.cancel();
    detail._anim = detail.animate(
      [{ height: "0px", opacity: 0 }, { height: `${to}px`, opacity: 1 }],
      { duration: 420, easing: IOS }
    );
    detail._anim.onfinish = () => { detail.style.height = "auto"; detail.style.overflow = ""; };
  }

  _collapseDetail(detail) {
    if (reduceMotion()) { detail.remove(); return; }
    const from = detail.offsetHeight;
    detail.style.overflow = "hidden";
    detail._anim?.cancel();
    detail._anim = detail.animate(
      [{ height: `${from}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
      { duration: 300, easing: IOS }
    );
    detail._anim.onfinish = () => detail.remove();
  }

  /* Called after the detail's inner HTML is swapped for real content: grow from
     whatever height the placeholder had to the height the content needs. */
  _resizeDetail(detail, from) {
    if (reduceMotion()) return;
    detail.style.overflow = "hidden";
    const to = detail.scrollHeight;
    if (Math.abs(to - from) < 2) { detail.style.overflow = ""; return; }
    detail._anim?.cancel();
    detail._anim = detail.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 380, easing: IOS }
    );
    detail._anim.onfinish = () => { detail.style.height = "auto"; detail.style.overflow = ""; };
  }

  _renderDetail(id) {
    const row = this._data.rows.find((r) => r.id === id);
    if (row) this._loadDetail(row);
  }


  // ---------------------------------------------------------------- charts

  _drawOverview() {
    const host = this._el?.overview;
    if (!host || !this._overview) return;
    const { res, ids, start, end } = this._overview;
    const W = host.clientWidth || 700;
    const H = 190;
    // Equal side margins so the plotted area sits centred in the card. The left
    // used to be 42 (axis labels) against a right of 10, which pushed the whole
    // chart visibly off to one side.
    const P = { l: 32, r: 32, t: 10, b: 30 };
    const plotW = W - P.l - P.r;

    /* One bar per ~14px. Raw recorder samples are far denser than the pixels
       available — a count sitting on a threshold flips on nearly every sample
       (measured 289 flips in 290 over 24h) — so each bar holds the MAXIMUM of its
       slice. Max, never a mean: for a problem count you want "at worst, N were
       broken in this window", and averaging can smooth a real spike away. */
    /* Width per time slot scales with the number of series on screen, so a bar
       never drops below ~6px however many are shown. Fewer, fatter slots read as
       bars; the old fixed 14px slot gave 46 groups and the bars fused into a
       solid block. */
    const nSeries = Math.max(1, [0, 1, 2].filter((k) => this._series.has(k)).length);
    const buckets = Math.max(10, Math.min(60, Math.round(plotW / (13 + 6 * nSeries))));
    const series = ids.map((id, k) => ({
      color: [COL.bad, COL.battery, COL.signal][k],
      name: ["Unavailable", "Low battery", "Weak signal"][k],
      pts: bucketMax(res[id] || [], start, end, buckets),
    }));

    /* GROUPED, the way Grafana draws a multi-series bar chart: every series is
       anchored at ZERO and the series sit SIDE BY SIDE inside each time slot.
       Not stacked (only the bottom series would be anchored, the rest float) and
       not overlaid (weak-signal sits at a near-constant 5 while unavailable is 1,
       so the tall series simply painted over the short one and the plot read as
       one filled block). Side by side, each bar answers its own question and
       toggling a series off just widens the remaining ones. */
    const shown = series.filter((s, k) => this._series.has(k));
    const max = Math.max(1, ...shown.flatMap((s) => s.pts.map((p) => p.v)));
    const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
    const slot = plotW / buckets;
    const pad = Math.max(2, slot * 0.2);          // gap between time slots
    const inner = Math.min(2, slot * 0.03);       // gap between bars of one slot
    const n = shown.length || 1;
    const bw = Math.max(2, (slot - pad - inner * (n - 1)) / n);

    const grid = niceTicks(max)
      .map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="${COL.grid}"/>
        <text x="${P.l - 8}" y="${y(v) + 5}" class="ax" text-anchor="end">${v}</text>`).join("");

    const hours = (end - start) / 3600e3;
    const step = hours <= 6 ? 1 : hours <= 24 ? 4 : hours <= 72 ? 12 : 24;
    const marks = [];
    const d0 = new Date(start); d0.setMinutes(0, 0, 0);
    const xt = (t) => P.l + ((t - start) / (end - start)) * plotW;
    for (let t = d0.getTime(); t <= end; t += step * 3600e3) {
      if (t < start) continue;
      marks.push(`<line x1="${xt(t)}" x2="${xt(t)}" y1="${P.t}" y2="${H - P.b}" stroke="${COL.grid}"/>
        <text x="${xt(t)}" y="${H - 9}" class="ax" text-anchor="middle">${fmtTick(new Date(t), step)}</text>`);
    }

    const base = H - P.b;
    const groupW = bw * n + inner * (n - 1);
    const bars = [];
    for (let i = 0; i < buckets; i++) {
      const gx = P.l + i * slot + (slot - groupW) / 2;
      const when = new Date(start.getTime() + (i + 0.5) * ((end - start) / buckets));
      shown.forEach((s, j) => {
        const v = s.pts[i] ? s.pts[i].v : 0;
        if (!v) return;
        // Floor of 3px: on a tall axis a single problem would otherwise round
        // away to nothing, and one device down is exactly what must be visible.
        const h = Math.max(3, (v / max) * (H - P.t - P.b));
        bars.push(
          `<rect class="cbar" x="${(gx + j * (bw + inner)).toFixed(1)}" y="${(base - h).toFixed(1)}" ` +
          `width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, bw / 3).toFixed(1)}" ` +
          `fill="${s.color}" style="--d:${i * 6}ms">` +
          `<title>${when.toLocaleString()}\n${s.name}: ${v}</title></rect>`
        );
      });
    }

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      ${grid}${marks.join("")}${bars.join("")}</svg>`;
  }

  /* The availability timeline is drawn by state-history-card (our fork under
     www/state-history-card) instead of a bespoke SVG. Two reasons: it is the one
     state visualisation used across these dashboards, so state reads the same
     everywhere; and it carries an entity-label column beside each track, which
     the old SVG had no room for — the rows were anonymous bands. */
  _drawTimeline(box, row, res, log, start, end) {
    const ids = row.members.filter((m) => (res[m] || []).length);

    const events = (log || []).slice(-14).reverse().map((e) => {
      const bad = e.state === "unavailable" || e.state === "unknown";
      return `<li><span class="logdot" style="--c:${bad ? COL.bad : COL.ok}"></span>
        <span class="lgt">${new Date((e.when || 0) * 1000).toLocaleString()}</span>
        <span class="lgm">${escapeHtml(e.name || row.name)} \u2192 <b>${escapeHtml(e.state || "")}</b></span></li>`;
    }).join("");

    /* Reserve the final height up front. The embedded card fetches its own
       history, so without this the panel animates open to an empty box and then
       jumps when the data lands. Must track the row metrics set in CSS. */
    const reserved = Math.max(1, ids.length) * (SHC_ROW_H + SHC_ROW_GAP) + 30;

    box.innerHTML = `${this._runBlock(row)}
      <div class="dhead">Availability \u00b7 ${escapeHtml(row.name)}
        <span class="dsub">${ids.length} ${ids.length === 1 ? "entity" : "entities"}</span></div>
      <div class="shc" id="shc" style="min-height:${reserved}px"></div>
      ${events ? `<div class="dhead sm">Logbook</div><ul class="log">${events}</ul>`
               : `<div class="loading">No state changes in this window.</div>`}`;

    this._mountHistory(box.querySelector("#shc"), row, ids, start, end);
  }

  /* The latest run of an automation or script, as the integration read it from HA's
     traces: when it ran, whether it failed and why, and a jump to that run's trace.
     Above the availability timeline because for a job it is the more direct answer. */
  _runBlock(row) {
    if (!isJob(row)) return "";
    const st = this._hass?.states?.[row.id];
    const ran = st?.attributes?.last_triggered;
    const item = (tone, when, msg) =>
      `<li><span class="logdot" style="--c:${tone}"></span>
         <span class="lgt">${when}</span><span class="lgm">${msg}</span></li>`;
    let items;
    if (row.failed && row.run) {
      items = item(COL.bad, ago(row.run.finished), "<b>Failed</b>") +
        (row.run.error
          ? `<li class="jobmsg" style="--c:${COL.bad}">${escapeHtml(row.run.error)}</li>` : "");
    } else {
      items = item(ran ? COL.ok : COL.stale, ran ? ago(ran) : "never",
                   ran ? "<b>Finished</b> without errors" : "No run recorded");
    }
    // The failed run's own trace when there is one, else the item's trace list, which
    // opens on its newest run.
    let url = row.failed && row.run?.trace_url;
    if (!url) {
      const itemId = row.id.startsWith("automation.") ? st?.attributes?.id : row.id.split(".")[1];
      if (itemId) url = `/config/${row.id.split(".")[0]}/trace/${itemId}`;
    }
    return `<div class="dhead">Last run
        ${url ? `<button class="navbtn" data-nav="${escapeHtml(url)}">Open trace</button>` : ""}</div>
      <ul class="log">${items}</ul>`;
  }

  async _mountHistory(host, row, ids, start, end) {
    this._shc = null;
    if (!host) return;
    if (!ids.length) {
      host.innerHTML = `<div class="loading">No recorded history in this window.</div>`;
      host.style.minHeight = "";
      return;
    }
    if (!(await whenDefined("state-history-card", 5000))) {
      host.innerHTML = `<div class="loading">state-history-card is not loaded as a dashboard resource.</div>`;
      host.style.minHeight = "";
      return;
    }
    if (!host.isConnected) return;   // row was collapsed while we waited

    /* Every member of a row belongs to the same device, so each friendly name
       repeats the device name. Strip it so the label column reads "Power", not
       "Studio Heater Power" fourteen times. */
    const prefix = row.baseName.toLowerCase();
    const el = document.createElement("state-history-card");
    el.setConfig({
      type: "custom:state-history-card",
      hours_to_show: Math.max(1, Math.round((end - start) / 3600e3)),
      refresh_interval: 900,
      legend: "off",
      timestamps: "on",
      labels: "off",
      // Health semantics: red is "not reporting", everything else is fine. The
      // default_color option (added to the fork for this) stops unmapped states
      // — every distinct temperature, every dimmer level — hashing to a rainbow.
      state_colors: { unavailable: COL.bad, unknown: COL.bad },
      default_color: COL.ok,
      entities: ids.map((m) => {
        const fn = this._hass.states[m]?.attributes?.friendly_name || m;
        const short = fn.toLowerCase().startsWith(prefix)
          ? fn.slice(row.baseName.length).replace(/^[\s:\u2013-]+/, "")
          : fn;
        return { entity: m, name: short || fn };
      }),
    });
    el.hass = this._hass;
    host.replaceChildren(el);
    this._shc = el;
  }

  _drawSeries(box, row, target, hist, start, end) {
    const pts = hist
      .map((h) => ({ t: (h.lu ?? h.last_updated ?? 0) * 1000, v: Number(h.s ?? h.state) }))
      .filter((p) => Number.isFinite(p.v) && p.t);
    const samples = pts.length;
    const W = box.clientWidth || 700;
    const H = 210;
    const P = { l: 48, r: 12, t: 12, b: 30 };
    const name = this._hass.states[target]?.attributes?.friendly_name || target;
    const label = this._view === "battery" ? "Battery" : "Signal";

    if (!samples) {
      box.innerHTML = `<div class="dhead">${label} · ${escapeHtml(row.name)}
        <span class="dsub">${escapeHtml(name)}</span></div>
        <div class="loading">No recorded history for this sensor in this window.</div>`;
      return;
    }

    // A value that has not changed in the window comes back as ONE sample. Carry it
    // to both edges so it draws as the flat line it actually was, not a lone dot.
    if (pts[0].t > start.getTime()) pts.unshift({ t: start.getTime(), v: pts[0].v });
    const lastPt = pts[pts.length - 1];
    if (lastPt.t < end.getTime()) pts.push({ t: end.getTime(), v: lastPt.v });

    const vs = pts.map((p) => p.v);
    let lo, hi;
    if (this._view === "battery") {
      lo = 0; hi = 100;   // fixed axis keeps every device's battery chart comparable
    } else {
      lo = Math.min(...vs); hi = Math.max(...vs);
      if (lo === hi) { lo -= 5; hi += 5; }
      const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    }
    const x = (t) => P.l + ((t - start) / (end - start)) * (W - P.l - P.r);
    const y = (v) => H - P.b - ((v - lo) / (hi - lo)) * (H - P.t - P.b);

    const ticks = this._view === "battery" ? [0, 20, 50, 100]
      : [lo + (hi - lo) * 0.05, (lo + hi) / 2, hi - (hi - lo) * 0.05];
    const grid = ticks.map((v) =>
      `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="${COL.grid}"/>
       <text x="${P.l - 9}" y="${y(v) + 5}" class="ax" text-anchor="end">${Math.round(v)}</text>`).join("");

    // Step line: sampled readings hold until the next one, so interpolating would
    // draw a slope that never happened.
    let line = "";
    pts.forEach((p, i) => {
      if (!i) { line += `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`; return; }
      line += `L${x(p.t).toFixed(1)},${y(pts[i - 1].v).toFixed(1)}L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    });
    const area = `${line}L${x(pts[pts.length - 1].t).toFixed(1)},${H - P.b}L${x(pts[0].t).toFixed(1)},${H - P.b}Z`;
    const c = this._view === "battery" ? COL.battery : COL.signal;
    const last = pts[pts.length - 1];

    box.innerHTML = `
      <div class="dhead">${label} · ${escapeHtml(row.name)}
        <span class="dsub">${escapeHtml(name)}</span></div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
        ${grid}
        <path d="${area}" fill="${c}" opacity=".14"/>
        <path d="${line}" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round" class="spark"/>
        <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4.5" fill="${c}"/>
      </svg>
      <div class="dstats">
        <span>now <b>${last.v}${this._view === "battery" ? "%" : " " + (row.unit || "dBm")}</b></span>
        <span>min <b>${Math.min(...vs)}</b></span>
        <span>max <b>${Math.max(...vs)}</b></span>
        <span>${samples} ${samples === 1 ? "sample" : "samples"}</span>
        <button class="more" data-e="${escapeHtml(target)}">Open entity</button>
      </div>`;
    /* Dash the line to its OWN measured length so the whole stroke is painted,
       then animate the reveal from that same number. Resting state is set first
       and unconditionally: if the animation never runs, the line is still whole. */
    const path = box.querySelector(".spark");
    if (path) {
      const len = Math.ceil(path.getTotalLength());
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = "0";
      if (!reduceMotion()) {
        path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
                     { duration: 1150, easing: IOS });
      }
    }

    box.querySelector(".more")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: target }, bubbles: true, composed: true }));
    });
  }
}

// ------------------------------------------------------------------ helpers

/* Reduce raw recorder samples to `n` evenly spaced buckets, each holding the
   maximum seen in it. Empty buckets inherit the previous value — a count with no
   new sample has not changed, it simply was not written again. */
function bucketMax(hist, start, end, n) {
  const t0 = start.getTime();
  const span = end.getTime() - t0;
  if (span <= 0 || !hist.length) return [];
  const width = span / n;
  const max = new Array(n).fill(null);
  let first = null;
  for (const h of hist) {
    const t = (h.lu ?? h.last_updated ?? 0) * 1000;
    const v = Number(h.s ?? h.state);
    if (!Number.isFinite(v) || !t) continue;
    if (first === null) first = v;
    const i = Math.min(n - 1, Math.max(0, Math.floor((t - t0) / width)));
    max[i] = max[i] === null ? v : Math.max(max[i], v);
  }
  if (first === null) return [];
  const pts = [];
  let carry = first;
  for (let i = 0; i < n; i++) {
    if (max[i] !== null) carry = max[i];
    pts.push({ t: t0 + i * width, v: carry });
  }
  pts.push({ t: end.getTime(), v: carry });
  return pts;
}

function stepPoints(hist, start, end) {
  const pts = [];
  let prev = null;
  for (const h of hist) {
    const t = (h.lu ?? h.last_updated ?? 0) * 1000;
    const v = Number(h.s ?? h.state);
    if (!Number.isFinite(v) || !t) continue;
    if (prev !== null) pts.push({ t, v: prev });
    pts.push({ t, v });
    prev = v;
  }
  if (!pts.length) return [];
  if (pts[0].t > start) pts.unshift({ t: start.getTime(), v: pts[0].v });
  if (prev !== null) pts.push({ t: end.getTime(), v: prev });
  return pts;
}

function segments(hist, start, end) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    const t = (h.lu ?? h.last_updated ?? 0) * 1000;
    if (!t) continue;
    const next = hist[i + 1];
    const t2 = next ? (next.lu ?? next.last_updated ?? 0) * 1000 : end.getTime();
    out.push({
      from: Math.max(t, start.getTime()),
      to: Math.min(t2, end.getTime()),
      state: String(h.s ?? h.state ?? ""),
    });
  }
  return out.filter((s) => s.to > s.from);
}

function niceTicks(max) {
  if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i);
  const step = Math.ceil(max / 4);
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

function fmtTick(d, stepHours) {
  return stepHours >= 24 ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${String(d.getHours()).padStart(2, "0")}:00`;
}

function ago(iso) {
  if (!iso) return "—";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function batteryCell(v) {
  if (v === null) return `<span class="muted">—</span>`;
  const c = v <= 20 ? COL.bad : v <= 40 ? COL.battery : COL.ok;
  return `<span class="bar"><span class="barfill" style="width:${Math.max(3, v)}%;--c:${c}"></span></span>
          <b class="bv" style="color:${c}">${v}%</b>`;
}

function signalCell(v, unit, q) {
  if (v === null) return `<span class="muted">—</span>`;
  const c = qualityTone(q);
  const pct = Math.max(5, Math.min(100, ((v + 100) / 45) * 100));
  return `<span class="bar"><span class="barfill" style="width:${pct}%;--c:${c}"></span></span>
          <b class="bv" style="color:${c}">${v} ${escapeHtml(unit || "dBm")}</b>`;
}

/* Signal grading stays in the yellow family so it never reads as "low battery" or
   "offline": Poor is the full signal colour, OK is the same hue held back, Good is
   the healthy green. The word in the Quality column carries the exact grade. */
function qualityTone(q) {
  if (q === "Poor") return COL.signal;
  if (q === "OK") return `color-mix(in srgb, ${COL.signal} 62%, ${COL.ok})`;
  return COL.ok;
}

/* Row metrics for the embedded state-history-card. Shared by the CSS below and
   by the height the detail panel reserves before the card has loaded. */
const SHC_ROW_H = 26;
const SHC_ROW_GAP = 4;

/* customElements.whenDefined never rejects, so a missing dashboard resource
   would hang the detail pane forever. Race it against a deadline. */
function whenDefined(tag, ms) {
  if (customElements.get(tag)) return Promise.resolve(true);
  return Promise.race([
    customElements.whenDefined(tag).then(() => true),
    new Promise((r) => setTimeout(() => r(!!customElements.get(tag)), ms)),
  ]);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const STYLES = `
:host{display:block;
      /* Pin line for both sticky layers: the bottom of HA's toolbar as measured by
         _trackHaHeader (0 when kiosk-mode hides it), never above the safe area. */
      --hm-pin:max(var(--hm-top,var(--header-height,56px)),env(safe-area-inset-top,0px))}
ha-card{
  /* ---- TYPE SCALE: four roles, nothing else. -----------------------------
     Every piece of text in this card is exactly one of these. The previous
     version had a dozen ad-hoc size/weight/colour combinations, which reads as
     noise because nothing about a difference in weight meant anything.

       .t-title  21/700 primary    the card name. Once.
       .t-body   15/600 primary    anything you READ as data: names, values,
                                   controls, buttons.
       .t-meta   13/500 secondary  anything that QUALIFIES data: entity ids,
                                   areas, timestamps, counts, axis labels.
       .t-label  12/700 secondary  UPPERCASE structural labels: column headers,
                                   section headings.

     Colour is equally constrained: primary text, secondary text, or one status
     hue via --c. Status hue is reserved for state — never for decoration. */
  --fs-title: 21px;
  --fs-body: 15px;
  --fs-meta: 13px;
  --fs-label: 12px;

  --tap: 47px;
  --pad: 20px;
  --gap: 12px;

  --f: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --line: rgba(255,255,255,.09);
  --txt: var(--primary-text-color,#fff);
  --txt2: var(--secondary-text-color,#b0afaf);
  font-family:var(--f); overflow:visible;
  border-radius:var(--ha-card-border-radius,18px);
  background:var(--ha-card-background,#201b25);
  -webkit-font-smoothing:antialiased;
}

/* Each role lists every element that plays it. Adding a selector here is how a
   new element gets type — never by writing a one-off font-size somewhere below. */
.t-title,
.h1
  {font-size:var(--fs-title);font-weight:700;letter-spacing:-.3px;color:var(--txt)}

.t-body,
.nmt b, .st, .bv, .vw, .rg, .clear, .msbtn, .msopt, .more, .search input, .navbtn
  {font-size:var(--fs-body);font-weight:600;color:var(--txt)}

.t-meta,
.nmt i, .muted, .tag, .mscount, .msact, .dsub, .lgt, .lgm, .loading, .none, .jobmsg,
.tfoot, .summary, .legend span, .dstats span
  {font-size:var(--fs-meta);font-weight:500;color:var(--txt2)}

.t-label,
.th, .ptitle .phead, .dhead
  {font-size:var(--fs-label);font-weight:700;letter-spacing:.6px;
   text-transform:uppercase;color:var(--txt2)}
.ax{fill:var(--txt2);font-size:var(--fs-meta);font-family:var(--mono);opacity:.85}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}

/* header */
.top{display:flex;align-items:center;gap:var(--gap);
     padding:var(--pad) var(--pad) 14px;border-bottom:1px solid var(--line)}
.ranges{display:flex;gap:3px;background:rgba(255,255,255,.05);border-radius:11px;padding:3px}
.rg{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
    font-size:var(--fs-body);font-weight:600;min-width:54px;min-height:41px;padding:0 15px;
    border-radius:9px;color:var(--txt2);transition:color .26s ${IOS},background .26s ${IOS}}
.rg.on{background:rgba(255,255,255,.13);color:var(--txt)}

/* current status — iOS summary tiles */
.status{padding:16px var(--pad) 18px;border-bottom:1px solid var(--line)}
.summary{font-size:var(--fs-meta);font-weight:600;color:var(--c);
         text-transform:none;letter-spacing:0}
.tile[hidden]{display:none}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}
.tile{appearance:none;border:0;cursor:pointer;font-family:inherit;
      display:flex;flex-direction:column;align-items:flex-start;gap:3px;
      padding:14px 16px 13px;border-radius:16px;
      background:rgba(255,255,255,.055);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);
      transition:background .26s ${IOS},box-shadow .26s ${IOS}}
.tile:hover{background:rgba(255,255,255,.085)}
.tile:active{transform:scale(.965);transition:transform .12s ${IOS_SOFT}}
.tile.hot{background:color-mix(in srgb,var(--tc,#fff) 10%,rgba(255,255,255,.055))}
.tval{display:flex;align-items:baseline;gap:5px}
.tbig{font-size:31px;font-weight:700;letter-spacing:-1px;line-height:1.05;color:var(--txt)}
.tden{font-size:19px;font-weight:600;letter-spacing:-.4px;color:var(--txt)}
.tlab{font-size:var(--fs-meta);font-weight:600;color:var(--txt2);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}


/* overview */
.panel{padding:16px var(--pad) 8px;border-bottom:1px solid var(--line)}
.ptitle{display:flex;align-items:center;gap:var(--gap);
        margin-bottom:10px;flex-wrap:wrap}
.ptitle .legend{margin-left:auto}
.ptitle .ranges{margin-left:var(--gap)}
.legend{display:flex;align-items:center;gap:4px}
.lg{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
    font-size:var(--fs-meta);font-weight:500;color:var(--txt2);display:flex;align-items:center;
    padding:6px 10px;border-radius:9px;opacity:.42;
    transition:opacity .22s ${IOS},background .22s ${IOS},color .22s ${IOS}}
.lg.on{opacity:1;color:var(--txt)}
.lg:hover{background:rgba(255,255,255,.07)}
.lg:active{transform:scale(.94);transition:transform .12s ${IOS_SOFT}}
.lg i{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:7px;
      background:var(--c);box-shadow:inset 0 0 0 1px rgba(0,0,0,.28)}
.lg:not(.on) i{background:transparent;box-shadow:inset 0 0 0 2px var(--c)}
.chartwrap{min-height:172px}
/* NAME COLLISION HAZARD: .bar is ALSO the table's mini-bar SPAN (height:7px,
   far below). height is a real CSS geometry property on an SVG rect in Chrome,
   so that rule overrode the height ATTRIBUTE and every chart bar collapsed to a
   7px floating square. Chart rects are .cbar and must stay uniquely named. */
.cbar{transform-box:fill-box;transform-origin:50% 100%;
     animation:grow .55s ${IOS} backwards;animation-delay:var(--d,0ms)}
@keyframes grow{from{transform:scaleY(0)}to{transform:none}}
/* NO stroke-dasharray here. It used to be a hardcoded 2600 "long enough" guess with
   a CSS reveal animation, but dasharray CLIPS the stroke at that length: a step
   line spends length on every vertical jump AND scales with the plot width, so a
   jagged 24h series at 1233px measured 3099 and only 84% of it was ever painted
   (at wider cards / noisier sensors, ~67%). The geometry was always correct and
   always reached the right edge, which is why bbox checks kept saying it was
   fine. The dash is now measured from getTotalLength() in _drawSeries, and the
   RESTING state is a fully drawn line so it cannot depend on an animation. */
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* view tabs */
.views{display:flex;gap:4px;padding:12px var(--pad) 0;flex-wrap:wrap}
.vw{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
    font-size:var(--fs-body);font-weight:600;min-height:var(--tap);padding:0 18px;color:var(--txt2);
    border-bottom:3px solid transparent;position:relative;
    transition:color .3s ${IOS},border-bottom-color .3s ${IOS}}
.vw:active{transform:scale(.96);transition:transform .12s ${IOS}}
.vw.on{color:var(--txt);border-bottom-color:${COL.info}}

/* filters */
.filters{display:flex;gap:10px;padding:14px var(--pad);border-bottom:1px solid var(--line);flex-wrap:wrap}
/* Same basis and grow as .ms, so search and both dropdowns share the row in
   equal thirds. border-box because this is a padded label: in content-box its
   30px padding and border would sit on top of the basis and it would be wider. */
.search{flex:1 1 240px;box-sizing:border-box;display:flex;align-items:center;gap:10px;
        padding:0 15px;min-height:var(--tap);
        background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:11px}
.search svg{width:18px;height:18px;fill:none;stroke:var(--txt2);stroke-width:2;
            stroke-linecap:round;flex:0 0 auto}
.search input{flex:1;min-width:0;appearance:none;border:0;background:transparent;outline:none;
              font-family:inherit;font-size:var(--fs-body);font-weight:600;color:var(--txt)}
.search input::placeholder{font-weight:500;color:var(--txt2)}

/* multi-select */
.ms{position:relative;flex:1 1 240px}
.msbtn{display:flex;align-items:center;gap:9px;min-height:var(--tap);padding:0 15px;
       appearance:none;font-family:inherit;font-size:var(--fs-body);font-weight:600;border-radius:11px;
       background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--txt);
       cursor:pointer;width:100%;
       transition:border-color .26s ${IOS},background .26s ${IOS}}
.msbtn:active{transform:scale(.985);transition:transform .12s ${IOS}}
.ms.active .msbtn{border-color:color-mix(in srgb,${COL.info} 55%,transparent);
                  background:color-mix(in srgb,${COL.info} 14%,transparent)}
.mslabel{flex:1 1 auto;min-width:0;text-align:left;   /* pushes the chevron to the far edge */
         white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msbtn svg{width:17px;height:17px;flex:0 0 auto;fill:none;stroke:var(--txt2);
           stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s ${EASE}}
.ms.open .msbtn svg{transform:rotate(180deg)}
.mspanel{display:none;position:absolute;z-index:20;top:calc(100% + 7px);left:0;min-width:250px;
         max-height:310px;overflow:auto;padding:7px;border-radius:13px;
         background:#2a2433;border:1px solid rgba(255,255,255,.14);
         box-shadow:0 18px 44px rgba(0,0,0,.55);
         scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.22) transparent}
.ms.open .mspanel{display:block;animation:pop .28s ${IOS_SOFT}}
@keyframes pop{from{opacity:0;transform:translateY(-8px) scale(.97)}
               to{opacity:1;transform:none}}
.msacts{display:flex;gap:7px;padding:3px 3px 7px;border-bottom:1px solid var(--line);margin-bottom:5px}
.msact{flex:1;appearance:none;font-family:inherit;font-size:var(--fs-meta);font-weight:600;
       min-height:39px;border-radius:9px;background:rgba(255,255,255,.07);border:0;
       color:var(--txt2);cursor:pointer}
.msopt{display:flex;align-items:center;gap:11px;width:100%;min-height:var(--tap);padding:0 9px;
       appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
       font-size:var(--fs-body);font-weight:600;color:var(--txt);border-radius:9px;text-align:left}
.msopt{transition:background .2s ${IOS}}
.msopt:hover{background:rgba(255,255,255,.06)}
.msopt:active{transform:scale(.985);transition:transform .1s ${IOS}}
.box{flex:0 0 auto;width:22px;height:22px;border-radius:6px;border:2px solid rgba(255,255,255,.28);
     display:grid;place-items:center;transition:background .2s ${IOS},border-color .2s ${IOS}}
.box svg{width:14px;height:14px;fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;
         stroke-linejoin:round;opacity:0;transform:scale(.5);
         transition:opacity .2s ${IOS},transform .3s ${IOS_SOFT}}
.msopt.on .box{background:${COL.info};border-color:${COL.info}}
.msopt.on .box svg{opacity:1;transform:none}
.msname{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mscount{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2)}

.clear{appearance:none;font-family:inherit;font-size:var(--fs-body);font-weight:600;
       min-height:var(--tap);padding:0 30px;border-radius:11px;background:transparent;
       border:1px solid var(--line);color:var(--txt2);cursor:pointer;
       transition:color .26s ${IOS},border-color .26s ${IOS}}
.clear:active{transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.clear:hover{color:var(--txt);border-color:rgba(255,255,255,.24)}

/* table
   No inner scroll container. A scrollable region inside a scrollable page means the
   wheel does different things depending on where the pointer happens to be, and on
   touch it steals the gesture. The table grows to its full height and the PAGE is
   the only thing that scrolls. The header still sticks — with no scrolling
   ancestor of its own it pins against the page scrollport instead. */
.tbody{position:relative}
/* The WHOLE header block sticks, not just the column row. Sticking .thead alone
   let the tabs, search and both dropdowns scroll away, leaving a bare column row
   pinned under HA's toolbar with no way to change tab or filter without
   scrolling back up.
   TWO STACKED STICKIES, never one nested in the other: a sticky element can only
   travel inside its PARENT's box, so putting .thead inside the header wrapper
   pinned it for exactly the wrapper's own height and then let it scroll away.
   .thead therefore stays in .tablewrap (tall enough to travel) and is offset by
   the wrapper's measured height, --sticky-h, which JS keeps in sync because it
   changes as the filters wrap. Both must stay opaque (rows pass underneath) and
   neither may get an overflow of its own, or the dropdown panels would clip. */
.stickyhead{position:sticky;top:var(--hm-pin);z-index:6;
            background:var(--ha-card-background,#201b25)}
.thead{position:sticky;top:calc(var(--hm-pin) + var(--sticky-h,0px));z-index:5;
       display:grid;gap:var(--gap);
       padding:0 var(--pad);background:var(--ha-card-background,#201b25);
       border-bottom:1px solid var(--line)}
/* On a phone the tabs and the three filter controls each wrap to their own row,
   so the wrapper measures 456px — 54% of an 844px screen, leaving five rows of
   table. Pinning that is worse than not pinning it, so below 700px only the
   column row pins, which is what it did before. */
@media (max-width: 700px){
  .stickyhead{position:static}
  .thead{top:var(--hm-pin)}
}
.th{appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;text-align:left;
    min-height:45px;padding:0;display:flex;align-items:center;gap:6px;transition:color .18s ${EASE}}
.th.r{justify-content:flex-end}
.th:hover{color:var(--txt)}
.th.on{color:${COL.info}}
.ar{font-size:9px}
.tr{display:grid;gap:var(--gap);align-items:center;padding:12px var(--pad);cursor:pointer;
    min-height:var(--tap);border-bottom:1px solid rgba(255,255,255,.05);
    transition:background .16s ${EASE}}
.tr:hover{background:rgba(255,255,255,.045)}
.tr:active{transform:scale(.995);transition:transform .1s ${IOS}}
.tr.open{background:rgba(88,166,255,.09)}
/* Row enter/exit/move are driven from JS (WAAPI) in _reconcile, because they need
   real before/after positions. Nothing here should also animate them. */
.td{min-width:0;display:flex;align-items:center;gap:9px}
.td.r{justify-content:flex-end;text-align:right}
.nm{display:flex;align-items:center;gap:12px;min-width:0}
.dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:var(--c);
     box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 20%,transparent)}
.nmt{display:flex;flex-direction:column;gap:2px;min-width:0}
.nmt b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nmt i{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{appearance:none;border:0;cursor:pointer;text-align:left;
     font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;padding:6px 10px;border-radius:6px;
     background:rgba(255,255,255,.08);color:var(--txt2);
     white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;
     transition:background .16s ${EASE},color .16s ${EASE}}
.tag:hover{background:rgba(255,255,255,.15);color:var(--txt)}
.tag:active{transform:scale(.94);transition:transform .12s ${IOS_SOFT}}
.tag.on{background:color-mix(in srgb,${COL.info} 22%,transparent);color:${COL.info};
        box-shadow:inset 0 0 0 1px color-mix(in srgb,${COL.info} 45%,transparent)}
/* Status and quality chips carry the CATEGORY hue rather than the interactive
   blue, because the colour is data here. The fill stays light so the label keeps
   its full-strength colour against it; the ring is what thickens when selected,
   so "this is a filter" and "this is a status" never compete for the same cue. */
.tag.stt{font-family:inherit;font-weight:600;text-align:center;
         background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--c);
         box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 30%,transparent)}
.tag.stt:hover{background:color-mix(in srgb,var(--c) 26%,transparent);color:var(--c)}
.tag.stt.on{background:color-mix(in srgb,var(--c) 30%,transparent);color:var(--c);
            box-shadow:inset 0 0 0 2px var(--c)}
.st{font-size:var(--fs-body);font-weight:600;color:var(--c)}
.bar{flex:1 1 auto;min-width:36px;max-width:70px;height:7px;border-radius:4px;
     background:rgba(255,255,255,.1);overflow:hidden}
.barfill{display:block;height:100%;border-radius:4px;background:var(--c);
         transition:width .65s ${IOS},background-color .3s ${IOS}}
.bv{font-family:var(--mono);font-size:var(--fs-body);font-weight:600;white-space:nowrap;color:var(--c)}

/* row actions */
.acts{display:flex;align-items:center;justify-content:flex-end;gap:2px}
.iconbtn{appearance:none;border:0;background:transparent;cursor:pointer;padding:0;
         width:38px;height:38px;border-radius:10px;display:grid;place-items:center;
         transition:background .16s ${EASE}}
.iconbtn:hover{background:rgba(255,255,255,.1)}
.iconbtn:active{transform:scale(.9);transition:transform .12s ${IOS_SOFT}}
.iconbtn svg{width:19px;height:19px;fill:none;stroke:var(--txt2);stroke-width:2;
             stroke-linecap:round;stroke-linejoin:round}
.iconbtn:hover svg{stroke:${COL.info}}
.chev{display:grid;place-items:center;width:26px;height:38px}
.chev svg{width:20px;height:20px;fill:none;stroke:var(--txt2);stroke-width:2.4;
          stroke-linecap:round;stroke-linejoin:round;opacity:.6;
          transition:transform .42s ${IOS_SOFT}}
.chev.up svg{transform:rotate(180deg)}
.none{padding:36px;text-align:center}

/* detail */
.detail{padding:0 var(--pad);background:rgba(88,166,255,.05);
        border-bottom:1px solid var(--line)}
.detailBody{padding:4px 0 20px}
/* The embedded state-history-card, restyled to this card's type scale and
   palette. Everything it draws is driven by CSS custom properties, so no fork
   change is needed for looks — only the colour semantics are config. */
.shc{margin:2px 0 4px;animation:fade .34s ${IOS}}
.shc state-history-card{
  display:block;
  --ha-card-border-width:0;
  --ha-card-box-shadow:none;
  --state-history-card-background:transparent;
  --state-history-card-border-radius:0;
  --state-history-card-padding:0;
  --state-history-row-height:${SHC_ROW_H}px;
  --state-history-row-gap:${SHC_ROW_GAP}px;
  --state-history-track-border-radius:4px;
  --state-history-track-background:rgba(255,255,255,.05);
  --state-history-track-grid-color:var(--line);
  --state-history-label-font-size:var(--fs-meta);
  --state-history-label-font-weight:500;
  --state-history-label-color:var(--txt2);
  --state-history-axis-font-size:var(--fs-label);
  --state-history-axis-color:var(--txt2);
  --state-history-axis-tick-color:var(--line);
  --state-history-tooltip-font-size:var(--fs-meta);
  --state-history-tooltip-border-radius:9px;
  --state-history-tooltip-padding:8px 11px;
}
.dhead{padding:13px 0 9px;display:flex;gap:11px;align-items:baseline;flex-wrap:wrap}
.dhead.sm{padding-top:18px}
.dsub{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;
      text-transform:none;letter-spacing:0;color:var(--txt2);opacity:.85}
.loading{padding:20px 0}
.dstats{display:flex;gap:20px;align-items:center;flex-wrap:wrap;padding-top:12px}
.dstats span{font-size:var(--fs-meta);font-weight:500;color:var(--txt2)}
.dstats b{font-family:var(--mono);font-size:var(--fs-body);color:var(--txt);font-weight:600}
.more{margin-left:auto;appearance:none;font-family:inherit;font-size:var(--fs-body);font-weight:600;
      min-height:42px;padding:0 18px;border-radius:10px;background:rgba(88,166,255,.16);
      border:1px solid rgba(88,166,255,.34);color:${COL.info};cursor:pointer}
.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.log li{display:flex;align-items:center;gap:11px;min-height:37px}
.logdot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto}
.lgt{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2);flex:0 0 auto}
.lgm{font-size:var(--fs-meta);font-weight:500;color:var(--txt);
     white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* last-run block: the error text of a failed run, and the jump to its trace */
.log li.jobmsg{display:block;font-family:var(--mono);color:var(--c);white-space:pre-wrap;
               word-break:break-word;padding:0 0 8px 19px;min-height:0}
.navbtn{appearance:none;font-family:inherit;margin-left:auto;cursor:pointer;
        min-height:var(--tap);padding:0 18px;border-radius:11px;background:transparent;
        border:1px solid var(--line);color:var(--txt2);
        transition:color .26s ${IOS},border-color .26s ${IOS}}
.navbtn:active{transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.navbtn:hover{color:var(--txt);border-color:rgba(255,255,255,.24)}
/* pager */
.pager{display:flex;align-items:center;justify-content:center;gap:18px;
       padding:14px var(--pad) 4px}
.pg{appearance:none;border:1px solid var(--line);background:rgba(255,255,255,.05);
    width:var(--tap);height:var(--tap);border-radius:14px;cursor:pointer;
    display:grid;place-items:center;
    transition:background .26s ${IOS},opacity .26s ${IOS}}
.pg svg{width:22px;height:22px;fill:none;stroke:var(--txt);stroke-width:2.4;
        stroke-linecap:round;stroke-linejoin:round}
.pg:hover:not(:disabled){background:rgba(255,255,255,.1)}
.pg:active:not(:disabled){transform:scale(.92);transition:transform .12s ${IOS_SOFT}}
.pg:disabled{opacity:.3;cursor:default}
.pgtext{font-size:var(--fs-body);font-weight:600;color:var(--txt);
        font-family:var(--mono);min-width:86px;text-align:center}

.tfoot{padding:14px var(--pad);border-top:1px solid var(--line);text-align:center}

@media (max-width:700px){
  ha-card{--pad:13px;--gap:9px}
  .ms,.msbtn{max-width:none;width:100%}
  .search,.ms{flex:1 1 100%}
}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition-duration:.01ms!important}}
`;

customElements.define("health-monitor-card", HealthMonitorCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "health-monitor-card",
  name: "Health Monitor Card",
  description: "Sortable, filterable device health console with recorder-backed history",
  preview: false,
});
console.info(
  `%c HEALTH-MONITOR-CARD %c ${VERSION} `,
  "background:#58A6FF;color:#04121f;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px",
  "background:#3FB950;color:#04170a;font-weight:700;border-radius:0 3px 3px 0;padding:2px 4px"
);
