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
 *    Signal, its RSSI sensor; in Availability, each member's availability band
 *    (available, unavailable, a brief drop-out, a restart) plus the timeline of those
 *    changes - never the states themselves. The row entity is usually a switch or binary sensor whose own
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
 * (history/history_during_period).
 *
 * Config:
 *   type: custom:health-monitor-card
 *   group: home_devices      # group slug (required)
 *   title: Device Health     # optional
 *   hours: 24                # optional: 6 | 24 | 72 | 168
 *   grid_options: {columns: full}   # required inside a sections-view grid
 */

const VERSION = "3.23.0";

/* One colour per problem CATEGORY, used in every place that category is shown —
   chart line, chart fill, legend, row dot, status text, detail chart. A category
   that changes colour between the chart and the table is not a colour scheme, it
   is two colour schemes.

   Selection (active tab, ticked box, sorted column, filtered chip, open row) is
   WHITE and one weight up, never a hue - so no colour on screen ever means anything
   but a category. (It was blue until 2026-10-04; the user asked for none.) */
// an alert's priority, in the Alerts card's colours
const PRIORITY_TONE = { high: "#F85149", medium: "#DB6D28", low: "#EFC53F" };

const COL = {
  ok: "#3FB950",          // healthy
  bad: "#F85149",         // offline — the only red
  battery: "#DB6D28",     // low battery — dark orange
  signal: "#EFC53F",      // weak signal — yellow, well clear of the orange
  stale: "#8B949E",       // stale — deliberately colourless (also: a restart)
  brief: "#E3A33B",       // a brief drop-out — real, but too short to count as offline
  ignored: "#6E7681",     // ignored by someone: a darker grey than "Not updating" - set aside, not a problem
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
  // Ignored first: set aside by someone (its entities suppressed), so none of its problems
  // count - in any tab - until the ignore ends.
  if (d.ignored) return { text: "Ignored", tone: COL.ignored };
  // ...but in the Battery tab a low battery outranks offline: a dying battery is what takes
  // most battery devices offline, and the integration keeps such a device low battery (an
  // alert's "Low battery" link must find it)
  if (view === "battery" && d.lowBattery) return { text: "Low battery", tone: COL.battery };
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

/* What a status is called on screen. Its value - in the filters, the address
   (not_updating) and the alert rules - stays as it is; Not updating says the window it is
   judged over, the group's staleness threshold: "Not Updating (24h)". */
function statusWord(v, staleMins) {
  if (v !== "Not updating") return v;
  const m = Math.round(Number(staleMins) || 0);
  if (!m) return "Not Updating";
  return `Not Updating (${m % 60 ? `${m}m` : `${m / 60}h`})`;
}

/* Each tab's statuses, worst first: the Status filter's values. */
const STATUS_NAMES = {
  devices: ["Unavailable", "Not updating", "OK", "Ignored"],
  helpers: ["Failed", "Unavailable", "Not updating", "OK", "Ignored"],
  battery: ["Low battery", "Unavailable", "OK", "Ignored"],
  signal: ["Weak signal", "Unavailable", "OK", "Ignored"],
  ignored: ["Ignored"],
};
const STATUS_TONE = {
  Unavailable: COL.bad, Failed: COL.bad, "Not updating": COL.stale,
  "Low battery": COL.battery, "Weak signal": COL.signal, OK: COL.ok, Ignored: COL.ignored,
};

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
  // ignored, and still (or again) down
  if (d.down) return d.downSince ? ago(d.downSince) : "—";
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
  /* What someone set aside, so it is not forgotten: devices and helpers together, a
     plain count (nothing to be "out of"), shown only while something is ignored - and
     uncoloured, as a reminder rather than a problem. */
  { id: "ignored", bad: "Ignored Items", ok: "Ignored Items", tone: COL.ignored, plain: true },
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
  // Area is narrower here than in Devices; what it gives up goes, evenly, to the
  // reading and its status as room on their right (`pad`), so the reading sits further
  // in from the status and the status from the row's end.
  battery: [
    { id: "name", label: "Device", w: "minmax(180px,2.2fr)" },
    { id: "platform", label: "Integration", w: "minmax(120px,1fr)" },
    { id: "area", label: "Area", w: "minmax(100px,.6fr)" },
    { id: "battery", label: "Battery", w: "210px", align: "right", pad: 40 },
    { id: "status", label: "Status", w: "170px", align: "right", pad: 40 },
  ],
  signal: [
    { id: "name", label: "Device", w: "minmax(180px,2.2fr)" },
    { id: "platform", label: "Integration", w: "minmax(120px,1fr)" },
    { id: "area", label: "Area", w: "minmax(100px,.6fr)" },
    { id: "rssi", label: "Signal", w: "210px", align: "right", pad: 40 },
    { id: "quality", label: "Quality", w: "150px", align: "right", pad: 40 },
  ],
  /* The Ignored tile's list, which no tab owns: devices and helpers mixed, in the
     Devices columns (a helper reads _script, Internal). */
  ignored: [
    { id: "name", label: "Name", w: "minmax(180px,2.2fr)" },
    { id: "platform", label: "Integration", w: "minmax(120px,1fr)" },
    { id: "area", label: "Area", w: "minmax(120px,1fr)" },
    { id: "status", label: "Status", w: "120px", align: "right" },
    { id: "lastSeen", label: "Last seen", w: "130px", align: "right" },
  ],
};

/* THE HEALTH VIEW AS AN ADDRESS, Grafana-style. Every filter is a URL parameter: read when
   a link lands on the view (an alert's link, a bookmark, a reload) and written back as the
   view changes (replaceState: no Back-button steps), so the address always says what is on
   screen. ONE table: a new filter is one line here, and nothing about any alert is coded
   anywhere. A value is the slug of the name shown ("Not updating" -> not_updating), several
   joined with commas; one that does not exist is ignored. hm_tab comes first: a tab change
   clears the tab's own vocabularies (status, quality).
     /dashboard/health?hm_tab=devices&hm_status=unavailable&hm_area=garage,studio */
const urlSlug = (v) => String(v).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+$/, "");
const TAB_IDS = [...VIEWS.map((v) => v.id), "ignored"];
const TAB_WORDS = { devices: "Devices", helpers: "Helpers", battery: "Battery", signal: "Signal", ignored: "Ignored" };
// a set of names <-> a comma list of slugs, matched against the names there are
const slugList = (set) => [...set].map(urlSlug).join(",");
const pickSlugs = (set, value, names) => {
  const want = new Set(String(value).split(",").map((x) => x.trim()).filter(Boolean));
  for (const n of new Set(names)) if (want.has(urlSlug(n))) set.add(n);
};
const URL_PARAMS = [
  { key: "hm_tab", read: (c) => (c._view === "devices" ? "" : c._view),
    apply: (c, v) => { if (TAB_IDS.includes(v)) c._setView(v); } },
  { key: "hm_status", read: (c) => slugList(c._statuses),
    apply: (c, v) => pickSlugs(c._statuses, v, STATUS_NAMES[c._view] || []) },
  { key: "hm_quality", read: (c) => slugList(c._qualities),
    apply: (c, v) => pickSlugs(c._qualities, v, ["Poor", "OK", "Good"]) },
  { key: "hm_integration", read: (c) => slugList(c._platforms),
    apply: (c, v) => pickSlugs(c._platforms, v, c._data.rows.map((r) => r.platform)) },
  { key: "hm_area", read: (c) => slugList(c._areas),
    apply: (c, v) => pickSlugs(c._areas, v, c._data.rows.map((r) => r.area)) },
  { key: "hm_q", text: true, read: (c) => c._q, apply: (c, v) => { c._q = v; c._el.q.value = v; } },
  { key: "hm_range", read: (c) => (c._range === c._rangeDefault ? "" : c._range),
    apply: (c, v) => { if (RANGES.some((r) => r.id === v)) c._range = v; } },
  // exactly these rows, as a chart pick shows them (a chip that lets go); a link's only.
  // Any entity of a row names the row (an alert names one per device)
  { key: "hm_rows", read: (c) => (c._pinned?.link ? [...c._pinned.rows].join(",") : ""),
    apply: (c, v) => {
      const rows = new Set();
      for (const x of String(v).split(",")) { const r = c._rowFor(x.trim()); if (r) rows.add(r.id); }
      if (rows.size) c._pinned = { rows, tone: COL.stale, label: "From link", link: true };
    } },
  // the alert those rows are behind (its entity id): the chip names it and counts them
  { key: "hm_alert", read: (c) => (c._pinned?.link && c._pinned.alert) || "",
    apply: (c, v) => { if (c._pinned?.link && /^alert2\.[a-z0-9_]+$/.test(v)) c._pinned.alert = v; } },
  // a row open, and scrolled to
  { key: "hm_open", read: (c) => c._open || "", apply: (c, v) => { c._landOpen = v; } },
];

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
    // Home Assistant moving to this view, or Back/Forward: a link's filters land
    this._onLoc = () => this._landLater();
  }

  setConfig(config) {
    if (!config || !config.group) {
      throw new Error("health-monitor-card: 'group' is required (the group slug)");
    }
    this._config = { title: "Device Health", hours: 24, page_size: 50, ...config };
    // layout: phone - the iPhone page (HealthPhoneView, below), from this card's data
    this._phone = this._config.layout === "phone";
    this._pageSize = Math.max(10, Number(this._config.page_size) || 50);
    const r = RANGES.find((x) => x.hours === Number(this._config.hours));
    this._range = r ? r.id : "24h";
    this._rangeDefault = this._range;
    this._built = false;
    this.shadowRoot.innerHTML = "";
  }

  getCardSize() { return 18; }

  /* layout: phone - the page is HealthPhoneView's, drawn from this card's data (read again
     only when the summary changes) and its history and ignore helpers. page-switcher-card's
     header calls openHide (its filter button) and handleBack (its ‹) on this card. */
  _hassPhone(summary, base) {
    if (summary === this._phSum && this._phView) return;
    this._phSum = summary;
    this._base = base;
    this._data = this._read(summary, this._hass);
    this._loadIntegrationTypes();
    if (!this._phView) {
      this.shadowRoot.innerHTML = `<style>:host{display:block}</style><health-phone-view></health-phone-view>`;
      this._phView = this.shadowRoot.querySelector("health-phone-view");
      this._phView.card = this;
    }
    this._phView.update();
  }
  openHide(anchor) { this._phView?.openHide(anchor); }
  handleBack() { return !!this._phView?.handleBack(); }
  static getStubConfig() { return { type: "custom:health-monitor-card", group: "home_devices" }; }

  connectedCallback() {
    document.addEventListener("pointerdown", this._onDocPress, true);
    document.addEventListener("keydown", this._onDocKey, true);
    window.addEventListener("location-changed", this._onLoc);
    window.addEventListener("popstate", this._onLoc);
    // Home Assistant takes a hidden view's cards out of the page and puts them back when it
    // is shown again - AFTER the navigation's event, which this card then never heard
    this._landLater();
    this._trackHaHeader();
    this._observe();
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this._onDocPress, true);
    document.removeEventListener("keydown", this._onDocKey, true);
    window.removeEventListener("location-changed", this._onLoc);
    window.removeEventListener("popstate", this._onLoc);
    this._hdrRo?.disconnect(); this._hdrRo = null; this._hdr = null;
    this._ro?.disconnect(); this._ro = null;
    this._headRo?.disconnect(); this._headRo = null;
    this._labRo?.disconnect(); this._labRo = null;
    if (this._info?.dlg.open) this._info.dlg.close();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    setLocale(hass);
    // The embedded state-history-card is a live element, not markup we re-emit,
    // so it needs hass handed to it on every tick or its "now" edge freezes.
    if (this._shc?.isConnected) this._shc.hass = this._availHass(hass);
    // hui-root can re-render its header (edit mode); follow the new element.
    if (this._hdr && !this._hdr.isConnected) this._trackHaHeader();
    const base =`sensor.entity_availability_${this._config.group}`;
    const summary = hass.states[`${base}_group_summary`];
    if (!summary) return this._fail(`${base}_group_summary`);
    if (this._phone) { this._hassPhone(summary, base); return; }
    this._base = base;
    this._data = this._read(summary, hass);
    this._loadIntegrationTypes();
    if (!this._built) this._build();
    let landed = false;
    // the view this card lives on: Home Assistant builds a view's cards when it shows it
    if (!this._urlReady) { this._urlReady = true; this._home = location.pathname; landed = this._applyUrl(); }
    this._paint();
    this._paintActions();
    if (first) this._loadOverview();
    if (landed) this._afterLanding(400);
  }

  // ------------------------------------------------------------------ address

  /* The address's filters -> the view. A link is the WHOLE view: what it does not set goes
     back to its default, so "Devices · Unavailable" never mixes with an area left from
     before. No hm_ parameter at all (the view opened from the menu): the view stays as it
     was, and the address is brought in line with it. Returns whether anything landed. */
  _urlSigOf(search) {
    const q = new URLSearchParams(search);
    return URL_PARAMS.some((p) => q.has(p.key)) ? URL_PARAMS.map((p) => `${p.key}=${q.get(p.key) ?? ""}`).join("&") : "";
  }

  _applyUrl() {
    const q = new URLSearchParams(location.search);
    const sig = this._urlSigOf(location.search);
    if (!sig || sig === this._urlSig) return false;  // nothing, or what this card wrote itself
    this._urlSig = sig;
    this._platforms.clear(); this._areas.clear(); this._statuses.clear(); this._qualities.clear();
    this._q = ""; this._el.q.value = ""; this._pinned = null;
    const range = this._range;
    this._range = this._rangeDefault;
    this._setView("devices");
    this._landOpen = null;
    for (const p of URL_PARAMS) {
      const v = q.get(p.key);
      if (v != null && v !== "") p.apply(this, v);
    }
    // the rows a link names always show: a status filter that would hide one of them (an
    // alert's device that has recovered since) is dropped
    if (this._pinned?.link && this._statuses.size &&
        this._baseRows().some((r) => this._pinned.rows.has(r.id) && !this._statuses.has(statusOf(r, this._view).text))) {
      this._statuses.clear();
    }
    if (this._range !== range) {
      this.shadowRoot.querySelectorAll(".rg").forEach((x) => x.classList.toggle("on", x.dataset.r === this._range));
      if (this._overview) this._loadOverview();
    }
    this._sig = "";
    return true;
  }

  /* Home Assistant switches the view a moment after the address changes: land once this
     card is on screen (it may never be - the navigation went elsewhere). */
  _landLater() {
    if (this._phone) { setTimeout(() => this._phView?.land(), 60); return; }
    if (!this._urlReady) return;
    let tries = 12;
    const go = () => {
      // gone elsewhere: not this card's address. (While Home Assistant switches views the
      // old one is still on screen for a moment - on screen alone proves nothing.)
      if (!this.isConnected || location.pathname !== this._home) return;
      if (!this.getClientRects().length) { if (tries--) setTimeout(go, 100); return; }
      if (this._applyUrl()) {
        this._paintFilters();
        this._paintTable();
        this._afterLanding(150);
      } else this._syncUrl();
    };
    setTimeout(go, 60);
  }

  /* Landed: the row asked for open (on its page) and in view, else the table in view - on a
     tablet the table is a screen below the tiles. */
  _afterLanding(ms) {
    setTimeout(() => {
      const id = this._landOpen;
      this._landOpen = null;
      const at = id ? this._visible().findIndex((r) => r.id === id) : -1;
      if (at >= 0) {
        const page = Math.floor(at / this._pageSize);
        if (page !== this._page) { this._page = page; this._sig = ""; this._paintTable(); }
        if (this._open !== id) this._toggle(id);
        this._scrollToTable(this._el.tbody.querySelector(`.tr[data-id="${CSS.escape(id)}"]`));
      } else this._scrollToTable();
    }, ms);
  }

  /* The view -> the address (and, for the alert editor, "as you last set it"). Only while
     this card is on screen: Home Assistant keeps other views alive in the background, and
     one of those must never write into another page's address. Other parameters (kiosk,
     edit) stay as they are. */
  _syncUrl() {
    if (!this._urlReady || !this._data || this._config.url_params === false) return;
    if (!this.isConnected || location.pathname !== this._home || !this.getClientRects().length) return;
    // on a page that is leaving (a page switcher marks it inert as it slides away): still on
    // screen, but no longer this address's
    if (this.closest("[inert]")) return;
    // a link that has just arrived and is not applied yet (a data update came first): never
    // write over it - it lands a moment later
    const now = this._urlSigOf(location.search);
    if (now && now !== this._urlSig) return;
    const parts = [];
    for (const p of URL_PARAMS) {
      const v = p.read(this);
      if (v) parts.push(`${p.key}=${p.text ? encodeURIComponent(v) : v}`);
    }
    const keep = location.search.replace(/^\?/, "").split("&").filter((x) => x && !/^hm_[a-z]+(=|$)/.test(x));
    const search = [...keep, ...parts].join("&");
    const url = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, "", url);
    this._urlSig = this._urlSigOf(search);
    const query = parts.filter((x) => !/^hm_(open|rows|alert)=/.test(x)).join("&");
    if (query !== this._lastSaved) {
      this._lastSaved = query;
      try {
        localStorage.setItem("hm-health-view", JSON.stringify({ query, label: this._viewLabel(), group: this._config.group, at: Date.now() }));
      } catch { /* private mode: no "as you last set it" */ }
    }
  }

  _word(v) { return statusWord(v, this._data?.thresholds?.staleness); }

  /* The view in words, for a link's name: "Devices · Unavailable · Garage, Studio". */
  _viewLabel() {
    const parts = [TAB_WORDS[this._view] || this._view];
    for (const set of [this._statuses, this._qualities, this._platforms, this._areas]) {
      if (set.size) parts.push([...set].map((v) => this._word(v)).join(", "));
    }
    if (this._q) parts.push(`"${this._q}"`);
    if (this._range !== this._rangeDefault) parts.push(this._range);
    return parts.join(" · ");
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
    // suppressed entities, each with when it ends (null: until someone stops it)
    const suppressed = a.suppressed_until || {};

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
      // Ignored: every entity of the row suppressed (the card's Ignore suppresses them all);
      // until the latest of their ends, or until stopped when one of them has none
      const ignored = members.length > 0 && members.every((m) => m in suppressed);
      const ends = ignored ? members.map((m) => suppressed[m]) : [];
      const ignoredUntil = !ignored || ends.some((u) => u == null) ? null : Math.max(...ends.map((u) => Date.parse(u)));
      /* An ignored row is left out of the offline list, so whether it is down - and since
         when - comes from its entities' own states: down when none of them is available.
         The integration keeps the "since" of an outage that began before the ignore; one
         that began during it dates from their last change. */
      const unavailable = (m) => ["unavailable", "unknown", undefined].includes(hass.states[m]?.state);
      const down = ignored && members.every(unavailable);
      const changed = down ? members.map((m) => Date.parse(hass.states[m]?.last_changed)).filter((t) => t > 0) : [];
      const downSince = !down ? null
        : pick(a.offline_since) || (changed.length ? new Date(Math.max(...changed)).toISOString() : null);
      const deviceId = pick(a.device_ids);
      const mark = deviceId ? "" : NON_DEVICE_MARK;
      const baseName = (a.display_names || {})[id] || id;
      return {
        id, members,
        name: mark + baseName,
        baseName,   // unmarked; member friendly names start with this, not with name
        platform: mark + (deviceId ? groupPlatform(pick(a.platforms) || "—")
                                   : this._labelFor(pick(a.platforms), id)),
        rawPlatform: pick(a.platforms),
        area: areaLabel(pick(a.areas)),
        deviceId,
        batterySource: pick(a.battery_sources),
        signalSource: pick(a.signal_sources),
        ignored, ignoredUntil, down, downSince,
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
        staleSince: pick(a.stale_since),
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

  /* What a row WITHOUT a device is called in the Integration / Type column. Home
     Assistant itself declares what kind each integration is (its manifest's
     integration_type). Things HA computes - helper and system integrations: template,
     automation, script, input_*, timer … - are named by that integration. Anything else
     that has an entity but no device - a Google calendar, OpenSprinkler's calendar - is
     named by WHAT it is, its entity domain: "_calendar", not "_google". Nothing is
     listed by hand, so a new integration sorts itself. Until the types have loaded
     (one websocket call), the integration name stands in. */
  _labelFor(raw, id) {
    if (!raw) return "—";
    const t = this._itype?.[raw];
    if (t && t !== "helper" && t !== "system") return id.split(".")[0];
    return groupPlatform(raw);
  }

  async _loadIntegrationTypes() {
    this._itype = this._itype || {};
    this._itypeAsked = this._itypeAsked || new Set();
    const want = [...new Set(this._data.rows
      .filter((r) => !isDevice(r) && r.rawPlatform && !this._itypeAsked.has(r.rawPlatform))
      .map((r) => r.rawPlatform))];
    if (!want.length) return;
    want.forEach((d) => this._itypeAsked.add(d));
    const res = await this._ws({ type: "manifest/list", integrations: want });
    // An integration that declares no type is a "hub" - HA's own default.
    for (const m of res || []) this._itype[m.domain] = m.integration_type || "hub";
    const summary = this._hass?.states?.[`${this._base}_group_summary`];
    if (!summary || !this._built) return;
    this._data = this._read(summary, this._hass);
    this._sig = "";
    this._paint();
  }

  /* The tab's rows before any filter. */
  _baseRows() {
    const rows = this._data.rows;
    // a Problems bar picked in the chart: its devices and helpers, in either tab
    if (this._pinned?.both && (this._view === "devices" || this._view === "helpers")) return rows;
    if (this._view === "devices") return rows.filter(isDevice);
    if (this._view === "helpers") return rows.filter((r) => !isDevice(r));
    if (this._view === "battery") return rows.filter((r) => r.battery !== null);
    if (this._view === "signal") return rows.filter((r) => r.rssi !== null);
    if (this._view === "ignored") return rows.filter((r) => r.ignored);
    return rows;
  }

  // the rows on screen; `unpinned`: as they would be without a pinned pick
  _visible(unpinned = false) {
    let out = this._baseRows();
    if (this._platforms.size) out = out.filter((r) => this._platforms.has(r.platform));
    if (this._areas.size) out = out.filter((r) => this._areas.has(r.area));
    if (this._statuses.size)
      out = out.filter((r) => this._statuses.has(statusOf(r, this._view).text));
    if (this._qualities.size) out = out.filter((r) => this._qualities.has(r.quality));
    // A bar picked in the problem chart: exactly the rows that were behind it.
    if (this._pinned && !unpinned) out = out.filter((r) => this._pinned.rows.has(r.id));
    if (this._q) {
      const q = this._q.toLowerCase();
      out = out.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
    }
    const { col, dir } = this._sort;
    // Sort by the status the tab actually SHOWS, or the order contradicts the column.
    const sev = (r) => {
      if (r.ignored) return 5;            // after OK: set aside
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
          if (!r.offline && !r.down) return -Infinity;          // seen just now
          const t = r.down ? r.downSince : r.offlineSince || r.lastSeen;
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

  /* The chart's range as its button reads ("24h", "3d", "7d"): every history in an open
     row is drawn over it, and says so. */
  _rangeLabel() { return RANGES.find((r) => r.id === this._range).label; }

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
    /* WITH attributes: the counts carry the devices behind them (offline_count per
       device, the battery and signal counts a `devices` list), which is what lets a
       bar name its devices and be tapped. A count recorded before those lists
       existed still draws, it just cannot name anyone. */
    /* From the FIRST SLOT's start, not the window's: slots are clock-aligned, so the
       first one usually begins a little before the window does, and drawing it full
       width needs its whole span of data. */
    const from = new Date(Math.min(start.getTime(), this._slotsFor(start, end)[0].a));
    const res = await this._ws({
      type: "history/history_during_period",
      start_time: from.toISOString(), end_time: end.toISOString(),
      entity_ids: [...ids, ...problemEntities(this._base)], minimal_response: false, no_attributes: false,
      significant_changes_only: false,
    });
    this._overview = { res: res || {}, ids, start, end, from };
    this._drawOverview();
  }

  /* The chart's slots for a window at the card's current width: a nice clock step,
     at most one slot per ~48px, so every slot stays a comfortable touch target. */
  _slotsFor(start, end) {
    const plotW = (this._el?.overview?.clientWidth || 700) - 64;
    return slotGrid(start.getTime(), end.getTime(), Math.max(6, Math.min(30, Math.floor(plotW / 48))));
  }

  async _loadDetail(row) {
    const { start, end } = this._window();
    // The open row's panel - never one still closing from the row before.
    const panel = this._el?.tbody.querySelector(".detail:not(.closing)");
    const box = panel?.querySelector(".detailBody");
    if (!box) return;
    // A newer load (another range, a retry) supersedes this one; so does the row
    // closing. Checked after every wait.
    const token = (panel._load = (panel._load || 0) + 1);
    const stale = () => !panel.isConnected || panel.classList.contains("closing") ||
                        panel._load !== token || this._open !== row.id;
    // Each renderer below measures the panel BEFORE swapping content and animates
    // from that height to the new one, so the panel grows instead of jumping.
    if (!box.querySelector(".loading")) box.innerHTML = `<div class="loading">Loading history…</div>`;
    const failed = () => {
      const h = panel.offsetHeight;
      box.innerHTML = `<div class="loading">The history did not load.
        <button class="more" data-retry="1">Try again</button></div>`;
      this._resizeDetail(panel, h);
    };

    if (this._view === "devices" || this._view === "helpers" || this._view === "ignored") {
      const [res, R, IG, F] = await Promise.all([this._ws({
        type: "history/history_during_period",
        start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: row.members, minimal_response: true, no_attributes: true,
        significant_changes_only: false,
      }), this._restartInfo(), this._ignoreInfo(), isJob(row) ? this._failureInfo() : null]);
      if (stale()) return;
      if (!res) { failed(); return; }
      const h = panel.offsetHeight;
      this._drawTimeline(box, row, res, R, start, end, IG, F);
      this._resizeDetail(panel, h);
      return;
    }

    const target = this._view === "battery" ? row.batterySource : row.signalSource;
    if (!target) {
      const h = panel.offsetHeight;
      box.innerHTML = `<div class="dhead">${this._view === "battery" ? "Battery" : "Signal"}</div>
        <div class="loading">No ${this._view === "battery" ? "battery" : "signal"} sensor is bound to this device.</div>`;
      this._resizeDetail(panel, h);
      return;
    }
    const res = await this._ws({
      type: "history/history_during_period",
      start_time: start.toISOString(), end_time: end.toISOString(),
      entity_ids: [target], minimal_response: true, no_attributes: true,
      significant_changes_only: false,
    });
    if (stale()) return;
    if (!res) { failed(); return; }
    const h = panel.offsetHeight;
    this._drawSeries(box, row, target, res[target] || [], start, end);
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
      <ha-card class="${this._config.embedded ? "embedded" : ""}">
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
              <button class="lg on" data-s="0"><i style="--c:${COL.bad}"></i>Problems</button>
              <button class="lg on" data-s="1"><i style="--c:${COL.battery}"></i>Low battery</button>
              <button class="lg on" data-s="2"><i style="--c:${COL.signal}"></i>Weak signal</button>
            </span>
            <div class="ranges" id="ranges">
              ${RANGES.map((r) => `<button class="rg${r.id === this._range ? " on" : ""}" data-r="${r.id}">${r.label}</button>`).join("")}
            </div>
          </div>
          <div class="chartwrap" id="overview">
            <div class="chartsvg" id="chartsvg"></div>
            <div class="ctip" id="ctip" hidden></div>
          </div>
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
          <div class="ms" id="msStatus">
            <button class="msbtn" data-for="status"><span class="mslabel"></span>
              <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
            <div class="mspanel"></div>
          </div>
          <div class="ms" id="msPlatform">
            <button class="msbtn" data-for="platform"><span class="mslabel"></span>
              <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
            <div class="mspanel"></div>
          </div>
          <div class="ms" id="msArea">
            <button class="msbtn" data-for="area"><span class="mslabel"></span>
              <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
            <div class="mspanel"></div>
          </div>
          <button class="pin" id="pin" hidden></button>
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
        <dialog class="idlg" id="idlg" aria-label="Event details">
          <div class="iscrim"></div><div class="ipop" tabindex="-1"></div>
        </dialog>
      </ha-card>`;

    const $ = (id) => this.shadowRoot.getElementById(id);
    this._el = {
      ranges: $("ranges"), legend: $("legend"), overview: $("overview"), views: $("views"),
      chartsvg: $("chartsvg"), ctip: $("ctip"), pin: $("pin"),
      ...Object.fromEntries(STATS.map((s) => [`t_${s.id}`, $(`t_${s.id}`)])),
      ...Object.fromEntries(STATS.map((s) => [`s_${s.id}`, $(`s_${s.id}`)])),
      ...Object.fromEntries(STATS.map((s) => [`d_${s.id}`, $(`d_${s.id}`)])),
      q: $("q"), msStatus: $("msStatus"), msPlatform: $("msPlatform"), msArea: $("msArea"), clear: $("clear"),
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
      this._pinned = null;

      // Every tile is exactly one tab - except Ignored, whose list (devices and helpers
      // mixed) no tab owns: none is chosen, and its chip or Reset leads back to Devices.
      this._setView(id);
      if (id === "ignored") {
        this._paintFilters();
        this._paintTable();
        this._scrollToTable();
        return;
      }

      /* The tile counts the BAD rows, so it lands on the bad rows — showing the
         healthy ones too answers a question nobody asked by tapping "1 Offline".
         At zero there is nothing to isolate, so the tab is left unfiltered
         rather than filtered down to an empty table. */
      const badHelpers = this._data.rows.filter((r) => !isDevice(r) && (r.offline || r.failed));
      const bad = { devices: this._data.rows.filter((r) => isDevice(r) && r.offline).length,
                    helpers: badHelpers.length,
                    battery: this._data.lowBattery, signal: this._data.poorSignal }[id];
      if (bad > 0) {
        if (id === "signal") this._statuses.add("Weak signal");
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
      this._syncUrl();
      this._loadOverview();
      if (this._open) this._loadDetail(this._data.rows.find((r) => r.id === this._open));
    });

    this._el.views.addEventListener("click", (e) => {
      const b = e.target.closest(".vw"); if (!b) return;
      this._pinned = null;     // a chart pick belongs to the tab it opened
      this._setView(b.dataset.v);
      this._paint();
    });

    /* The problem chart answers WHICH devices, not just how many. Hover (or drag a
       finger across it) and a tooltip names the devices behind every bar of that
       slot; a tap or click on a bar shows exactly those devices in the table.
       pan-y on the chart (CSS) keeps vertical scrolling on the page while a
       sideways drag scrubs the slots. */
    const chart = this._el.overview;
    chart.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" || this._press) this._hoverChart(e);
    });
    chart.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") this._hideTip(); });
    chart.addEventListener("pointerdown", (e) => {
      this._press = { x: e.clientX, y: e.clientY };
      this._hoverChart(e);
    });
    chart.addEventListener("pointerup", (e) => {
      const p = this._press;
      this._press = null;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 10) this._pickChart(e);
      else if (e.pointerType !== "mouse") this._hideTip();
    });
    chart.addEventListener("pointercancel", () => { this._press = null; this._hideTip(); });

    this._el.pin.addEventListener("click", () => {
      // letting go of the Ignored list goes back to the default tab
      if (!this._pinned && this._view === "ignored") this._setView("devices");
      this._pinned = null; this._sig = ""; this._paintFilters(); this._paintTable();
    });

    this._el.q.addEventListener("input", () => {
      this._q = this._el.q.value.trim(); this._sig = ""; this._paintTable();
    });

    for (const [host, which] of [[this._el.msStatus, "status"], [this._el.msPlatform, "platform"],
                                 [this._el.msArea, "area"]]) {
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
        if (act) {
          for (const g of this._menu(which).groups) {
            const set = this._setOf(g.key);
            if (act.dataset.a === "none") set.clear();
            else for (const x of g.values) set.add(x.v);
          }
        } else if (opt) {
          const set = this._setOf(opt.dataset.g);
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
      if (this._view === "ignored") this._setView("devices");   // the default view
      this._q = ""; this._platforms.clear(); this._areas.clear();
      this._statuses.clear(); this._qualities.clear(); this._pinned = null;
      this._el.q.value = ""; this._sig = "";
      this._closeMenus(); this._paintFilters(); this._paintTable();
    });

    /* One delegated listener for the whole table. Rows are reused across repaints
       now, so attaching handlers per row would either leak them or need rewiring
       every patch. */
    this._wireInfo();
    this._el.tbody.addEventListener("keydown", (e) => {
      const ev = (e.key === "Enter" || e.key === " ") && e.target.closest?.("[data-evi]");
      if (ev) { e.preventDefault(); this._showEvent(ev); }
    });
    this._el.tbody.addEventListener("click", (e) => {
      const mi = e.target.closest("[data-moreinfo]");
      if (mi) { e.stopPropagation(); this._openSettings(mi.dataset.moreinfo); return; }
      const ig = e.target.closest("[data-ignore]");
      if (ig) { e.stopPropagation(); this._openIgnore(ig); return; }
      const ev = e.target.closest("[data-evi]");
      if (ev) { e.stopPropagation(); this._showEvent(ev); return; }
      const nav = e.target.closest("[data-nav]");
      if (nav) {
        e.stopPropagation();
        history.pushState(null, "", nav.dataset.nav);
        this.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
        return;
      }
      const tag = e.target.closest(".tag[data-f]");
      if (tag) { e.stopPropagation(); this._toggleFilter(tag.dataset.f, tag.dataset.v); return; }
      const tlb = e.target.closest("[data-tl]");
      if (tlb) {
        e.stopPropagation();
        const tl = tlb.closest(".tl");
        tl._page += Number(tlb.dataset.tl);
        this._paintTl(tl, Number(tlb.dataset.tl));
        return;
      }
      const retry = e.target.closest("[data-retry]");
      if (retry) { e.stopPropagation(); this._renderDetail(this._open); return; }
      const tr = e.target.closest(".tr");
      if (tr) this._toggle(tr.dataset.id);
    });

    this._built = true;
    this._observe();
  }

  /* Size watchers: the chart, the sticky filter bar and the filter labels. Dropped while
     the card is off screen (HA keeps a left view's cards), so set up again on return. */
  _observe() {
    if (!this._built || !this.isConnected) return;
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

    this._labRo?.disconnect();
    this._labRo = new ResizeObserver((es) => es.forEach((x) => fitPills(x.target)));
    for (const host of [this._el.msStatus, this._el.msPlatform, this._el.msArea]) {
      this._labRo.observe(host.querySelector(".mslabel"));
    }
  }

  _setOf(key) {
    return { platform: this._platforms, area: this._areas,
             status: this._statuses, quality: this._qualities }[key];
  }

  /* A filter menu, for the tab on show: its sections, each with its values, their colour
     and how many of the tab's rows have each. Status lists the tab's own statuses
     (statusOf), worst first; the Signal tab adds its quality grades. */
  _menu(which) {
    const base = this._baseRows();
    const count = (fn) => {
      const n = {};
      for (const r of base) { const k = fn(r); n[k] = (n[k] || 0) + 1; }
      return n;
    };
    if (which === "status") {
      const n = count((r) => statusOf(r, this._view).text);
      const groups = [{ key: "status", title: "Status", values: (STATUS_NAMES[this._view] || [])
        .map((v) => ({ v, l: this._word(v), tone: STATUS_TONE[v], n: n[v] || 0 })) }];
      if (this._view === "signal") {
        const q = count((r) => r.quality);
        groups.push({ key: "quality", title: "Signal quality", values: ["Poor", "OK", "Good"]
          .map((v) => ({ v, tone: qualityTone(v), n: q[v] || 0 })) });
      }
      return { empty: "All statuses", groups };
    }
    const n = count((r) => r[which]);
    const values = [...new Set(this._data.rows.map((r) => r[which]))].sort((a, b) => a.localeCompare(b));
    return { empty: which === "platform" ? "All integrations" : "All areas",
             groups: [{ key: which, values: values.map((v) => ({ v, n: n[v] || 0 })) }] };
  }

  /* Paint a filter menu: its options (rebuilt only when they change - re-rendering an
     open menu would detach the very element the finger is on, so a second tick lands on
     a dead node, and lose the scroll position mid-selection; otherwise ticks and counts
     in place) and its button, which names what is picked. */
  _syncMenu(host, which) {
    const spec = this._menu(which);
    const panel = host.querySelector(".mspanel");
    const shape = spec.groups.map((g) => g.key + ":" + g.values.map((x) => x.v + (x.l || "")).join("|")).join("::");
    if (panel._shape !== shape) {
      panel._shape = shape;
      panel.innerHTML =
        `<div class="msacts">
           <button class="msact" data-a="all">Select all</button>
           <button class="msact" data-a="none">Clear</button>
         </div>` +
        spec.groups.map((g) => (g.title ? `<div class="msgh t-label">${g.title}</div>` : "") +
          g.values.map((x) => `<button class="msopt" data-g="${g.key}" data-v="${escapeHtml(x.v)}">
              <span class="box"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span>
              ${x.tone ? `<span class="msdot" style="--c:${x.tone}"></span>` : ""}
              <span class="msname">${escapeHtml(x.l || x.v)}</span>
              <span class="mscount"></span></button>`).join("")).join("");
    }
    const opts = panel.querySelectorAll(".msopt");
    let i = 0;
    for (const g of spec.groups) {
      const set = this._setOf(g.key);
      for (const x of g.values) {
        const o = opts[i++];
        o.classList.toggle("on", set.has(x.v));
        const c = o.querySelector(".mscount");
        if (c.textContent !== String(x.n)) c.textContent = x.n;
      }
    }
    paintPicked(host, spec, (k) => this._setOf(k));
  }

  /* Clicking a value in the Integration or Area column is the same action as
     ticking it in that column's dropdown — same Set, so the menu shows it checked
     and the button label updates. Clicking it again removes it, which is what a
     toggle that looks like a chip is expected to do. */
  _toggleFilter(which, value) {
    const set = this._setOf(which);
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
  _scrollToTable(target = null) {
    /* Measure the NON-sticky body, never the header block. A sticky element
       reports its STUCK rect once it has pinned, so anchoring on it lands the
       scroll wherever it already is — which is how the old version buried the
       tabs and the first row. Target: first row sits just under the pinned block,
       pinned block sits just under HA's toolbar. */
    const head = this.shadowRoot.querySelector(".stickyhead");
    const thead = this.shadowRoot.querySelector(".thead");
    // the table's first row, or a row asked for (a link's hm_open)
    const body = target || this.shadowRoot.querySelector(".tbody");
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
    // what is ignored is watched by nobody: counted on its own tile, in no other total
    // ("73 Devices Online" with the dead doorbell camera ignored was untrue)
    const watched = d.rows.filter((r) => !r.ignored);
    const devices = watched.filter(isDevice);
    const helpers = watched.filter((r) => !isDevice(r));
    const withBattery = watched.filter((r) => r.battery !== null);
    const withSignal = watched.filter((r) => r.rssi !== null);
    const ignored = d.rows.filter((r) => r.ignored).length;
    const pair = {
      ignored: { bad: ignored, total: ignored },
      devices: { bad: devices.filter((r) => r.offline).length, total: devices.length },
      // A helper is a problem when it is down OR its latest run failed.
      helpers: { bad: helpers.filter((r) => r.offline || r.failed).length, total: helpers.length },
      battery: { bad: withBattery.filter((r) => r.lowBattery).length, total: withBattery.length },
      signal: { bad: withSignal.filter((r) => r.poorSignal).length, total: withSignal.length },
    };
    this._pair = pair;

    // after the first paint, a tile coming or going (Ignored) fades and scales
    const live = this._tilesPainted && !reduceMotion();
    for (const s of STATS) {
      // Hide a tile whose check is switched off: it could only ever read zero,
      // which looks like a clean bill of health for something nobody is watching.
      // Ignored shows only while something is ignored.
      const tile = this._el[`t_${s.id}`].parentElement.parentElement;
      const on = (!s.needs || d.features[s.needs]) && (!s.plain || pair[s.id].bad > 0);
      if (on && (tile.hidden || tile._leaving)) {
        tile._leaving?.cancel(); tile._leaving = null;
        const appearing = tile.hidden;
        tile.hidden = false;
        if (appearing && live) tile.animate([{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "none" }],
          { duration: 340, easing: IOS_SOFT });
      } else if (!on && !tile.hidden && !tile._leaving) {
        if (!live) tile.hidden = true;
        else {
          const out = tile._leaving = tile.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.92)" }],
            { duration: 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
          out.onfinish = () => { if (tile._leaving !== out) return; tile.hidden = true; out.cancel(); tile._leaving = null; };
        }
      }
      if (!on) continue;

      const { bad, total } = pair[s.id];
      const big = this._el[`t_${s.id}`];
      const den = this._el[`d_${s.id}`];
      const lab = this._el[`s_${s.id}`];

      big.textContent = bad > 0 || s.plain ? bad : total;
      den.textContent = bad > 0 && !s.plain ? `/ ${total}` : "";
      lab.textContent = bad > 0 ? s.bad : s.ok;

      // a problem count takes its colour; Ignored stays white on grey, readable
      const hot = bad > 0 && !s.plain;
      big.style.color = hot ? s.tone : "";
      lab.style.color = hot ? s.tone : "";
      tile.style.setProperty("--tc", s.tone);
      tile.classList.toggle("hot", hot);

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
    this._tilesPainted = true;
    this._paintFilters();
    this._paintTable();
  }

  _paintFilters() {
    // The chart pick shows as a chip in the category's colour; tapping it lets go.
    // The Ignored tile's list shows the same chip.
    const pin = this._el.pin;
    const pick = this._pinned || (this._view === "ignored" ? { label: "Ignored", tone: COL.ignored } : null);
    if (pick) {
      // An alert's rows: a bell in the alert's priority colour, its name, and how many of
      // the rows the other filters show are its own - "2 of 6 unavailable", so the table is
      // never mistaken for every unavailable device
      const al = pick.alert ? this._hass?.states?.[pick.alert] : null;
      let html;
      if (pick.alert) {
        const n = this._visible().length;
        const m = this._visible(true).length;
        const st = this._statuses.size === 1 ? ` ${this._word([...this._statuses][0]).toLowerCase()}` : "";
        pick.tone = PRIORITY_TONE[al?.attributes?.priority] || COL.bad;
        html = `<svg class="pinic" viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>
          <span class="pinlab">${escapeHtml(al?.attributes?.friendly_name || "From alert")}</span>
          <span class="pinn">${n} of ${m}${escapeHtml(st)}</span>
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
      } else {
        html = `<span class="pindot" style="--c:${pick.tone}"></span>
          <span class="pinlab">${escapeHtml(pick.label)}</span>
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
      }
      if (pin._html !== html) { pin._html = html; pin.innerHTML = html; }
      pin.title = pick.alert ? "Only what this alert is about. Tap to show them all" : "";
      pin.style.setProperty("--c", pick.tone);
      pin.hidden = false;
    } else if (!pin.hidden) {
      pin.hidden = true; pin._html = "";
    }
    this._syncMenu(this._el.msStatus, "status");
    this._syncMenu(this._el.msPlatform, "platform");
    this._syncMenu(this._el.msArea, "area");
  }

  _paintTable() {
    this._syncUrl();
    // Reset stands out while it has a filter to clear
    this._el.clear.classList.toggle("on", !!(this._q || this._platforms.size || this._areas.size ||
      this._statuses.size || this._qualities.size || this._pinned || this._view === "ignored"));
    const cols = COLUMNS[this._view];
    const all = this._visible();
    // an open row that has left the list (stopped being ignored in the Ignored list) is open
    // no more - nor in the address
    if (this._open && !all.some((r) => r.id === this._open)) { this._open = null; this._syncUrl(); }
    const grid = cols.map((c) => c.w).join(" ") + " 40px";

    /* Reset to page 1 whenever the SCOPE changes. Centralised here because a page
       number that survives a filter change silently strands you on an empty page. */
    const scope = this._view + this._sort.col + this._sort.dir +
      [...this._platforms].sort().join(",") + [...this._areas].sort().join(",") + this._q +
      (this._pinned ? this._pinned.label : "");
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
          return `<button class="th t-label${on ? " on" : ""}${c.align === "right" ? " r" : ""}" data-c="${c.id}"${
                    c.pad ? ` style="padding-right:${c.pad}px"` : ""}>
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
      rows.map((r) => `${r.id}${r.offline}${r.lowBattery}${r.poorSignal}${r.battery}${r.rssi}${r.failed}${r.stale}${r.ignored}${r.down}`).join("|");
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
      // the Ignored list with nothing ignored says so
      const msg = this._view === "ignored" && !this._data.rows.some((r) => r.ignored)
        ? "Nothing Ignored" : "No devices match these filters";
      if (body._empty !== msg) {
        const first = !body._empty;
        body.innerHTML = `<div class="none">${msg}</div>`;
        body._empty = msg;
        if (first && !reduceMotion()) body.firstElementChild.animate(
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

  /* The line under a row's name. Battery and Signal: the sensor the reading comes from
     (the one the row's chart draws). Elsewhere: how many entities the integration
     watches for availability - only those, not every entity the device has
     (diagnostic and stateless ones are left out) - or the entity itself when it is
     the only one. */
  _subline(r) {
    if (this._view === "battery" && r.batterySource) return r.batterySource;
    if (this._view === "signal" && r.signalSource) return r.signalSource;
    return r.members.length > 1 ? `${r.members.length} Entities Monitored` : r.id;
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
                    <i>${escapeHtml(this._subline(r))}</i></span></span>`;
        case "platform":
          return `<button class="tag${this._platforms.has(r.platform) ? " on" : ""}" data-f="platform" data-v="${escapeHtml(r.platform)}"
                    title="Filter by ${escapeHtml(r.platform)}">${escapeHtml(r.platform)}</button>`;
        case "area":
          return `<button class="tag${this._areas.has(r.area) ? " on" : ""}" data-f="area" data-v="${escapeHtml(r.area)}"
                    title="Filter by ${escapeHtml(r.area)}">${escapeHtml(r.area)}</button>`;
        case "status":
          return `<button class="tag stt${this._statuses.has(statusText) ? " on" : ""}"
                    data-f="status" data-v="${escapeHtml(statusText)}" style="--c:${tone}"
                    title="Filter by ${escapeHtml(this._word(statusText))}">${escapeHtml(this._word(statusText))}</button>`;
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
      cols.map((c) => `<span class="td${c.align === "right" ? " r" : ""}"${
        c.pad ? ` style="padding-right:${c.pad}px"` : ""}>${cell(c)}</span>`).join("") +
      `<span class="td acts">
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

  /* The open row's actions, top left: More Info (the device's page, or an entity's
     settings), and Ignore - which reads "Ignored until …" in the selection white while it
     holds. Repainted in place when the row's status changes. */
  _paintActions() {
    const bar = this._el?.tbody.querySelector(".detail:not(.closing) .dactions");
    const row = bar && this._data?.rows.find((r) => r.id === this._open);
    if (!row) return;
    const id = escapeHtml(row.id);
    const html = `<button class="navbtn primary" data-moreinfo="${id}"
        title="${row.deviceId ? "The device's page" : "The entity's settings"}">More Info</button>` +
      (row.ignored
        ? `<button class="navbtn ignored" data-ignore="${id}">${row.ignoredUntil
            ? `Ignored until ${escapeHtml(fmtDT(row.ignoredUntil))}` : "Ignored"}</button>`
        : `<button class="navbtn primary" data-ignore="${id}">Ignore</button>`);
    if (bar._html !== html) { bar._html = html; bar.innerHTML = html; }
  }

  /* Ignore: a menu like the Alerts card's snooze sheet - for a day, a week, or until
     someone stops it; while ignored, Stop ignoring first. */
  _openIgnore(btn) {
    if (this._info.dlg.open) { this._hideInfo(); return; }
    const row = this._data.rows.find((r) => r.id === btn.dataset.ignore);
    if (!row) return;
    const now = Date.now();
    const opt = (key, label, until) => `<button class="srow" data-ign="${key}"><span>${label}</span>${
      until ? `<span class="sval">until ${escapeHtml(fmtDT(until))}</span>` : ""}</button>`;
    const head = row.ignored
      ? `<div class="shead"><div class="stitle">Ignored ${row.ignoredUntil
          ? `until ${escapeHtml(fmtDT(row.ignoredUntil))}` : "until you stop it"}</div></div>`
      : `<div class="shead"><div class="stitle">Ignore this ${isDevice(row) ? "device" : "helper"}</div>
          <div class="ssub">While ignored it raises no alerts and shows no problems.</div></div>`;
    this._info.ignoreRow = row.id;
    this._popAt(btn, head +
      (row.ignored ? `<button class="srow end" data-ign="stop"><span>Stop ignoring</span></button>` : "") +
      opt("1440", "For 1 day", now + DAY_MS) + opt("10080", "For 1 week", now + 7 * DAY_MS) +
      // not offered again while it already holds that way
      (row.ignored && !row.ignoredUntil ? "" : opt("forever", "Until I stop it")), "menu");
  }

  /* Set or end an ignore: every entity of the row suppressed (or let go) at once - the
     Health integration then leaves the row out of every problem list, and logs who did it. */
  async _ignore(rowId, choice) {
    const row = this._data.rows.find((r) => r.id === rowId);
    await this._hideInfo();
    if (!row) return;
    const call = (service, data = {}) =>
      this._hass.callService("entity_availability", service, { entity_id: row.members, ...data });
    try {
      if (choice === "stop") await call("unsuppress");
      else if (choice === "forever") await call("suppress_indefinitely");
      else await call("suppress", { duration: Number(choice) });
    } catch (err) {
      this.dispatchEvent(new CustomEvent("hass-notification", { bubbles: true, composed: true,
        detail: { message: `Could not change the ignore: ${err?.message || err}` } }));
      return;
    }
    // its timeline gains the entry
    this._ignoreCache = null;
    if (this._open === rowId) this._renderDetail(rowId);
  }

  /* Who ignored what and when (the Health integration's ignore log) - read once a minute
     at most, and again after an ignore is set or ended here. */
  async _ignoreInfo() {
    const c = this._ignoreCache;
    if (c && Date.now() - c.at < 60e3) return c.list;
    const res = await this._ws({ type: "entity_availability/ignores" });
    const list = res?.ignores || [];
    this._ignoreCache = { at: Date.now(), list };
    return list;
  }

  /* When automations and scripts were failing (the integration's failure log) - read once a
     minute at most. */
  async _failureInfo() {
    const c = this._failureCache;
    if (c && Date.now() - c.at < 60e3) return c.map;
    const res = await this._ws({ type: "entity_availability/failures" });
    const map = res?.failures || {};
    this._failureCache = { at: Date.now(), map };
    return map;
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

    body.querySelectorAll(".detail:not(.closing)").forEach((d) => this._collapseDetail(d));
    body.querySelector(".tr.open")?.classList.remove("open");
    body.querySelector(".chev.up")?.classList.remove("up");

    this._open = wasOpen ? null : id;
    this._syncUrl();
    if (!this._open) return;

    const row = body.querySelector(`.tr[data-id="${id}"]`);
    if (!row) return;
    row.classList.add("open");
    row.querySelector(".chev")?.classList.add("up");

    const detail = document.createElement("div");
    detail.className = "detail";
    // the row's actions, at once and above what is still loading
    detail.innerHTML = `<div class="dactions"></div><div class="detailBody"><div class="loading">Loading history…</div></div>`;
    row.parentElement.appendChild(detail);
    this._paintActions();
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

  /* A closing panel is marked so nothing treats it as the open one: a history that
     arrives late does not draw into it, and its close animation is never cancelled
     (a cancelled close left the panel behind for good). */
  _collapseDetail(detail) {
    detail.classList.add("closing");
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
    if (reduceMotion() || detail.classList.contains("closing")) return;
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

  /* Problem COUNTS OVER TIME as grouped bars, each anchored at zero (Grafana style).
   *
   * Slots are aligned to the clock (1 h on 24h, …) and sized so a slot is
   * at least ~48px wide: every slot is a TOUCH target as well as a bar. A bar is the
   * number of distinct devices that had the problem at any moment of its slot — the
   * same set the tooltip lists and a tap filters the table to, so the three can never
   * disagree. Where the history predates the device lists (battery/signal before they
   * were recorded) the bar falls back to the highest count seen in the slot. */
  _drawOverview() {
    const host = this._el?.chartsvg;
    if (!host || !this._overview) return;
    const { res, ids, start, end } = this._overview;
    const W = this._el.overview.clientWidth || 700;
    const H = 190;
    const P = { l: 32, r: 32, t: 10, b: 30 };
    const plotW = W - P.l - P.r;
    const t1 = end.getTime();
    const slots = this._slotsFor(start, end);
    /* The x axis spans WHOLE slots — from the first slot's start to the end of the one
       in progress — so every bar is the same width. Clipping the axis to the window
       made the first and last bars narrower than the rest. A narrower card means a
       longer step and possibly an earlier first slot than the data covers: refetch. */
    if (slots[0].a < this._overview.from.getTime() && !this._refetching) {
      this._refetching = true;
      this._loadOverview().finally(() => { this._refetching = false; });
    }
    const t0 = slots[0].a, tEnd = slots[slots.length - 1].b, span = tEnd - t0;
    const xt = (t) => P.l + ((t - t0) / span) * plotW;
    const series = ids.map((id, k) => ({
      color: [COL.bad, COL.battery, COL.signal][k],
      name: ["Problems", "Low battery", "Weak signal"][k],
      per: k === 0
        ? problemSets(res, this._base, slots, t1, this._hass?.states?.[`${this._base}_group_summary`]?.attributes?.failed_entities,
            (x) => (this._data && this._rowFor(x)?.id) || x)
        : slotSets(res[id] || [], slots, t1, listIds),
    }));
    /* A bar counts what a tap on it lists: each entity as its row, once - not one since removed
       from Home Assistant (no row can show it), nor, for battery and signal, a row their tab
       does not list. A count kept without names stays a count. */
    const inTab = [() => true, (r) => r.battery !== null, (r) => r.rssi !== null];
    if (this._data) {
      series.forEach((s, k) => {
        s.per = s.per.map((p) => {
          if (!p.ids) return p;
          const ids = new Set();
          for (const x of p.ids) { const r = this._rowFor(x); if (r && inTab[k](r)) ids.add(r.id); }
          return { v: ids.size, ids: ids.size ? ids : null };
        });
      });
    }
    this._chart = { slots, series, P, W, H, xt, t0, t1 };

    /* A problem with no bar anywhere in the window takes no room in the slots: it would
       only leave a gap in every group and make the real bars narrower. Its legend
       entry stays, so the category is still visibly there. */
    const shown = series.map((s, k) => ({ ...s, k }))
      .filter((s) => this._series.has(s.k) && s.per.some((p) => p.v > 0));
    const max = Math.max(1, ...shown.flatMap((s) => s.per.map((p) => p.v)));
    const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
    const base = H - P.b;
    const n = shown.length || 1;

    const grid = niceTicks(max)
      .map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="${COL.grid}"/>
        <text x="${P.l - 8}" y="${y(v) + 5}" class="ax" text-anchor="end">${v}</text>`).join("");

    // The marks every chart in the card carries for the CHOSEN range (24h, 3d, 7d) -
    // the availability band's own (axisMarks, for its track width) - placed on this
    // chart's whole-slot axis.
    const marks = axisMarks(start.getTime(), t1, bandTrackWidth(W)).map(({ t, label }) =>
      `<line x1="${xt(t)}" x2="${xt(t)}" y1="${P.t}" y2="${H - P.b}" stroke="${COL.grid}"/>
       <text x="${xt(t)}" y="${H - 9}" class="ax" text-anchor="middle">${label}</text>`);

    // Bar geometry per slot, kept for hit-testing a tap to the bar under the finger.
    const bars = [];
    this._chart.geo = slots.map((sl, i) => {
      const x0 = xt(sl.a), x1 = xt(sl.b);
      const w = x1 - x0;
      const pad = Math.max(3, w * 0.18);
      const inner = Math.min(3, w * 0.04);
      const bw = Math.max(3, (w - pad - inner * (n - 1)) / n);
      const gx = x0 + (w - (bw * n + inner * (n - 1))) / 2;
      const cells = [];
      shown.forEach((s, j) => {
        const v = s.per[i].v;
        const bx = gx + j * (bw + inner);
        cells.push({ k: s.k, x: bx, w: bw, v });
        if (!v) return;
        // 3px floor: one device down must always be visible.
        const h = Math.max(3, (v / max) * (H - P.t - P.b));
        bars.push(`<rect class="cbar" x="${bx.toFixed(1)}" y="${(base - h).toFixed(1)}" ` +
          `width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 3).toFixed(1)}" ` +
          `fill="${s.color}" style="--d:${i * 12}ms"/>`);
      });
      // nothing at all in the slot: a short white stub at zero, a bar wide, in the middle - an
      // empty slot reads as a zero, not as a gap (as the Alerts card's chart)
      if (!cells.some((c) => c.v)) {
        const zx = gx + (bw * n + inner * (n - 1) - bw) / 2;
        bars.push(`<rect class="cbar" x="${zx.toFixed(1)}" y="${(base - 3).toFixed(1)}" width="${bw.toFixed(1)}" ` +
          `height="3" rx="1.5" fill="#fff" style="--d:${i * 12}ms"/>`);
      }
      return { x0, x1, cells };
    });

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      <rect class="hband" id="hband" x="0" y="${P.t}" width="0" height="${H - P.t - P.b}" rx="6"/>
      ${grid}${marks.join("")}${bars.join("")}</svg>`;
    this._hoverSlot = -1;
    if (!this._el.ctip.hidden) this._hideTip();
  }

  /* Which slot is under the pointer, by x. */
  _slotAt(e) {
    const c = this._chart;
    if (!c) return -1;
    const r = this._el.overview.getBoundingClientRect();
    const x = (e.clientX - r.left) * (c.W / r.width);
    if (x < c.P.l || x > c.W - c.P.r) return -1;
    return c.geo.findIndex((g) => x >= g.x0 && x < g.x1);
  }

  _hoverChart(e) {
    const i = this._slotAt(e);
    if (i < 0) { if (e.pointerType === "mouse") this._hideTip(); return; }
    if (i === this._hoverSlot) return;
    this._hoverSlot = i;
    const c = this._chart;
    const g = c.geo[i];
    const band = this.shadowRoot.getElementById("hband");
    if (band) { band.setAttribute("x", g.x0.toFixed(1)); band.setAttribute("width", (g.x1 - g.x0).toFixed(1)); }

    const tip = this._el.ctip;
    tip.innerHTML = this._tipHtml(i);
    tip.hidden = false;
    // Beside the slot, on whichever side has room, never past the card's edges.
    const wrap = this._el.overview.getBoundingClientRect();
    const scale = wrap.width / c.W;
    const tw = tip.offsetWidth;
    const right = g.x1 * scale + 12;
    const left = g.x0 * scale - 12 - tw;
    const x = right + tw <= wrap.width ? right : Math.max(0, left);
    tip.style.transform = `translate(${Math.round(x)}px, 0)`;
  }

  _hideTip() {
    this._hoverSlot = -1;
    if (this._el?.ctip) this._el.ctip.hidden = true;
    const band = this.shadowRoot?.getElementById("hband");
    if (band) band.setAttribute("width", "0");
  }

  _tipHtml(i) {
    const c = this._chart;
    const sl = c.slots[i];
    const parts = c.series
      .map((s, k) => ({ s, k, p: s.per[i] }))
      .filter(({ k, p }) => this._series.has(k) && p.v > 0)
      .map((x) => ({ ...x, names: x.p.ids
        ? [...x.p.ids].map((id) => this._nameOf(id)).sort((a, b) => a.localeCompare(b)) : [] }));
    /* At most TIP_NAMES names in the whole tooltip, shared out evenly between the
       problems shown; room one of them does not need goes to the others. Whatever
       does not fit is "+N more" at the end of its own list. */
    const room = shareOut(parts.map((x) => x.names.length), TIP_NAMES);
    const secs = parts.map(({ s, p, names }, j) => {
      const list = names.slice(0, room[j]).map((nm) => `<li>${escapeHtml(nm)}</li>`).join("") +
        (names.length > room[j] ? `<li class="tmore">and ${names.length - room[j]} more</li>` : "");
      return `<div class="tsec" style="--c:${s.color}">
          <div class="thd"><i></i>${s.name}<b>${p.v}</b></div>
          ${list ? `<ul>${list}</ul>` : ""}</div>`;
    }).join("");
    return `<div class="twhen">${escapeHtml(fmtSlot(sl.a, sl.b))}</div>` +
      (secs || `<div class="tnone">No problems</div>`);
  }

  /* A device id from the chart history → the row's display name. Ids are the
     integration's representative entities; any member of a row maps to that row. */
  _nameOf(id) {
    const row = this._rowFor(id);
    if (row) return row.name;
    return this._hass?.states?.[id]?.attributes?.friendly_name || id;
  }

  _rowFor(id) {
    if (this._rowIndexFor !== this._data) {
      this._rowIndexFor = this._data;
      this._rowIndex = new Map();
      this._devIndex = new Map();
      const ents = this._hass?.entities || {};
      for (const r of this._data.rows) {
        this._rowIndex.set(r.id, r);
        for (const m of r.members) {
          if (!this._rowIndex.has(m)) this._rowIndex.set(m, r);
          const dev = ents[m]?.device_id;
          if (dev && !this._devIndex.has(dev)) this._devIndex.set(dev, r);
        }
      }
    }
    // an entity of the device that is no longer one of its row's members (history names the
    // entity that was the device's then): the row of its device
    return this._rowIndex.get(id) || this._devIndex.get(this._hass?.entities?.[id]?.device_id) || null;
  }

  /* A tap or click on a bar: the table shows exactly the devices behind it. Picks the
     bar nearest the pointer within the slot, so a tap between bars still counts. */
  _pickChart(e) {
    const i = this._slotAt(e);
    if (i < 0) return;
    const c = this._chart;
    const r = this._el.overview.getBoundingClientRect();
    const x = (e.clientX - r.left) * (c.W / r.width);
    const cells = c.geo[i].cells.filter((cell) => cell.v > 0);
    if (!cells.length) return;
    const cell = cells.reduce((best, cur) =>
      Math.abs(cur.x + cur.w / 2 - x) < Math.abs(best.x + best.w / 2 - x) ? cur : best);
    const s = c.series[cell.k];
    const p = s.per[i];
    const sl = c.slots[i];
    const view = ["devices", "battery", "signal"][cell.k];

    this._platforms.clear(); this._areas.clear(); this._statuses.clear(); this._qualities.clear();
    this._q = ""; this._el.q.value = "";
    if (p.ids) {
      const rows = new Set();
      for (const id of p.ids) { const row = this._rowFor(id); if (row) rows.add(row.id); }
      // Same routing rule as the tiles: devices if any device is affected, else helpers -
      // and Problems lists its helpers along with its devices (`both`), all it counted.
      const picked = this._data.rows.filter((row) => rows.has(row.id));
      const tab = cell.k === 0 ? (picked.some(isDevice) ? "devices" : "helpers") : view;
      this._setView(tab);
      this._pinned = {
        rows, tone: s.color, both: cell.k === 0,
        label: `${s.name} · ${fmtSlot(sl.a, sl.b)}`,
      };
    } else {
      // Older history without device lists: the closest honest answer is the tab.
      this._setView(view);
      this._pinned = null;
    }
    this._hideTip();
    this._paintFilters();
    this._paintTable();
    this._scrollToTable();
  }

  /* Availability, and only availability: per member entity, over the chart's range,
     Available / Unavailable / Brief drop-out / Restarting as the integration judges them
     (availSegments), and below it the timeline of those changes, newest first, with
     each Home Assistant restart once. The entities' states themselves (on, off,
     21.5 °C) are never shown: a light switching on is not an availability event.

     The band is drawn by state-history-card (our fork under www/state-history-card),
     the one state visualisation used across these dashboards, with an entity-label
     column beside each track. It is handed a view of hass in which each member's
     state IS its availability (_availHass). */
  _drawTimeline(box, row, res, R, start, end, IG = [], F = null) {
    const ids = row.members.filter((m) => (res[m] || []).length);
    const startMs = start.getTime(), endMs = end.getTime();
    const pts = Object.fromEntries(ids.map((m) => [m, availSegments(res[m], R, endMs)]));
    // a job: red while its runs were failing - its availability alone is green all along
    const fails = isJob(row) ? failSpans(row, F) : [];
    if (pts[row.id]) pts[row.id] = withFailing(pts[row.id], fails, endMs);
    /* The timeline: a restart once (not on every entity it touched), a brief drop-out
       as one line with how long it lasted, going offline and coming back. Coming back
       from a drop-out or a restart needs no line of its own. */
    const items = [];
    for (const m of ids) {
      const p = pts[m];
      p.forEach(([t, st], i) => {
        if (i === 0 || t < startMs) return;   // where the window starts is not a change
        if (st === AV.off) items.push({ t, tone: COL.bad, text: "Unavailable", m });
        else if (st === AV.brief) items.push({ t, tone: COL.brief, text: "Brief drop-out", m,
                                               extra: fmtDur((p[i + 1]?.[0] ?? endMs) - t) });
        else if (st === AV.ok && p[i - 1][1] === AV.off) items.push({ t, tone: COL.ok, text: "Available", m });
      });
    }
    for (const w of restartWindows(R)) {
      if (w.started < startMs || w.started > endMs) continue;
      const known = R.restarts.find((r) => Date.parse(r.started) === w.started)?.stopped;
      items.push({ t: w.started, tone: COL.stale, text: "Home Assistant restarted", kind: "restart",
                   extra: known ? `down ${fmtDur(w.started - w.down)}` : "" });
    }
    // a job's failing spans: when it began failing (with its latest failure's error), and
    // when a run ended without an error again
    for (const s of fails) {
      const a = Date.parse(s.since), b = s.until ? Date.parse(s.until) : null;
      if (a >= startMs && a <= endMs) items.push({ t: a, tone: COL.bad, text: "Failing", kind: "failing", span: s, extra: s.error || "" });
      if (b && b >= startMs && b <= endMs) items.push({ t: b, tone: COL.ok, text: "Recovered", kind: "recovered" });
    }
    /* Ignores: set, ended by someone, or run out by themselves (the log notes no expiry -
       an ignore's "until" is when it ended, unless something came before it). */
    const mine = (IG || []).filter((e) => (e.entity_ids || []).some((x) => row.members.includes(x)))
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const inWindow = (t) => t >= startMs && t <= endMs;
    mine.forEach((e, k) => {
      const t = Date.parse(e.t);
      if (e.kind === "ignored") {
        const until = e.until ? Date.parse(e.until) : null;
        if (inWindow(t)) {
          items.push({ t, tone: COL.ignored, text: "Ignored", kind: "ignore", user: e.user, until,
                       extra: [e.user && `by ${e.user}`, until ? `until ${fmtDT(until)}` : "until stopped"].filter(Boolean).join(" · ") });
        }
        const next = mine[k + 1] ? Date.parse(mine[k + 1].t) : Infinity;
        if (until && until <= Date.now() && until < next && inWindow(until)) {
          items.push({ t: until, tone: COL.stale, text: "Ignore ended", kind: "ended", extra: "its time was up" });
        }
      } else if (e.kind === "unignored" && inWindow(t)) {
        items.push({ t, tone: COL.stale, text: "No longer ignored", kind: "unignore", user: e.user,
                     extra: e.user ? `by ${e.user}` : "" });
      }
    });
    items.sort((a, b) => b.t - a.t);
    // each row opens the whole event (a long entity name is cut to one line here)
    const list = items.map((it, i) => `<li class="lgi" role="button" tabindex="0" data-evi="${i}"
          aria-label="${escapeHtml(`${it.text}, ${fmtDT(it.t)}: details`)}">
        <span class="logdot" style="--c:${it.tone}"></span>
        <span class="lgt">${fmtDT(it.t)}</span>
        <span class="lgm"><b>${it.text}</b>${it.m ? ` · ${escapeHtml(this._memberName(row, it.m))}` : ""}${
          it.extra ? ` <span class="muted">· ${escapeHtml(it.extra)}</span>` : ""}</span>
        <span class="lgchev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span></li>`);

    /* Reserve the final height up front. The embedded card fetches its own
       history, so without this the panel animates open to an empty box and then
       jumps when the data lands. Must track the row metrics set in CSS. */
    const reserved = Math.max(1, ids.length) * (SHC_ROW_H + SHC_ROW_GAP) + 30;

    box.innerHTML = `${this._runBlock(row)}
      <div class="dhead">Availability <span class="dsub">${this._rangeLabel()}</span></div>
      <div class="shc" id="shc" style="min-height:${reserved}px"></div>
      <div class="dhead sm">Timeline</div>
      <div class="tl"></div>`;
    const tl = box.querySelector(".tl");
    tl._items = list;
    tl._events = items;
    tl._row = row;
    tl._page = 0;
    this._paintTl(tl);

    this._mountHistory(box.querySelector("#shc"), row, ids, pts, R, start, end, fails);
  }

  /* A timeline row's whole event, in a popup over the dimmed page - the Alerts card's (i)
     and event popup: beside the row (ringed while open), under it or above it. */
  _wireInfo() {
    const dlg = this.shadowRoot.getElementById("idlg");
    this._info = { dlg, pop: dlg.querySelector(".ipop"), scrim: dlg.querySelector(".iscrim"), btn: null };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); this._hideInfo(); });
    this._info.scrim.addEventListener("click", () => this._hideInfo());
    this._info.pop.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ign]");
      if (b) this._ignore(this._info.ignoreRow, b.dataset.ign);
      // a failure's Open trace
      const nav = e.target.closest("[data-nav]");
      if (nav) {
        this._hideInfo();
        history.pushState(null, "", nav.dataset.nav);
        this.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
      }
    });
    containScroll(dlg, [this._info.pop]);
  }

  _showEvent(li) {
    if (this._info.dlg.open) { this._hideInfo(); return; }
    const tl = li.closest(".tl");
    const it = tl?._events?.[Number(li.dataset.evi)];
    if (!it) return;
    const row = tl._row;
    const field = (k, v, cls = "ipd") => v ? `<div class="ipk">${k}</div><div class="${cls}">${escapeHtml(v)}</div>` : "";
    const fn = it.m ? this._hass.states[it.m]?.attributes?.friendly_name || it.m : "";
    this._popAt(li, `<div class="ipev"><span class="logdot" style="--c:${it.tone}"></span><b>${escapeHtml(it.text)}</b>
        <span class="ipwhen">${escapeHtml(fmtDT(it.t))}</span></div>` +
      // the table row it belongs to: a device, or (marked _ in the table) an automation,
      // script or helper with none
      field(it.m ? (row.name === row.baseName ? "Device" : "Item") : "", it.m ? row.baseName : "") +
      field("Entity", fn) +
      field("Entity ID", it.m || "", "ipid") +
      // an ignore: who, and until when
      field("By", it.user || "") +
      field("Until", it.kind === "ignore" ? (it.until ? fmtDT(it.until) : "Someone stops it") : "") +
      // a drop-out's length, or how long Home Assistant was down for a restart
      field(it.m ? "Lasted" : it.kind === "restart" ? "Down for" : "",
            it.m || it.kind === "restart" ? String(it.extra || "").replace(/^down /, "") : "") +
      // failing: its latest failure - when, why - and that run's trace
      (it.kind === "failing" ? field("Last failure", it.span.last ? fmtDT(Date.parse(it.span.last)) : "") +
        field("Failed runs", it.span.runs > 1 ? String(it.span.runs) : "") +
        field("Error", it.span.error || "") +
        (it.span.trace_url ? `<button class="navbtn" data-nav="${escapeHtml(it.span.trace_url)}">Open trace</button>` : "") : ""));
  }

  _popAt(btn, html, kind = "") {
    const { dlg, pop, scrim } = this._info;
    pop.innerHTML = html;
    pop.classList.toggle("menu", kind === "menu");
    pop.scrollTop = 0;
    this._info.btn = btn;
    btn.classList.add("on");
    dlg.showModal();
    // the popup itself takes focus (as the Alerts card's sheets), not its first row - which
    // would wear the keyboard ring
    pop.focus({ preventScroll: true });
    const b = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.max(8, Math.min(b.left - 12, innerWidth - w - 8));
    let top = b.bottom + 6, above = false;
    if (top + h > innerHeight - 8) {
      if (b.top - 6 - h >= 8) { top = b.top - 6 - h; above = true; } else top = Math.max(8, innerHeight - 8 - h);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    if (reduceMotion()) return;
    pop.style.transformOrigin = `${Math.max(0, Math.min(w, b.left + b.width / 2 - left))}px ${above ? h : 0}px`;
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
    pop.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: IOS_SOFT });
  }

  async _hideInfo() {
    const i = this._info;
    if (!i?.dlg.open || i.closing) return;
    i.closing = true;
    i.btn?.classList.remove("on");
    if (!reduceMotion()) {
      i.scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in", fill: "forwards" });
      await i.pop.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.94)" }],
        { duration: 160, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
      i.pop.getAnimations().forEach((a) => a.cancel());
      i.scrim.getAnimations().forEach((a) => a.cancel());
    }
    i.dlg.close();
    i.closing = false;
  }

  /* Home Assistant's restarts and this group's cooldown, from the integration's restart
     log - read once a minute at most. An integration too old to keep the log has no
     restarts to show, and the cooldown falls back to its default. */
  async _restartInfo() {
    const c = this._restartCache;
    if (c && Date.now() - c.at < 60e3) return c.R;
    const res = await this._ws({ type: "entity_availability/restarts" });
    const R = {
      restarts: res?.restarts || [],
      graceMs: (res?.grace ?? 60) * 1000,
      cooldownMs: (res?.cooldowns?.[`entity_availability_${this._config.group}`] ?? 120) * 1000,
    };
    this._restartCache = { at: Date.now(), R };
    return R;
  }

  /* The timeline TL_PAGE entries at a time, newest first, with ‹ › under it. Paging, the
     page leaves the way the reader is going - older slides out to the left - fading,
     and the next comes in from the other side. */
  _paintTl(tl, dir = 0) {
    const pages = Math.max(1, Math.ceil(tl._items.length / TL_PAGE));
    tl._page = Math.max(0, Math.min(pages - 1, tl._page));
    const p = tl._page;
    const pager = pages > 1 ? `<div class="tlpager">
        <button class="pg" data-tl="-1" aria-label="Newer"${p === 0 ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span class="pgtext">${p + 1} / ${pages}</span>
        <button class="pg" data-tl="1" aria-label="Older"${p === pages - 1 ? " disabled" : ""}>
          <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>` : "";
    const html = tl._items.length
      ? `<ul class="log">${tl._items.slice(p * TL_PAGE, (p + 1) * TL_PAGE).join("")}</ul>${pager}`
      : `<div class="loading">No availability changes in this window.</div>`;
    const list = tl.querySelector(".log");
    if (!dir || !list || reduceMotion()) { tl.innerHTML = html; return; }
    const panel = tl.closest(".detail");
    list.getAnimations().forEach((a) => a.cancel());
    const out = list.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-dir * 56}px)`, opacity: 0 }],
      { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    out.onfinish = () => {
      if (!tl.isConnected) return;
      const h = panel?.offsetHeight;
      tl.innerHTML = html;
      tl.querySelector(".log")?.animate([{ transform: `translateX(${dir * 56}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 320, easing: IOS });
      if (panel) this._resizeDetail(panel, h);
    };
  }

  /* Every member of a row belongs to the same device, so each friendly name repeats the
     device name. Stripped, the labels read "Power", not "Studio Heater Power" fourteen
     times. */
  _memberName(row, m) {
    const fn = this._hass.states[m]?.attributes?.friendly_name || m;
    const short = fn.toLowerCase().startsWith(row.baseName.toLowerCase())
      ? fn.slice(row.baseName.length).replace(/^[\s:\u2013-]+/, "")
      : fn;
    return short || fn;
  }

  /* hass as the availability band should see it: each member's state is its
     availability, and its history call returns the availability series. */
  _availHass(hass) {
    const a = this._avail;
    if (!a) return hass;
    const synth = {};
    for (const m of a.ids) {
      const real = hass.states[m];
      const last = a.pts[m]?.[a.pts[m].length - 1];
      // available now, or still in whichever kind of gap the history ended in
      const now = availOf(real?.state) === "Available" ? (last?.[1] === AV.fail ? AV.fail : AV.ok)
        : (last && last[1] !== AV.ok ? last[1] : AV.brief);
      const iso = new Date(last && last[1] === now ? last[0] : Date.now()).toISOString();
      synth[m] = { entity_id: m, state: now, attributes: real?.attributes || {}, last_changed: iso, last_updated: iso };
    }
    const states = new Proxy(hass.states, { get: (t, k) => synth[k] || t[k] });
    const callApi = async (method, path, ...rest) => {
      if (method !== "GET" || !path.startsWith("history/period/")) return hass.callApi(method, path, ...rest);
      const [head, query = ""] = path.slice("history/period/".length).split("?");
      const q = new URLSearchParams(query);
      const ids = (q.get("filter_entity_id") || "").split(",").filter((m) => a.ids.includes(m));
      const res = await this._ws({
        type: "history/history_during_period",
        start_time: decodeURIComponent(head), end_time: q.get("end_time") || new Date().toISOString(),
        entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      return ids.map((m) => {
        // a job's failing spans laid over again (_drawTimeline)
        const endMs = Date.parse(q.get("end_time") || "") || Date.now();
        a.pts[m] = withFailing(availSegments(res?.[m], a.R, endMs), m === a.job ? a.fails : [], endMs);
        return a.pts[m].map(([t, state]) => {
          const at = new Date(t).toISOString();
          return { entity_id: m, state, last_changed: at, last_updated: at };
        });
      }).filter((series) => series.length);
    };
    return { ...hass, states, callApi };
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
      items = item(COL.bad, fmtDT(Date.parse(row.run.finished)), "<b>Failed</b>") +
        (row.run.error
          ? `<li class="jobmsg" style="--c:${COL.bad}">${escapeHtml(row.run.error)}</li>` : "");
    } else {
      items = item(ran ? COL.ok : COL.stale, ran ? fmtDT(Date.parse(ran)) : "never",
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

  async _mountHistory(host, row, ids, pts, R, start, end, fails = []) {
    this._shc = null;
    this._avail = null;
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
    // the row was collapsed (or another opened) while we waited
    if (!host.isConnected || host.closest(".detail")?.classList.contains("closing")) return;

    this._avail = { ids, pts, R, job: row.id, fails };
    const el = document.createElement("state-history-card");
    el.setConfig({
      type: "custom:state-history-card",
      hours_to_show: Math.max(1, Math.round((end - start) / 3600e3)),
      refresh_interval: 900,
      legend: "off",
      timestamps: "on",
      labels: "off",
      label_width: BAND_LABEL_W,
      state_colors: { [AV.ok]: COL.ok, [AV.off]: COL.bad, [AV.brief]: COL.brief, [AV.restart]: COL.stale, [AV.fail]: COL.bad },
      default_color: COL.ok,
      // A label opens the entity's more-info; it never switches the device.
      entities: ids.map((m) => ({ entity: m, name: this._memberName(row, m), label_action: "off" })),
    });
    el.hass = this._availHass(this._hass);
    host.replaceChildren(el);
    this._shc = el;
  }

  _drawSeries(box, row, target, hist, start, end) {
    const s0 = start.getTime(), s1 = end.getTime();
    /* Every recorded row: a reading, or null where the sensor had none (unavailable,
       unknown) - drawn as a GAP, never the last reading carried across it. A retained
       reading is not a reading. */
    const rows = hist.map((h) => {
      const raw = h.s ?? h.state;
      const v = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
      return { t: Math.max(s0, (h.lu ?? h.last_updated ?? 0) * 1000), v: Number.isFinite(v) ? v : null };
    }).filter((p) => p.t);
    const pts = rows.filter((p) => p.v !== null);
    const samples = pts.length;
    const W = box.clientWidth || 700;
    const H = 210;
    const P = { l: 48, r: 12, t: 12, b: 30 };
    const name = this._hass.states[target]?.attributes?.friendly_name || target;
    const label = this._view === "battery" ? "Battery" : "Signal";

    if (!samples) {
      box.innerHTML = `<div class="dhead">${label} <span class="dsub">${this._rangeLabel()}</span></div>
        <div class="loading">${rows.length ? `${escapeHtml(name)} had no readings in this window: it was unavailable.`
          : `No recorded history for ${escapeHtml(name)} in this window.`}</div>`;
      return;
    }

    // A value that has not changed in the window comes back as ONE row at its start: it
    // holds to the next row (a reading or a gap), the last one to the window's end - a
    // flat line, not a lone dot.
    if (rows[0].t > s0 && rows[0].v !== null) rows[0].t = s0;
    const runs = [], gaps = [];
    let run = null;
    rows.forEach((p, i) => {
      const until = i + 1 < rows.length ? rows[i + 1].t : s1;
      if (p.v === null) { run = null; if (until > p.t) gaps.push([p.t, until]); return; }
      if (!run) runs.push(run = []);
      run.push({ ...p, until });
    });

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
       <text x="${P.l - 9}" y="${y(v) + 5}" class="ax" text-anchor="end">${Math.round(v)}</text>`).join("") +
      // time along the bottom, as under the availability band
      // Marks picked for the availability band's track width, so both charts carry the
      // same marks; only where they sit stretches with this wider plot.
      axisMarks(start.getTime(), end.getTime(), bandTrackWidth(W)).map(({ t, label }) =>
        `<line x1="${x(t)}" x2="${x(t)}" y1="${P.t}" y2="${H - P.b}" stroke="${COL.grid}"/>
         <text x="${x(t)}" y="${H - 8}" class="ax" text-anchor="middle">${label}</text>`).join("");

    // Step line: sampled readings hold until the next one, so interpolating would
    // draw a slope that never happened. One stretch per run of readings; between them,
    // the gap, under a faint band so even a few minutes show.
    const X = (t) => x(t).toFixed(1), Y = (v) => y(v).toFixed(1);
    let line = "", area = "";
    for (const r of runs) {
      let d = `M${X(r[0].t)},${Y(r[0].v)}`;
      r.forEach((p, i) => { if (i) d += `L${X(p.t)},${Y(r[i - 1].v)}L${X(p.t)},${Y(p.v)}`; });
      d += `L${X(r[r.length - 1].until)},${Y(r[r.length - 1].v)}`;
      line += d;
      area += `${d}L${X(r[r.length - 1].until)},${H - P.b}L${X(r[0].t)},${H - P.b}Z`;
    }
    const gapBands = gaps.map(([a, b]) => {
      const w = Math.max(2, x(b) - x(a));
      return `<rect class="gapband" x="${(x(a) + (x(b) - x(a) - w) / 2).toFixed(1)}" y="${P.t}" width="${w.toFixed(1)}"
        height="${H - P.t - P.b}" fill="${COL.stale}" opacity=".16"/>`;
    }).join("");
    const c = this._view === "battery" ? COL.battery : COL.signal;
    // now: the last row - a reading, or none while the sensor is unavailable
    const lastRow = rows[rows.length - 1];
    const last = lastRow.v === null ? null : lastRow;
    const lastRun = runs[runs.length - 1];

    box.innerHTML = `
      <div class="dhead">${label} <span class="dsub">${this._rangeLabel()}</span></div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
        ${grid}
        ${gapBands}
        <path d="${area}" fill="${c}" opacity=".14"/>
        <path d="${line}" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round" class="spark"/>
        ${last ? `<circle cx="${X(lastRun[lastRun.length - 1].until)}" cy="${Y(last.v)}" r="4.5" fill="${c}"/>` : ""}
      </svg>
      <div class="dstats">
        <span>now <b>${last ? `${last.v}${this._view === "battery" ? "%" : " " + (row.unit || "dBm")}` : "unavailable"}</b></span>
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

/* A filter button names what is picked, as Grafana does: a chip per value - statuses
   in their colours, as in the table - as many as fit comfortably, then "+N". Nothing
   picked: the menu's "All …", in grey. A value just picked pops in. (The Alerts card's.) */
function paintPicked(host, spec, setOf) {
  const picked = [];
  for (const g of spec.groups) {
    const set = setOf(g.key);
    for (const x of g.values) if (set.has(x.v)) picked.push({ k: `${g.key}:${x.v}`, v: x.v, l: x.l, tone: x.tone });
    // picked from a table chip, but not among the tab's values
    for (const v of set) if (!g.values.some((x) => x.v === v)) picked.push({ k: `${g.key}:${v}`, v, tone: null });
  }
  host.classList.toggle("active", picked.length > 0);
  host.querySelector(".msbtn").title = picked.map((p) => p.l || p.v).join(", ");
  const lab = host.querySelector(".mslabel");
  const sig = spec.empty + "::" + picked.map((p) => p.k + (p.l || "")).join("|");
  if (lab._sig === sig) return;
  const had = new Set(lab._keys || []);
  const moreWas = lab.querySelector(".msmore:not([hidden])")?.textContent;
  lab._sig = sig;
  lab._keys = picked.map((p) => p.k);
  lab.innerHTML = picked.length
    ? picked.map((p) => `<span class="mspill${p.tone ? " stt" : ""}" data-k="${escapeHtml(p.k)}"${
        p.tone ? ` style="--c:${p.tone}"` : ""}><span>${escapeHtml(p.l || p.v)}</span></span>`).join("") +
      `<span class="msmore" hidden></span>`
    : `<span class="msph">${escapeHtml(spec.empty)}</span>`;
  fitPills(lab);
  if (reduceMotion()) return;
  const pop = (el) => el.animate([{ opacity: 0, transform: "scale(.8)" }, { opacity: 1, transform: "none" }],
    { duration: 280, easing: IOS_SOFT });
  lab.querySelectorAll(".mspill:not([hidden])").forEach((el) => { if (!had.has(el.dataset.k)) pop(el); });
  const more = lab.querySelector(".msmore:not([hidden])");
  if (more && more.textContent !== moreWas) pop(more);
}

/* Show the chips that fit, with room to spare, and "+N" for the rest; at least one, cut
   short if it must be. Measured, so it follows the button's width. */
const FIT_SLACK = 12;
function fitPills(lab) {
  const pills = [...lab.querySelectorAll(".mspill")];
  const more = lab.querySelector(".msmore");
  if (!pills.length || !more || !lab.clientWidth) return;
  const end = () => {
    let e = 0;
    for (const c of lab.children) if (!c.hidden) e = Math.max(e, c.offsetLeft + c.offsetWidth);
    return e;
  };
  for (const p of pills) { p.hidden = false; p.classList.remove("solo"); }
  more.hidden = true;
  if (end() <= lab.clientWidth) return;
  more.hidden = false;
  let shown = pills.length;
  while (shown > 1) {
    pills[--shown].hidden = true;
    more.textContent = `+${pills.length - shown}`;
    if (end() <= lab.clientWidth - FIT_SLACK) return;
  }
  pills[0].classList.add("solo");
}

/* Chart slots: a "nice" clock step (15 min, 1 h, 3 h …) giving at most `target`
   slots, aligned to the local clock so a slot reads as 9:15 – 9:30 PM rather than
   9:17:43 – 9:26:51. */
const STEP_MIN = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
function slotGrid(t0, t1, target) {
  const spanMin = (t1 - t0) / 60000;
  const stepMin = STEP_MIN.find((s) => spanMin / s <= target) || 1440;
  const d = new Date(t0);
  if (stepMin < 60) d.setMinutes(Math.floor(d.getMinutes() / stepMin) * stepMin, 0, 0);
  else { const h = stepMin / 60; d.setMinutes(0, 0, 0); d.setHours(Math.floor(d.getHours() / h) * h); }
  const slots = [];
  for (let a = d.getTime(); a < t1; a += stepMin * 60000) slots.push({ a, b: a + stepMin * 60000 });
  return slots;
}

/* Per slot, the devices that had the problem at ANY moment of it (each recorded
   sample holds from its own time to the next one's), and the bar value = how many.
   When a sample in the slot carries no device list (history from before the lists
   were recorded) the slot falls back to the highest count seen in it and names no
   one — a guessed list would be worse than none. */
function slotSets(hist, slots, t1, idsOf) {
  const samples = hist.map((h, i) => {
    const nx = hist[i + 1];
    const v = Number(h.s ?? h.state);
    return {
      from: (h.lu ?? h.last_updated ?? 0) * 1000,
      to: nx ? (nx.lu ?? nx.last_updated ?? 0) * 1000 : t1,
      v: Number.isFinite(v) ? v : 0,
      ids: idsOf(h.a ?? h.attributes),
    };
  });
  return slots.map((sl) => {
    let max = 0, known = true, any = false;
    const ids = new Set();
    for (const smp of samples) {
      if (smp.to <= sl.a || smp.from >= sl.b || smp.v <= 0) continue;
      any = true;
      if (smp.v > max) max = smp.v;
      if (smp.ids) smp.ids.forEach((x) => ids.add(x)); else known = false;
    }
    if (!any) return { v: 0, ids: null };
    return known && ids.size ? { v: ids.size, ids } : { v: max, ids: null };
  });
}

/* Split `total` slots between lists of the given lengths: one at a time, round robin,
   so the split is even and a short list's unused share flows to the longer ones. */
const TIP_NAMES = 9;
function shareOut(lengths, total) {
  const out = lengths.map(() => 0);
  for (let left = total, moved = true; left > 0 && moved;) {
    moved = false;
    for (let j = 0; j < lengths.length && left > 0; j++) {
      if (out[j] < lengths[j]) { out[j]++; left--; moved = true; }
    }
  }
  return out;
}

/* offline_count publishes one attribute per offline device ({offline, since, …});
   the battery and signal counts publish a plain `devices` list. */
function offlineIds(a) {
  if (!a) return null;
  const out = [];
  for (const [k, v] of Object.entries(a)) if (v && typeof v === "object" && v.offline) out.push(k);
  return out;
}
function listIds(a) {
  return Array.isArray(a?.devices) ? a.devices : null;
}

/* Problems, one count of rows - devices and helpers alike - each one named, so a bar's number
   is exactly what its popup names and a tap lists:
     unavailable   offline_count (an attribute per entity)
     not updating  stale_entities (its `entities`)
     failed        the jobs failing NOW (the summary's live `failed_entities`), named back to when
                   the summary's recorded `failed` count last fell below their number - the
                   recorder keeps that count, not the list.
   A failure already over cannot be named, so it is not counted - nor are the seconds a restart
   counts jobs its shutdown cut short. `rowOf` turns an entity into its row, so a device both
   unavailable and not updating is one. */
const problemEntities = (base) => [`${base}_stale_entities`, `${base}_group_summary`];
function problemSets(res, base, slots, t1, failedNow, rowOf) {
  const h = (k) => res?.[`${base}_${k}`] || [];
  const off = slotSets(h("offline_count"), slots, t1, offlineIds);
  const stale = slotSets(h("stale_entities").map((r) => ({ ...r, s: Number((r.a ?? r.attributes)?.count) || 0 })),
    slots, t1, (a) => (Array.isArray(a?.entities) ? a.entities : null));
  const failing = Array.isArray(failedNow) ? failedNow : [];
  let since = null;
  for (const r of h("group_summary")) {
    const n = (r.a ?? r.attributes)?.failed;
    if (n == null) continue;    // written while starting, before the count is in
    if (Number(n) < failing.length) since = null;
    else if (since == null) since = (r.lu ?? r.last_updated ?? 0) * 1000;
  }
  if (since == null) since = t1;
  return off.map((o, i) => {
    const st = stale[i];
    // an older history that kept a count without names: a count (a tap opens the tab)
    if ((o.v && !o.ids) || (st.v && !st.ids)) return { v: o.v + st.v, ids: null };
    const ids = new Set([...(o.ids || []), ...(st.ids || []), ...(slots[i].b > since ? failing : [])].map(rowOf));
    return { v: ids.size, ids: ids.size ? ids : null };
  });
}

/* Home Assistant's own language and 12/24-hour setting (the user's profile), so the
   chart's times read like the rest of the dashboard. Refreshed from hass every tick. */
let LOCALE = { lang: undefined, hour12: undefined };
function setLocale(hass) {
  const l = hass?.locale || {};
  LOCALE = {
    lang: l.language || hass?.language || undefined,
    hour12: l.time_format === "12" ? true : l.time_format === "24" ? false : undefined,
  };
}

/* One date-time format everywhere, the same as the Alerts card's: "Today, 9:21 PM",
   "Yesterday, 8:24 PM", "Tomorrow, 8:00 AM", otherwise "Sun, Oct 4, 9:21 PM". */
const DAY_MS = 86400e3;
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function fmtDay(t) {
  const days = Math.round((dayStart(t) - dayStart(Date.now())) / DAY_MS);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  if (days === 1) return "Tomorrow";
  return new Date(t).toLocaleDateString(LOCALE.lang, { weekday: "short", month: "short", day: "numeric" });
}
const fmtTime = (t) => new Date(t).toLocaleTimeString(LOCALE.lang, { hour: "numeric", minute: "2-digit", hour12: LOCALE.hour12 });
function fmtDT(t) {
  if (!t || !Number.isFinite(t)) return "—";
  return `${fmtDay(t)}, ${fmtTime(t)}`;
}

/* A chart slot: "Sun, Oct 4, 9:15 – 9:30 PM". */
function fmtSlot(a, b) {
  return `${fmtDay(a)}, ${fmtTime(a)} – ${fmtTime(b)}`;
}

/* Availability, the integration's rule (DEFAULT_BAD_STATES): an entity is Unavailable
   while its state is "unavailable" or "unknown", Available in any other state. */
const BAD_STATES = new Set(["unavailable", "unknown"]);
const availOf = (s) => (s == null || BAD_STATES.has(String(s)) ? "Unavailable" : "Available");

/* An entity's history (compressed rows: s, lu) → [[ms, "Available"|"Unavailable"], ...],
   the changes only - a light switching on and off is one long Available. */
function availPoints(hist) {
  const pts = [];
  for (const h of hist || []) {
    if ((h.s ?? h.state) == null) continue;
    const t = (h.lu ?? h.lc ?? 0) * 1000;
    if (!t) continue;
    const st = availOf(h.s ?? h.state);
    if (!pts.length || pts[pts.length - 1][1] !== st) pts.push([t, st]);
  }
  return pts;
}

/* What the availability band and timeline show - the integration's own judgement, not
   the raw states:
     Available       anything but unavailable/unknown;
     Unavailable     unavailable for at least the group's cooldown (120 s here) - what
                     the integration counts as offline (the card's word for it, as in
                     the table);
     Brief drop-out  unavailable for less than that: real, but it never counted;
     Restarting      unavailable because Home Assistant was restarting - a gap that began
                     while it was stopping or starting, or in the minutes after (up to the
                     startup grace + cooldown, before which the integration counts
                     nothing), forgiven for as long as the integration forgives it.
                     Whatever lasts longer than that is Unavailable.
   `R`: { restarts: [{stopped, booted, started}], graceMs, cooldownMs } (from the
   integration's restart log). → [[ms, status], ...], the changes only. */
const AV = { ok: "Available", off: "Unavailable", brief: "Brief drop-out", restart: "Restarting", fail: "Failing" };

/* An automation's or a script's failing spans: the integration's failure log, and - for a job
   failing now that the log never saw fail (it failed before the log, or a restart brought the
   failure back) - one from its failed run on. */
function failSpans(row, F) {
  const spans = (F?.[row.id] || []).map((s) => ({ ...s }));
  if (row.failed && row.run && !spans.some((s) => !s.until)) {
    spans.push({ since: row.run.finished, until: null, runs: 1, last: row.run.finished,
                 error: row.run.error, trace_url: row.run.trace_url });
  }
  return spans;
}

/* Availability segments with the job's failing spans laid over: Failing where it was
   available but its runs were failing (unavailable, a restart, a drop-out stay what they are). */
function withFailing(segs, spans, endMs) {
  if (!spans.length || !segs.length) return segs;
  const iv = spans.map((s) => [Date.parse(s.since), s.until ? Date.parse(s.until) : endMs]);
  const t0 = segs[0][0];
  const ts = new Set(segs.map(([t]) => t));
  for (const [a, b] of iv) for (const t of [a, b]) if (t > t0 && t < endMs) ts.add(t);
  const out = [];
  for (const t of [...ts].sort((x, y) => x - y)) {
    let base = segs[0][1];
    for (const [u, s] of segs) { if (u <= t) base = s; else break; }
    const st = base === AV.ok && iv.some(([a, b]) => t >= a && t < b) ? AV.fail : base;
    if (!out.length || out[out.length - 1][1] !== st) out.push([t, st]);
  }
  return out;
}
function restartWindows(R) {
  return (R?.restarts || []).map((r) => {
    const started = Date.parse(r.started);
    const down = Date.parse(r.stopped) || (Date.parse(r.booted) - 60e3);
    return { a: down, b: started + (R.graceMs || 0), started, down };
  }).filter((w) => Number.isFinite(w.a) && Number.isFinite(w.b));
}
function availSegments(hist, R, endMs) {
  const raw = availPoints(hist);
  const wins = restartWindows(R);
  const cool = R?.cooldownMs ?? 120e3;
  const out = [];
  const push = (t, st) => { if (!out.length || out[out.length - 1][1] !== st) out.push([t, st]); };
  for (let i = 0; i < raw.length; i++) {
    const [a, st] = raw[i];
    if (st === "Available") { push(a, AV.ok); continue; }
    const b = i + 1 < raw.length ? raw[i + 1][0] : endMs;
    // a gap that begins while HA is stopping or starting, or before the integration would
    // count anything again (grace + cooldown), belongs to the restart
    const win = wins.find((w) => a >= w.a && a <= w.b + cool);
    if (win) {
      const forgiven = win.b + cool;
      push(a, AV.restart);
      if (b > forgiven) push(forgiven, AV.off);
    } else {
      push(a, b - a >= cool ? AV.off : AV.brief);
    }
  }
  return out;
}

/* "35 s", "1 min 12 s", "2 h 5 min". */
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/* The availability band's name column, fixed so every device's band has the same track
   - and so the same time marks - and every other chart can work that track out:
   bandTrackWidth() is state-history-card's own layout (_layoutMetrics) for it. */
const BAND_LABEL_W = 240;
function bandTrackWidth(cardWidth, labelW = BAND_LABEL_W) {
  const compact = cardWidth <= 520;
  const inner = Math.max(0, cardWidth - (compact ? 24 : 32));
  const gap = compact ? 6 : 8;
  const minL = compact ? 68 : 72;
  const label = Math.round(Math.min(Math.max(minL, inner - gap - 120), Math.max(minL, labelW)));
  return Math.max(120, Math.round(inner - label - gap));
}

/* Timeline entries per page. */
const TL_PAGE = 10;

/* Time marks for a chart across [t0, t1] drawn `width` px wide - state-history-card's own
   axis (its _axisTicks), so the battery and signal charts read exactly like the
   availability band above them: the tightest step of 1, 2, 3, 4, 6, 8, 12 h or a day
   at which every ~76px label fits, a midnight named by its weekday ("Tue"), any other
   mark by its time ("4:00 PM"). */
const AXIS_STEPS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168, 336, 720, 2160, 8760];
function axisMarks(t0, t1, width) {
  const labelW = width < 260 ? 64 : 76;
  const pos = (t) => ((t - t0) / (t1 - t0)) * width;
  const candidates = (step) => {
    const d = new Date(t0);
    d.setMinutes(0, 0, 0);
    if (step < 24) {
      d.setHours(Math.ceil(d.getHours() / step) * step);
      if (d.getTime() < t0) d.setHours(d.getHours() + step);
    } else {
      d.setHours(0, 0, 0, 0);
      while (d.getTime() < t0) d.setHours(d.getHours() + step);
    }
    const out = [];
    for (; d.getTime() <= t1; d.setHours(d.getHours() + step)) {
      const t = d.getTime();
      const midnight = d.getHours() === 0 && d.getMinutes() === 0;
      out.push({ t, midnight, label: midnight
        ? new Date(t).toLocaleDateString(LOCALE.lang, t1 - t0 <= 7 * 86400e3 ? { weekday: "short" } : { month: "short", day: "numeric" })
        : fmtTime(t) });
    }
    return out;
  };
  const fits = (m) => pos(m.t) - labelW / 2 >= 0 && pos(m.t) + labelW / 2 <= width;
  const spread = (marks) => {
    const kept = [];
    for (const m of marks) {
      if (!fits(m)) continue;
      const prev = kept[kept.length - 1];
      if (prev && pos(m.t) - labelW / 2 < pos(prev.t) + labelW / 2 + 8) {
        if (m.midnight && !prev.midnight) kept[kept.length - 1] = m;   // a day name wins
        continue;
      }
      kept.push(m);
    }
    return kept;
  };
  for (const step of AXIS_STEPS) {
    const marks = candidates(step);
    const kept = spread(marks);
    if (kept.length && kept.length === marks.filter(fits).length) return kept;
  }
  return spread(candidates(AXIS_STEPS[AXIS_STEPS.length - 1]));
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

/* A modal's scroll stays in it: a scroller under the pointer scrolls; at its end, or with
   none, the gesture stops short of the page (the Alerts card's). */
function containScroll(dlg, scrollers) {
  let y0 = 0;
  const under = (e) => {
    const path = e.composedPath();
    return scrollers.filter((el) => path.includes(el) && el.scrollHeight > el.clientHeight + 1);
  };
  const blocked = (e, dy) => under(e).every((el) =>
    dy < 0 ? el.scrollTop <= 0 : el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  dlg.addEventListener("wheel", (e) => { if (blocked(e, e.deltaY)) e.preventDefault(); }, { passive: false });
  dlg.addEventListener("touchstart", (e) => { y0 = e.touches[0]?.clientY ?? 0; }, { passive: true });
  dlg.addEventListener("touchmove", (e) => {
    const y = e.touches[0]?.clientY ?? y0;
    if (blocked(e, y0 - y)) e.preventDefault();
    y0 = y;
  }, { passive: false });
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
  /* SELECTION is white, never blue: whatever is chosen (a filter, a ticked option, a
     chip, the open row) gets a faint white fill, a lighter edge, and its text one
     weight up. */
  --sel-bg: rgba(255,255,255,.09);
  --sel-line: rgba(255,255,255,.32);
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
/* embedded: inside a card that is the panel and has the header (page-switcher-card) */
ha-card.embedded{background:transparent;border:0;box-shadow:none;border-radius:0}
ha-card.embedded > .top{display:none}
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
/* pan-y: a vertical swipe still scrolls the page, a sideways drag scrubs the slots. */
.chartwrap{min-height:172px;position:relative;touch-action:pan-y;cursor:pointer;
           -webkit-user-select:none;user-select:none}
.hband{fill:rgba(255,255,255,.07);pointer-events:none}
/* Chart tooltip, in the menus' surface. Roles: the slot reads as body type, bold;
   each problem's heading is a label in its category colour; device names are body
   type at regular weight, so the eye goes date → category → names. */
/* z-index above the sticky tabs/filters (6) and column row (5): the tooltip may hang
   below the chart over them, and must not be cut off by them. */
.ctip{position:absolute;top:6px;left:0;z-index:30;pointer-events:none;
      min-width:200px;max-width:340px;padding:12px 34px 10px 14px;border-radius:13px;
      background:#2a2433;border:1px solid rgba(255,255,255,.14);
      box-shadow:0 18px 44px rgba(0,0,0,.55);
      transition:transform .18s ${IOS}}
.ctip[hidden]{display:none}
.twhen{font-size:var(--fs-body);font-weight:700;color:var(--txt);margin-bottom:6px}
.tsec{padding-top:8px}
.thd{display:flex;align-items:center;gap:8px;font-size:var(--fs-label);font-weight:700;
     letter-spacing:.6px;text-transform:uppercase;color:var(--c)}
.thd i{width:10px;height:10px;border-radius:3px;background:var(--c);flex:0 0 auto}
.thd b{margin-left:auto;font-family:var(--mono);font-size:var(--fs-body);letter-spacing:0;color:var(--c)}
.tsec ul{list-style:none;margin:5px 0 0;padding:0 0 0 18px}
.tsec li{font-size:var(--fs-body);font-weight:500;color:var(--txt);line-height:1.5;
         white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* what did not fit: one more line of the list, in the secondary colour (iOS) - its own
   class: "more" is the card's button and drew a 42px box here */
.tsec li.tmore{color:var(--txt2)}
.tnone{font-size:var(--fs-body);font-weight:500;color:var(--txt2);padding-top:4px}
/* The chart pick, as a chip in its category's colour. Tap to let go. */
.pin{appearance:none;font-family:inherit;cursor:pointer;flex:0 1 auto;min-width:0;
     display:flex;align-items:center;gap:9px;min-height:var(--tap);padding:0 14px;border-radius:11px;
     font-size:var(--fs-body);font-weight:600;color:var(--txt);
     background:color-mix(in srgb,var(--c) 16%,transparent);
     border:1px solid color-mix(in srgb,var(--c) 45%,transparent);
     transition:background .26s ${IOS}}
.pin[hidden]{display:none}
/* with a chip in the row the menus give up a little room, and a long alert name is cut
   short rather than taking Reset to a line of its own */
.pin{max-width:400px}
@media (min-width:701px){ .filters:has(.pin:not([hidden])) .ms{flex-basis:160px} }
.pin:active{transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.pindot{width:10px;height:10px;border-radius:50%;background:var(--c);flex:0 0 auto}
.pinlab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pin svg{width:16px;height:16px;flex:0 0 auto;fill:none;stroke:var(--txt2);stroke-width:2.4;stroke-linecap:round}
.pin svg.pinic{width:18px;height:18px;stroke:var(--c);stroke-width:2;stroke-linejoin:round}
.pinn{flex:0 0 auto;font-weight:500;color:var(--txt2);white-space:nowrap}
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

/* view tabs. The active tab is white, one weight up, in the same box as the filter
   dropdowns - not a blue underline. Every tab carries the (transparent) border so
   switching never shifts the row. */
.views{display:flex;gap:4px;padding:12px var(--pad) 0;flex-wrap:wrap}
.vw{appearance:none;background:transparent;cursor:pointer;font-family:inherit;
    font-size:var(--fs-body);font-weight:600;min-height:var(--tap);padding:0 18px;color:var(--txt2);
    border:1px solid transparent;border-radius:11px;position:relative;
    transition:color .3s ${IOS},background .3s ${IOS},border-color .3s ${IOS}}
.vw:active{transform:scale(.96);transition:transform .12s ${IOS}}
/* Selected is WHITE, with the text in the card's own background colour: the tab on show
   and every filter with something picked stand out at a glance (the filters below too). */
.vw.on{color:var(--ha-card-background,#201b25);font-weight:700;background:#fff;border-color:#fff}

/* filters */
.filters{display:flex;gap:10px;padding:14px var(--pad);border-bottom:1px solid var(--line);flex-wrap:wrap}
/* Same basis and grow as .ms, so search and both dropdowns share the row in
   equal thirds. border-box because this is a padded label: in content-box its
   30px padding and border would sit on top of the basis and it would be wider. */
/* min-width:0: the input's own width (~290px) must not set how wide it has to be - it
   pushed the row over and Reset onto a line of its own */
.search{flex:1 1 200px;box-sizing:border-box;display:flex;align-items:center;gap:10px;min-width:0;
        padding:0 15px;min-height:var(--tap);
        background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:11px}
.search svg{width:18px;height:18px;fill:none;stroke:var(--txt2);stroke-width:2;
            stroke-linecap:round;flex:0 0 auto}
.search input{flex:1;min-width:0;appearance:none;border:0;background:transparent;outline:none;
              font-family:inherit;font-size:var(--fs-body);font-weight:600;color:var(--txt)}
.search input::placeholder{font-weight:500;color:var(--txt2)}

/* multi-select */
/* 200px each: search, three menus and Reset share one row in the tablet's Alerts view */
.ms{position:relative;flex:1 1 200px;min-width:0}   /* its chips must not size it */
.msbtn{display:flex;align-items:center;gap:9px;min-height:var(--tap);padding:0 15px;
       appearance:none;font-family:inherit;font-size:var(--fs-body);font-weight:600;border-radius:11px;
       background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--txt);
       cursor:pointer;width:100%;
       transition:border-color .26s ${IOS},background .26s ${IOS},color .26s ${IOS}}
.msbtn:active{transform:scale(.985);transition:transform .12s ${IOS}}
.ms.active .msbtn{border-color:#fff;background:#fff;color:var(--ha-card-background,#201b25);font-weight:700}
.ms.active .msbtn svg{stroke:var(--ha-card-background,#201b25)}
/* The picked values' chips, made for a dark button, redrawn for a white one: in the
   colour's own hue, dark enough to read on its tint - 6.8:1 or better for every status and
   priority colour (yellow, the hardest, was 3:1). A plain value (an integration, an area,
   a category) is drawn exactly like them, in a neutral grey. */
.ms.active .mspill:not(.stt){--c:#8B949E;font-family:inherit}
.ms.active .mspill{color:color-mix(in srgb,var(--c) 40%,#000);background:color-mix(in srgb,var(--c) 32%,#fff);
                       box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 60%,#fff);font-weight:700}
.ms.active .msmore{color:var(--ha-card-background,#201b25)}
/* nothing picked: the label steps back, so a filter that IS set stands out */
.ms:not(.active) .msbtn{color:var(--txt2);font-weight:500}
.mslabel{flex:1 1 auto;min-width:0;position:relative;   /* pushes the chevron to the far edge */
         display:flex;align-items:center;gap:6px;overflow:hidden;text-align:left}
.msph{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* the picked values, as the table's chips */
.mspill{flex:0 0 auto;display:inline-flex;align-items:center;min-width:0;height:27px;padding:0 9px;
        box-sizing:border-box;border-radius:6px;font-family:var(--mono);font-size:var(--fs-meta);
        font-weight:600;color:var(--txt);background:rgba(255,255,255,.1)}
.mspill.stt{font-family:inherit;color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent);
            box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 30%,transparent)}
.mspill>span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mspill.solo{flex-shrink:1}
.msmore{flex:0 0 auto;font-family:var(--mono);font-size:var(--fs-meta);font-weight:600;color:var(--txt)}
.mspill[hidden],.msmore[hidden]{display:none}
.msbtn svg{width:17px;height:17px;flex:0 0 auto;fill:none;stroke:var(--txt2);
           stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s ${EASE}}
.ms.open .msbtn svg{transform:rotate(180deg)}
.mspanel{display:none;position:absolute;z-index:20;top:calc(100% + 7px);left:0;min-width:250px;
         max-height:min(430px,70vh);overflow:auto;padding:7px;border-radius:13px;
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
.msopt.on{font-weight:700}
.msopt.on .box{background:#fff;border-color:#fff}
.msopt.on .box svg{stroke:var(--ha-card-background,#201b25)}
.msopt.on .box svg{opacity:1;transform:none}
.msname{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msgh{padding:9px 9px 5px}
.msopt + .msgh{margin-top:6px;padding-top:13px;border-top:1px solid var(--line)}
.msdot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:var(--c)}
.mscount{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2)}

.clear{appearance:none;font-family:inherit;font-size:var(--fs-body);font-weight:600;
       min-height:var(--tap);padding:0 30px;border-radius:11px;background:transparent;
       border:1px solid var(--line);color:var(--txt2);cursor:pointer;
       transition:color .26s ${IOS},border-color .26s ${IOS},background-color .26s ${IOS}}
.clear:active{transform:scale(.96);transition:transform .12s ${IOS_SOFT}}
.clear:hover{color:var(--txt);border-color:rgba(255,255,255,.24)}
/* with a filter set, Reset has something to do: it stands out, in the selection white */
.clear.on{background:var(--sel-bg);border-color:var(--sel-line);color:var(--txt)}

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
/* The sorted column: white and one weight up (its arrow follows), never blue. */
.th.on{color:var(--txt);font-weight:800}
.ar{font-size:9px}
.tr{display:grid;gap:var(--gap);align-items:center;padding:12px var(--pad);cursor:pointer;
    min-height:var(--tap);border-bottom:1px solid rgba(255,255,255,.05);
    transition:background .16s ${EASE}}
.tr:hover{background:rgba(255,255,255,.045)}
.tr:active{transform:scale(.995);transition:transform .1s ${IOS}}
.tr.open{background:rgba(255,255,255,.05)}
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
.tag.on{background:var(--sel-bg);color:var(--txt);font-weight:600;
        box-shadow:inset 0 0 0 1px var(--sel-line)}
/* Status and quality chips carry the CATEGORY hue rather than the white of an
   ordinary selected chip, because the colour is data here. The fill stays light so the label keeps
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
.iconbtn:hover svg{stroke:var(--txt)}
.chev{display:grid;place-items:center;width:26px;height:38px}
.chev svg{width:20px;height:20px;fill:none;stroke:var(--txt2);stroke-width:2.4;
          stroke-linecap:round;stroke-linejoin:round;opacity:.6;
          transition:transform .42s ${IOS_SOFT}}
.chev.up svg{transform:rotate(180deg)}
.none{padding:36px;text-align:center}

/* detail */
.detail{padding:0 var(--pad);background:rgba(255,255,255,.03);
        border-bottom:1px solid var(--line)}
.detailBody{padding:4px 0 20px}
/* the expanded row's actions, top left, in the selection white (as New alert) */
.dactions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:14px 0 2px}
.dactions:empty{display:none}
.dactions .navbtn{margin-left:0;font-size:var(--fs-body);font-weight:600}
.navbtn.primary{background:var(--sel-bg);border-color:var(--sel-line);color:var(--txt)}
/* Ignored until …: the highlight, as the chosen tab - white, in the card's own dark */
.navbtn.ignored, .navbtn.ignored:hover{background:#fff;border-color:#fff;color:var(--ha-card-background,#201b25);font-weight:700}
/* the Ignore menu: the Alerts card's snooze sheet rows, in the popup */
.ipop.menu{padding:0;width:340px;max-width:calc(100% - 16px)}
.shead{padding:14px 18px 12px;text-align:left}
.stitle{font-size:var(--fs-meta);font-weight:700;color:var(--txt2)}
.ssub{margin-top:3px;font-size:var(--fs-meta);font-weight:500;color:var(--txt2)}
.srow{appearance:none;border:0;background:transparent;width:100%;min-height:52px;padding:0 18px;margin:0;
      display:flex;align-items:center;gap:10px;cursor:pointer;font-family:inherit;text-align:left;position:relative;
      font-size:var(--fs-body);font-weight:600;color:var(--txt);transition:background .25s ${EASE}}
.srow::before{content:"";position:absolute;left:18px;right:0;top:0;height:1px;background:rgba(255,255,255,.09)}
.srow:active{background:rgba(255,255,255,.12);transition:none}
@media (hover:hover){.srow:hover{background:rgba(255,255,255,.06)}}
.sval{margin-left:auto;font-size:var(--fs-meta);font-weight:500;color:var(--txt2);white-space:nowrap}
/* Stop ignoring: the row that undoes what is set, in the selection white */
.srow.end, .srow.end:hover{background:#fff;color:var(--ha-card-background,#201b25)}
.srow.end:active{background:rgba(255,255,255,.82)}
.srow.end::before, .srow.end + .srow::before{display:none}
/* room either side for a row's highlight, which reaches past the text */
.tl{overflow:hidden;margin:0 -8px;padding:0 8px}
/* a timeline row opens its whole event (the Alerts card's): highlighted under the pointer,
   ringed while open, a chevron at its end as the iOS sign of "more" */
.log li.lgi{margin:0 -8px;padding:0 8px;border-radius:9px;cursor:pointer;outline:none;
            -webkit-tap-highlight-color:transparent;transition:background-color .2s ease}
@media (hover:hover){.log li.lgi:hover{background:rgba(255,255,255,.05)}}
.log li.lgi:active{background:rgba(255,255,255,.08);transition:none}
.log li.lgi.on, .log li.lgi:focus-visible{background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px var(--sel-line)}
.lgchev{flex:0 0 auto;margin-left:auto;width:16px;height:16px;display:grid;place-items:center;color:var(--txt2)}
.lgchev svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}

/* The event popup: a modal over the dimmed page, in the chart tooltip's box with a deeper
   shadow - the Alerts card's (i) popup. */
ha-card{--scrim-a:.6}
dialog.idlg{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;
            padding:0;border:0;background:transparent;color:var(--txt);overflow:hidden}
dialog.idlg::backdrop{background:transparent}
.iscrim{position:absolute;inset:0;background:rgba(0,0,0,var(--scrim-a))}
.ipop{position:absolute;width:max-content;max-width:min(570px,calc(100% - 16px));max-height:calc(100% - 16px);
      overflow:auto;overscroll-behavior:contain;box-sizing:border-box;
      padding:14px 16px;border-radius:13px;background:#2a2433;border:1px solid rgba(255,255,255,.14);
      box-shadow:0 30px 80px rgba(0,0,0,.7),0 4px 14px rgba(0,0,0,.45);outline:none}
.ipk{font-size:var(--fs-label);font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--txt2)}
.ipk + div{margin:3px 0 0}
.ipd + .ipk, .ipid + .ipk, .ipev + .ipk{margin-top:10px}
.ipd{font-size:var(--fs-meta);font-weight:500;color:var(--txt);line-height:1.45;white-space:pre-wrap;word-break:break-word}
.ipop .navbtn{display:block;margin:12px 0 0}
.ipid{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt);word-break:break-all}
.ipev{display:flex;align-items:center;gap:9px;font-size:var(--fs-body);color:var(--txt)}
.ipwhen{margin-left:auto;padding-left:14px;font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2);white-space:nowrap}
.tlpager{display:flex;align-items:center;justify-content:center;gap:18px;padding:12px 0 2px}
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
      min-height:42px;padding:0 18px;border-radius:10px;background:var(--sel-bg);
      border:1px solid var(--sel-line);color:var(--txt);cursor:pointer}
.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.log li{display:flex;align-items:center;gap:11px;min-height:37px}
.logdot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto}
.lgt{font-family:var(--mono);font-size:var(--fs-meta);font-weight:500;color:var(--txt2);flex:0 0 auto;min-width:176px}
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
  ha-card{--pad:13px;--gap:9px;--scrim-a:.68}
  .ms,.msbtn{max-width:none;width:100%}
  .search,.ms{flex:1 1 100%}
}
/* Focus: no blue ring. A faint white one for keyboard focus only. */
button:focus{outline:none}
button:focus-visible{outline:2px solid rgba(255,255,255,.35);outline-offset:2px}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition-duration:.01ms!important}}
`;

/* ---- the phone layout (layout: phone) -------------------------------------------------
   The Health page on an iPhone, chosen 2026-10-09 from four concepts (Apple Health's Summary
   with the Alerts screen's tabs): the category cards and one chart of every problem; a card
   opens its list over them - search, then Devices | Helpers | Battery | Signal - and a row
   opens in a bottom sheet (the Alerts card's phone sheet): its status, More Info and Ignore, a
   job's last run, then its battery, signal, availability, timeline and entities behind rows.
   The header's filter button (page-switcher-card: button method openHide) hides kinds of
   problem from the whole page - Weak signal, by default. A link's hm_ filters (the tablet's
   address, so one link serves both) open the list they name, its filters as chips. Drawn in a
   shadow root of its own from the card's data (_read) and its history and ignore helpers; the
   header - ‹, Alerts | Health, the filter button - is the page switcher's (ios: true), whose ‹
   asks handleBack() first. Sizes: names 17, the rest 15, headings 20/22/34. */

const PH_QUIET = "#636366";                  // a tile with nothing wrong: grey
const PH_EASE = "cubic-bezier(.25,.8,.25,1)";
const PH_HOUR = 3600e3;
const PH_ICON = {
  back: `<svg viewBox="0 0 24 24"><path d="M14.5 5l-7 7 7 7"/></svg>`,
  chev: `<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`,
  x: `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  filter: `<svg viewBox="0 0 24 24"><path d="M4 7h16M7 12h10M10 17h4"/></svg>`,
  bell: `<svg class="pic" viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>`,
};
const phHour = (t) => new Date(t).toLocaleTimeString(LOCALE.lang, { hour: "numeric", hour12: LOCALE.hour12 });
// a whole-day slot by its day, any other by its hours
const phSlot = (a, b) => (b - a >= 20 * PH_HOUR ? fmtDay(a) : fmtSlot(a, b));
function phRelLong(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return "just now";
  if (d < PH_HOUR) return `${Math.floor(d / 60e3)} min ago`;
  if (d < DAY_MS) return `${Math.floor(d / PH_HOUR)} h ago`;
  const days = Math.floor(d / DAY_MS);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
function phDayTitle(ms) {
  const t = dayStart(Date.now());
  if (ms >= t) return "Today";
  if (ms >= t - DAY_MS) return "Yesterday";
  if (ms >= t - 6 * DAY_MS) return new Date(ms).toLocaleDateString(LOCALE.lang, { weekday: "long" });
  return new Date(ms).toLocaleDateString(LOCALE.lang, { weekday: "short", month: "short", day: "numeric" });
}
function phFor(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(h / 24)} days`;
}

// worst first: what a list's Needs Attention shows, and in which order
const PH_SEV = { Unavailable: 0, Failed: 1, "Low battery": 1, "Weak signal": 1, "Not updating": 2, OK: 4, Ignored: 5 };
const phIsProblem = (r, ctx) => PH_SEV[statusOf(r, ctx).text] < 4;
const phBySev = (ctx) => (a, b) => PH_SEV[statusOf(a, ctx).text] - PH_SEV[statusOf(b, ctx).text] || a.name.localeCompare(b.name);
const PH_PLAT_NAME = {
  shelly: "Shelly", hue: "Hue", bthome: "BTHome", unifiprotect: "UniFi Protect", ecowitt_local: "Ecowitt",
  wundergroundpws: "Weather Underground", apc_ups_snmp: "APC UPS", jablotron_cloud: "Jablotron", mqtt: "MQTT",
  opensprinkler: "OpenSprinkler", espsomfy_rts_enhanced: "ESPSomfy", cez_hdo: "CEZ HDO", open_meteo: "Open-Meteo",
  google: "Google Calendar",
};
const phPlatName = (p) => PH_PLAT_NAME[p] || String(p || "Other").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
// what a helper is, as a group and as one
function phHelperType(r) {
  const p = r.rawPlatform, dom = r.id.split(".")[0];
  if (p === "automation") return ["Automations", "Automation"];
  if (p === "script") return ["Scripts", "Script"];
  if (p === "template") return ["Templates", "Template"];
  if (p === "timer") return ["Timers", "Timer"];
  if (PLATFORM_GROUP[p] || dom.startsWith("input_")) return ["Inputs", "Input"];
  if (dom === "calendar") return ["Calendars", "Calendar"];
  return ["Other", phPlatName(p)];
}
const phKind = (r) => (isDevice(r) ? phPlatName(r.rawPlatform) : phHelperType(r)[1]);
const PH_PLAT_ICON = {
  shelly: "mdi:flash", hue: "mdi:lightbulb-outline", bthome: "mdi:bluetooth", unifiprotect: "mdi:cctv",
  ecowitt_local: "mdi:weather-partly-cloudy", wundergroundpws: "mdi:weather-partly-cloudy", apc_ups_snmp: "mdi:power-plug-battery",
  jablotron_cloud: "mdi:shield-home", mqtt: "mdi:access-point", opensprinkler: "mdi:sprinkler", espsomfy_rts_enhanced: "mdi:blinds",
  cez_hdo: "mdi:transmission-tower", open_meteo: "mdi:weather-cloudy", google: "mdi:calendar", automation: "mdi:robot-outline",
  script: "mdi:script-text-outline", template: "mdi:code-braces", timer: "mdi:timer-outline",
};
const PH_DOMAIN_ICON = { light: "mdi:lightbulb-outline", switch: "mdi:toggle-switch-outline", binary_sensor: "mdi:radiobox-marked",
  sensor: "mdi:gauge", camera: "mdi:cctv", media_player: "mdi:speaker", climate: "mdi:thermostat", cover: "mdi:blinds",
  calendar: "mdi:calendar", alarm_control_panel: "mdi:shield-home", input_boolean: "mdi:toggle-switch-outline",
  input_number: "mdi:ray-vertex", input_select: "mdi:form-select", input_text: "mdi:form-textbox", input_datetime: "mdi:calendar-clock" };
const phIconOf = (r) => PH_PLAT_ICON[r.rawPlatform] || PH_DOMAIN_ICON[r.id.split(".")[0]] || "mdi:devices";

const PH_TABS = [
  { id: "devices", label: "Devices", title: "Devices", all: "All Devices" },
  { id: "helpers", label: "Helpers", title: "Helpers", all: "All Helpers" },
  { id: "battery", label: "Battery", title: "Batteries", all: "All Batteries" },
  { id: "signal", label: "Signal", title: "Signal", all: "All Radios" },
];
const PH_TAB = Object.fromEntries(PH_TABS.map((t) => [t.id, t]));
const PH_LISTS = [...PH_TABS.map((t) => t.id), "ignored"];
// what the filter button can hide (more later), where the choice is kept, and what is hidden
// until the viewer chooses: weak signal is no problem worth a card
const PH_HIDE_ITEMS = [{ key: "sig", label: "Weak Signal", tone: COL.signal }];
const PH_HIDE_KEY = "health_phone_hide";
const PH_HIDE_DEFAULT = ["sig"];
function phBaseRows(rows, tab) {
  if (tab === "devices") return rows.filter(isDevice);
  if (tab === "helpers") return rows.filter((r) => !isDevice(r));
  if (tab === "battery") return rows.filter((r) => r.battery !== null);
  if (tab === "signal") return rows.filter((r) => r.rssi !== null);
  return rows.filter((r) => r.ignored);
}
function phSortFor(rows, ctx) {
  if (ctx === "battery") return rows.slice().sort((a, b) => a.battery - b.battery || a.name.localeCompare(b.name));
  if (ctx === "signal") return rows.slice().sort((a, b) => a.rssi - b.rssi || a.name.localeCompare(b.name));
  return rows.slice().sort((a, b) => a.name.localeCompare(b.name));
}
const phLevelTone = (v) => (v <= 20 ? COL.bad : v <= 40 ? COL.battery : COL.ok);
const PH_SERIES = {
  off: { name: "Problems", color: COL.bad },
  bat: { name: "Low battery", color: COL.battery },
  sig: { name: "Weak signal", color: COL.signal },
};
const PH_RANGE_WORDS = { "24h": "24 hours", "3d": "3 days", "7d": "7 days" };
// a row's Timeline & Availability: its own range, in the chart's pills
const PH_DET_RANGES = [{ id: "24h", label: "24 Hours", ms: DAY_MS }, { id: "3d", label: "3 Days", ms: 3 * DAY_MS }, { id: "7d", label: "7 Days", ms: 7 * DAY_MS }];
const PH_AV_TONE = { [AV.ok]: COL.ok, [AV.off]: COL.bad, [AV.brief]: COL.brief, [AV.restart]: COL.stale, [AV.fail]: COL.bad };

/* iOS hands a drag that nothing in a sheet or menu can take - content that fits, the dimmed
   backdrop, a list already at its end - to the page behind it, which then scrolls. So a drag
   that starts in one of them moves only what inside it can still scroll that way, never the
   page. (Pointer gestures - the sheet's own drag, a row's swipe - are untouched.) The Alerts
   card's twin. */
function scrollsTo(el, dx, dy) {
  const cs = getComputedStyle(el);
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (!/auto|scroll/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1) return false;
    return dy > 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  if (!/auto|scroll/.test(cs.overflowX) || el.scrollWidth <= el.clientWidth + 1) return false;
  return dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}
function holdPage(root) {
  let x = 0, y = 0;
  root.addEventListener("touchstart", (e) => { x = e.touches[0].clientX; y = e.touches[0].clientY; }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0], dx = t.clientX - x, dy = t.clientY - y;
    x = t.clientX; y = t.clientY;
    for (const n of e.composedPath()) {
      if (n instanceof Element && scrollsTo(n, dx, dy)) return;
      if (n === root) break;
    }
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
}

class HealthPhoneView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "devices";
    this._pq = "";            // the list's search
    this._push = null;        // the list shown over the summary: { cat }
    this._lf = null;          // a link's filters on that list
    this._pin = null;         // a chart pick: { ids, label }
    this._sel = -1;           // the chart's slot named in the callout
    this._hide = new Set(PH_HIDE_DEFAULT);
    this._pages = [];         // the sheet's pages, a stack
    this._det = new Map();    // a row's availability, by row and range
    this._reads = new Map();  // a row's battery or signal, by row, kind and range
  }

  set card(c) {
    this._card = c;
    this._range = c._range === "7d" ? "7d" : "24h";
    if (!this._built) { this._build(); this._loadHide(); }
  }
  get _hass() { return this._card._hass; }

  // the card read its summary again
  update() {
    const d = this._card._data;
    // the phone's names are the plain ones: helpers have a tab of their own here (no "_")
    this._data = { ...d, rows: d.rows.map((r) => ({ ...r, name: r.baseName })) };
    this._byId = new Map(this._data.rows.map((r) => [r.id, r]));
    this._render();
    if (!this._chartAt || Date.now() - this._chartAt > 60e3) this._loadChart();
    this.land();
  }

  _word(v) { return statusWord(v, this._data?.thresholds?.staleness); }
  _$(s) { return this.shadowRoot.querySelector(s); }
  _set(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }

  /* ---------------------------------------------------------------- frame */

  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `<style>${PHONE_STYLES}</style>
      <div class="app"><div class="pane"></div></div>
      <div class="scrim" hidden></div>
      <section class="sheet" hidden><div class="grabzone"><div class="grab"></div></div><div class="sbody"></div></section>
      <div class="pmenu" hidden></div>
      <section class="menu" hidden></section>
      <div class="toast" hidden></div>`;
    const $ = (s) => this._$(s);
    this._el = { pane: $(".pane"), scrim: $(".scrim"), sheet: $(".sheet"), sbody: $(".sbody"), pmenu: $(".pmenu"), menu: $(".menu"), toast: $(".toast") };
    this._paintPage();
    const root = this.shadowRoot;
    root.addEventListener("click", (e) => this._click(e));
    root.addEventListener("input", (e) => { if (e.target.matches(".pq")) { this._pq = e.target.value; this._render(); } });
    this._el.scrim.addEventListener("click", () => {
      if (!this._el.menu.hidden) { this._closeMenu(); return; }
      if (!this._el.pmenu.hidden) { this._closePmenu(); return; }
      this._closeSheet();
    });
    this._bindChart();
    this._bindSheetDrag();
    this._bindSwipe();
    for (const k of ["scrim", "sheet", "pmenu", "menu"]) holdPage(this._el[k]);
    // a page drawn while the page switcher still hides it (a link landing) has no size yet:
    // the white thumbs find their buttons once it shows
    new ResizeObserver(() => this._placeThumbs(false)).observe(this);
  }

  _click(e) {
    const t = e.target.closest("button, [data-open]");
    if (!t) { this._closeSwipes(); this._hideCallout(); return; }
    if (this._swiped && Date.now() - this._swiped < 350) return;   // the end of a swipe is no tap
    const d = t.dataset;
    const seg = t.closest("[data-seg]");
    if (seg && d.v) { this._segTo(seg, d.v); return; }
    if (d.unpin != null) { this._pin = null; this._sel = -1; this._hideCallout(true); this._render(); return; }
    if (d.unland) { this._unland(d.unland); return; }
    if (d.hide) { this._toggleHide(d.hide); return; }
    if (d.cat) { this._pushCat(d.cat); return; }
    if (d.act) { e.stopPropagation(); this._act(d.act, d.id); return; }
    if (d.ign) { this._ignore(d.ign); return; }
    if (d.igncancel != null) { this._closeMenu(); return; }
    if (d.close != null) { this._closeSheet(); return; }
    if (d.sback != null) { this._sheetPop(); return; }
    if (d.spush) { this._sheetPush({ type: d.spush, id: d.id, kind: d.kind }); return; }
    if (d.ent) { this._moreInfo(d.ent); return; }
    if (d.nav) { this._navigate(d.nav); return; }
    if (d.open) {
      this._closeSwipes();
      const page = { type: "row", id: d.open, ctx: d.ctx };
      if (t.closest(".sheet")) this._sheetPush(page); else this._showSheet(page);
    }
  }

  /* A segmented control: the white thumb slides to the value tapped. */
  _segTo(seg, v) {
    if (seg.dataset.seg === "tab") { if (v !== this._push?.cat) this._tabTo(v); return; }
    if (seg.dataset.seg === "hrange") { this._hrangeTo(seg, v); return; }
    if (seg.dataset.seg === "range") this._rangeTo(seg, v);
  }

  /* Another range: the pill slides; the count, its sentence and the bars slide out the way you
     go and fade, and the new range's come in from the other side once they have loaded (up to
     a moment) - the motion of every switch here. */
  async _rangeTo(seg, v) {
    if (v === this._range) return;
    const dir = v === "7d" ? 1 : -1;
    this._placeThumb(seg, v, true);
    this._range = v;
    this._sel = -1;
    this._pin = null;
    this._det.clear(); this._reads.clear();
    this._hideCallout(true);
    this._render();
    const parts = [...(this._chartbox()?.querySelectorAll(".ctext, .cbody") || [])];
    if (reduceMotion() || !parts.length) { this._loadChart(); return; }
    const seq = (this._chartLeaving = (this._rangeSeq = (this._rangeSeq || 0) + 1));
    parts.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    await Promise.all([
      ...parts.map((el) => el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 48}px)` }],
        { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {})),
      Promise.race([this._loadChart(), new Promise((ok) => setTimeout(ok, 1500))]),
    ]);
    if (seq !== this._rangeSeq) return;
    this._chartLeaving = 0;
    parts.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    this._paintChart(false, dir);
  }
  /* Timeline & Availability's range: the pill slides; what is under it slides out the way you
     go and fades, and the new range's comes in from the other side once it has loaded (up to
     a moment) - never a "Loading…" sliding in. */
  async _hrangeTo(seg, v) {
    const p = this._pages[this._pages.length - 1];
    if (!p || p.range === v) return;
    const order = PH_DET_RANGES.map((x) => x.id);
    const dir = order.indexOf(v) > order.indexOf(p.range) ? 1 : -1;
    this._placeThumb(seg, v, true);
    p.range = v;
    const r = this._byId.get(p.id);
    const det = r && this._detail(r, v);
    const body = this._el.sbody.querySelector(".hbody");
    if (!body || reduceMotion()) { this._paintSheet(); return; }
    const seq = (this._hBusy = (this._hSeq = (this._hSeq || 0) + 1));
    body.getAnimations().forEach((a) => a.cancel());
    await Promise.all([
      body.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 48}px)` }],
        { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {}),
      Promise.race([det?.loading ? det.ready : null, new Promise((ok) => setTimeout(ok, 1500))]),
    ]);
    if (seq !== this._hSeq) return;
    this._hBusy = 0;
    this._paintSheet();
    body.getAnimations().forEach((a) => a.cancel());
    body.animate([{ opacity: 0, transform: `translateX(${dir * 48}px)` }, { opacity: 1, transform: "none" }], { duration: 360, easing: IOS });
  }

  _placeThumbs(animate) {
    for (const seg of this.shadowRoot.querySelectorAll(".seg")) {
      const on = seg.querySelector("button.on") || seg.querySelector("button");
      if (on) this._placeThumb(seg, on.dataset.v, animate);
    }
  }
  _placeThumb(seg, v, animate) {
    const b = [...seg.querySelectorAll("button")].find((x) => x.dataset.v === v);
    const th = seg.querySelector(".thumb");
    if (!b || !th) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    // drawn while hidden (a view or page not shown yet): no size to take - the thumb waits
    // for the control to get one, or the picked label sits dark on nothing
    if (!b.offsetWidth) {
      this._segRo ||= new ResizeObserver((entries) => entries.forEach(({ target }) => {
        const on = target.querySelector("button.on");
        if (!on?.offsetWidth) return;
        this._segRo.unobserve(target);
        this._placeThumb(target, on.dataset.v, false);
      }));
      this._segRo.observe(seg);
      return;
    }
    th.style.transition = animate && !reduceMotion() ? `transform .34s ${IOS}, width .34s ${IOS}` : "none";
    th.style.width = `${b.offsetWidth}px`;
    th.style.transform = `translateX(${b.offsetLeft - (parseFloat(getComputedStyle(seg).paddingLeft) || 2)}px)`;
  }

  /* Another tab of the list: it slides out the way you go and fades, the tab's own comes in
     from the other side (the Alerts screen's motion); the title follows. A link's filters
     belong to the tab they came with. */
  async _tabTo(v) {
    const order = PH_TABS.map((t) => t.id);
    const dir = order.indexOf(v) > order.indexOf(this._push.cat) ? 1 : -1;
    this._tab = v;
    this._push.cat = v;
    this._lf = null;
    this._placeThumb(this._$(".tseg"), v, true);
    const pane = this._$(".tpane");
    if (reduceMotion()) { this._render(); return; }
    const seq = (this._leaving = (this._tabSeq = (this._tabSeq || 0) + 1));
    pane.getAnimations().forEach((a) => a.cancel());
    await pane.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 48}px)` }],
      { duration: 170, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
    if (seq !== this._tabSeq) return;
    this._leaving = 0;
    pane.getAnimations().forEach((a) => a.cancel());
    this._render();
    pane.animate([{ opacity: 0, transform: `translateX(${dir * 48}px)` }, { opacity: 1, transform: "none" }], { duration: 360, easing: IOS });
  }

  /* ---------------------------------------------------------------- render */

  _render(animate = false) {
    if (!this._data || this._leaving || !this._built) return;
    if (this._push) this._renderList(animate); else this._renderSummary(animate);
    if (this._sheetOpen) this._paintSheet();
    if (!this._el.pmenu.hidden) this._paintPmenu();
  }

  /* Page one: the category cards and the chart. A card pushes its list over it (iOS
     navigation: in from the right; the header's ‹ takes it back): the title, search, then the
     tabs - the list slides with them, the title follows. */
  _paintPage() {
    const pane = this._el.pane;
    if (this._push) {
      const cat = this._push.cat, tabbed = cat !== "ignored";
      pane.innerHTML = `<div class="hero"><h1 class="ptitle"></h1><div class="sub"></div></div>
        <label class="search">${PH_ICON.search}<input class="pq" type="search" placeholder="Search" autocomplete="off"></label>
        ${tabbed ? `<div class="seg tseg four" data-seg="tab"><span class="thumb"></span>${this._tabs().map((t) =>
          `<button class="${t.id === cat ? "on" : ""}" data-v="${t.id}">${t.label}</button>`).join("")}</div>` : ""}
        <div class="lfx"></div><div class="tpane${tabbed ? "" : " untabbed"}"><div class="plist"></div></div>`;
      pane.querySelector(".pq").value = this._pq;
    } else {
      pane.innerHTML = `<div class="hero"><h1>Health</h1><div class="sub"></div></div><div class="cats"></div>
        <div class="sh">Problems Over Time</div><div class="chartbox"></div><div class="pinbox"></div><div class="picked"></div>`;
    }
    requestAnimationFrame(() => this._placeThumbs(false));
  }
  // page-switcher-card's ‹: from a list, back to the summary (true: done here)
  handleBack() {
    if (!this._push) return false;
    this._closeSheet();
    this._pushCat(null);
    return true;
  }
  // the tabs there are: Signal goes while weak signal is hidden (unless a link opened it)
  _tabs() { return PH_TABS.filter((t) => !(t.id === "signal" && this._hidden("sig") && this._push?.cat !== "signal")); }
  async _pushCat(cat) {
    const dir = cat ? 1 : -1;
    const pane = this._el.pane;
    const go = () => {
      this._push = cat ? { cat } : null;
      if (cat && cat !== "ignored") this._tab = cat;
      if (!cat) this._pq = "";
      this._lf = null; this._pin = null; this._sel = -1;
      this._paintPage();
      this._render();
      if (!cat) this._paintChart(false);
      const sc = document.scrollingElement;
      const top = this.getBoundingClientRect().top + (sc?.scrollTop || 0) - 90;
      if ((sc?.scrollTop || 0) > top) sc.scrollTo({ top: Math.max(0, top) });
    };
    if (reduceMotion()) { go(); return; }
    this._leaving = 1;
    await pane.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 30}%)` }],
      { duration: 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
    this._leaving = 0;
    pane.getAnimations().forEach((a) => a.cancel());
    go();
    pane.animate([{ opacity: 0, transform: `translateX(${dir * 40}%)` }, { opacity: 1, transform: "none" }], { duration: 420, easing: IOS });
  }

  _counts() {
    const w = this._data.rows.filter((r) => !r.ignored);
    const dev = w.filter(isDevice), hel = w.filter((r) => !isDevice(r));
    const bat = w.filter((r) => r.battery !== null), sig = w.filter((r) => r.rssi !== null);
    return {
      dev, hel, bat, sig, ignored: this._data.rows.filter((r) => r.ignored),
      off: dev.filter((r) => r.offline).length, stale: w.filter((r) => r.stale && !r.offline).length,
      hbad: hel.filter((r) => r.offline || r.failed).length, failed: hel.filter((r) => r.failed && !r.offline).length,
      hoff: hel.filter((r) => r.offline).length, low: bat.filter((r) => r.lowBattery).length,
      weak: this._hidden("sig") ? 0 : sig.filter((r) => r.poorSignal).length,
    };
  }
  _summaryLine() {
    const n = this._counts();
    const parts = [n.off && `${n.off} offline`, n.hoff && `${n.hoff} helper${n.hoff === 1 ? "" : "s"} down`, n.failed && `${n.failed} failed`,
      n.stale && `${n.stale} not updating`, n.low && `${n.low} low battery`, n.weak && `${n.weak} weak signal`].filter(Boolean);
    return parts.length ? parts.join(" · ") : `All OK · ${n.dev.length} devices, ${n.hel.length} helpers`;
  }

  _renderSummary(animate) {
    this._$(".sub").textContent = this._summaryLine();
    this._set(this._$(".cats"), this._catCards());
    this._set(this._$(".pinbox"), this._pin ? `<button class="pinchip" data-unpin style="--c:${COL.bad}"><span class="cdot"></span>
      <span class="clab">${escapeHtml(this._pin.label)}</span><span class="px">${PH_ICON.x}</span></button>` : "");
    const picked = this._$(".picked");
    if (this._pin) {
      const rows = this._data.rows.filter((r) => this._pin.ids.has(r.id)).sort(phBySev("devices"));
      this._set(picked, rows.length ? `<div class="group pinned">${rows.map((r) => this._row(r, "devices")).join("")}</div>`
        : this._empty(PH_ICON.filter, "Nothing Left", "These are no longer watched.", PH_QUIET));
      if (animate && !reduceMotion()) picked.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: PH_EASE });
    } else this._set(picked, "");
  }
  // the cards, two by two: what is wrong in its colour, else how many are fine. With an odd
  // number Ignored joins them as a card of its own; with none ignored the last takes the row
  _catCards() {
    const n = this._counts();
    const lowest = n.bat.slice().sort((a, b) => a.battery - b.battery)[0];
    const card = (id, icon, name, tone, num, den, label, sub = "", tile = "") => `<button class="cat" data-cat="${id}">
        <span class="ctop"><span class="tile sm" style="--c:${tile || tone || PH_QUIET}"><ha-icon icon="${icon}"></ha-icon></span><span class="cname">${name}</span>${PH_ICON.chev}</span>
        <span class="cnum"${tone ? ` style="color:${tone}"` : ""}>${num}${den ? `<small> / ${den}</small>` : ""}</span>
        <span class="clab2"${tone ? ` style="color:${tone}"` : ""}>${label}</span>${sub ? `<span class="csub">${escapeHtml(sub)}</span>` : ""}</button>`;
    const cards = [
      n.off ? card("devices", "mdi:devices", "Devices", COL.bad, n.off, n.dev.length, "Offline", n.stale ? `${n.stale} not updating` : "")
        : card("devices", "mdi:devices", "Devices", "", n.dev.length, "", "All online", n.stale ? `${n.stale} not updating` : ""),
      n.hbad ? card("helpers", "mdi:robot-outline", "Helpers", COL.bad, n.hbad, n.hel.length, n.failed && !n.hoff ? "Failed" : "Problems")
        : card("helpers", "mdi:robot-outline", "Helpers", "", n.hel.length, "", "All working"),
      n.low ? card("battery", "mdi:battery-30", "Batteries", COL.battery, n.low, n.bat.length, "Low battery")
        : card("battery", "mdi:battery-70", "Batteries", "", lowest ? `${lowest.battery}%` : "—", "", "Lowest", lowest?.name || ""),
    ];
    if (!this._hidden("sig")) {
      cards.push(n.weak ? card("signal", "mdi:wifi", "Signal", COL.signal, n.weak, n.sig.length, "Weak signal")
        : card("signal", "mdi:wifi", "Signal", "", n.sig.length, "", "All strong"));
    }
    const ign = n.ignored;
    if (cards.length % 2 && ign.length) {
      const ends = ign.map((r) => r.ignoredUntil).filter(Boolean);
      const soonest = ends.length === ign.length ? Math.min(...ends) : null;
      cards.push(card("ignored", "mdi:eye-off-outline", "Ignored", "", ign.length, "",
        soonest ? `Until ${fmtDay(soonest)}` : ends.length ? "Some until stopped" : "Until stopped",
        ign.length === 1 ? ign[0].name : `${ign.length} items`, COL.ignored));
      return cards.join("");
    }
    if (cards.length % 2) cards[cards.length - 1] = cards[cards.length - 1].replace(`class="cat"`, `class="cat full"`);
    return cards.join("") + (ign.length ? `<button class="cat wide" data-cat="ignored"><span class="tile sm" style="--c:${COL.ignored}"><ha-icon icon="mdi:eye-off-outline"></ha-icon></span>
        <span class="cname">Ignored</span><span class="nval">${ign.length}</span>${PH_ICON.chev}</button>` : "");
  }

  // a category's list: a link's filters as chips, Needs Attention, then every row in its order
  _renderList(animate) {
    const cat = this._push.cat;
    const ctx = (r) => (cat === "ignored" ? (isDevice(r) ? "devices" : "helpers") : cat);
    const rows = phBaseRows(this._data.rows, cat);
    this._$(".ptitle").textContent = cat === "ignored" ? "Ignored" : PH_TAB[cat].title;
    this._$(".sub").textContent = `${rows.length} watched`;
    const seg = this._$(".tseg");
    if (seg) this._placeThumb(seg, cat, false);
    this._set(this._$(".lfx"), this._lfChips(rows, cat));
    const q = this._pq.trim().toLowerCase();
    const shown = rows.filter((r) => this._landed(r, ctx(r)) && (!q || `${r.name} ${r.id} ${r.area} ${phKind(r)}`.toLowerCase().includes(q)));
    const list = this._$(".plist");
    let html;
    if (!shown.length) html = this._empty(PH_ICON.filter, "No Matches", "Nothing here matches.", PH_QUIET);
    else {
      const probs = shown.filter((r) => phIsProblem(r, ctx(r))).sort(phBySev(cat));
      html = (probs.length ? this._section("Needs Attention", probs, cat, COL.bad) : "") +
        this._section(cat === "ignored" ? "Ignored" : PH_TAB[cat].all, phSortFor(shown, cat), cat);
    }
    this._set(list, html);
    if (animate && !reduceMotion()) list.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: PH_EASE });
  }
  _section(title, rows, ctx, tone = "") {
    return `<div class="sh"${tone ? ` style="color:${tone}"` : ""}>${escapeHtml(title)}<span class="shn">${rows.length}</span></div>
      <div class="group">${rows.map((r) => this._row(r, ctx)).join("")}</div>`;
  }
  _empty(icon, title, body, tone = COL.ok) {
    return `<div class="empty"><span class="eic" style="--c:${tone}">${icon}</span>
      <div class="et">${escapeHtml(title)}</div><div class="eb">${escapeHtml(body)}</div></div>`;
  }

  /* One line per row: its tile (in its problem's colour, else grey), its name, and on the
     right its status - or, in Battery and Signal, the reading alone. No chevron: a phone's line
     has no width to spare. A swipe left offers Ignore. */
  _row(r, ctx) {
    const st = statusOf(r, ctx === "ignored" ? (isDevice(r) ? "devices" : "helpers") : ctx);
    const bad = PH_SEV[st.text] < 4;
    const id = escapeHtml(r.id);
    return `<div class="swipe"><div class="acts"><button class="swact" data-act="ignore" data-id="${id}">${r.ignored ? "Ignored" : "Ignore"}</button></div>
      <button class="row" data-open="${id}" data-ctx="${ctx === "ignored" ? "" : ctx}">
        <span class="tile" style="--c:${bad ? st.tone : r.ignored ? COL.ignored : PH_QUIET}"><ha-icon icon="${phIconOf(r)}"></ha-icon></span>
        <span class="t1">${escapeHtml(r.name)}</span><span class="meta">${this._trail(r, ctx, st)}</span></button></div>`;
  }
  _trail(r, ctx, st) {
    // the Ignored list says until when; any other list says Ignored, like any status
    if (ctx === "ignored") return `<span class="val">${r.ignoredUntil ? `until ${escapeHtml(fmtDay(r.ignoredUntil))}` : "Ignored"}</span>`;
    if (["Ignored", "Unavailable", "Failed", "Not updating"].includes(st.text)) return `<span class="stt" style="--c:${st.tone}">${escapeHtml(this._word(st.text))}</span>`;
    // the reading in the tablet's colours: battery by its level, signal by its quality
    if (ctx === "battery" && r.battery !== null) return `<span class="stt" style="--c:${phLevelTone(r.battery)}">${r.battery}%</span>`;
    if (ctx === "signal" && r.rssi !== null) return `<span class="stt" style="--c:${qualityTone(r.quality)}">${r.rssi} ${escapeHtml(r.unit || "dBm")}</span>`;
    // devices and helpers: the status, OK too
    return `<span class="stt" style="--c:${st.tone}">${escapeHtml(st.text)}</span>`;
  }

  /* ---------------------------------------------------------------- a link's filters */

  /* hm_tab, hm_status, hm_integration, hm_area, hm_quality, hm_q, hm_range, hm_rows +
     hm_alert, hm_open - what the tablet's address says (URL_PARAMS), read once per address:
     the list it names opens with them as chips (the alert's rows as the alert's chip, "2 of
     6"); ✕ lets one go. The rows a link names always show: a status that would hide one of
     them is dropped. */
  land() {
    if (!this._data || !this._built) return;
    const q = new URLSearchParams(location.search);
    const sig = [...q.entries()].filter(([k]) => k.startsWith("hm_")).map(([k, v]) => `${k}=${v}`).join("&");
    if (sig === this._landedSig) return;
    this._landedSig = sig;
    if (!sig) return;
    const val = (k) => q.get(k) || "";
    const tab = PH_LISTS.includes(val("hm_tab")) ? val("hm_tab") : "devices";
    const ctx = (r) => (tab === "ignored" ? (isDevice(r) ? "devices" : "helpers") : tab);
    const lf = { status: new Set(), plat: new Set(), area: new Set(), quality: new Set(), rows: null, alert: null };
    pickSlugs(lf.status, val("hm_status"), STATUS_NAMES[tab] || []);
    pickSlugs(lf.plat, val("hm_integration"), this._data.rows.map((r) => r.platform));
    pickSlugs(lf.area, val("hm_area"), this._data.rows.map((r) => r.area));
    pickSlugs(lf.quality, val("hm_quality"), ["Poor", "OK", "Good"]);
    if (val("hm_rows")) {
      const rows = new Set();
      for (const x of val("hm_rows").split(",")) { const r = this._card._rowFor(x.trim()); if (r) rows.add(r.id); }
      if (rows.size) lf.rows = rows;
    }
    if (lf.rows && /^alert2\.[a-z0-9_]+$/.test(val("hm_alert"))) lf.alert = val("hm_alert");
    if (lf.rows && lf.status.size && this._data.rows.some((r) => lf.rows.has(r.id) && !lf.status.has(statusOf(r, ctx(r)).text))) lf.status.clear();
    this._closeSheet(); this._closeMenu(); this._closePmenu();
    this._lf = lf.rows || lf.status.size || lf.plat.size || lf.area.size || lf.quality.size ? lf : null;
    this._pq = val("hm_q");
    this._pin = null; this._sel = -1;
    this._push = { cat: tab };
    if (tab !== "ignored") this._tab = tab;
    const range = val("hm_range") === "7d" ? "7d" : val("hm_range") ? "24h" : this._range;
    if (range !== this._range) { this._range = range; this._det.clear(); this._reads.clear(); this._loadChart(); }
    this._paintPage();
    this._render();
    const open = val("hm_open");
    if (open && this._byId.has(open)) this._showSheet({ type: "row", id: open, ctx: tab === "ignored" ? "" : tab });
  }
  // a row against the link's filters - and its rows, unless `all`
  _landed(r, ctx, all = false) {
    const lf = this._lf;
    if (!lf) return true;
    if (lf.status.size && !lf.status.has(statusOf(r, ctx).text)) return false;
    if (lf.plat.size && !lf.plat.has(r.platform)) return false;
    if (lf.area.size && !lf.area.has(r.area)) return false;
    if (lf.quality.size && !lf.quality.has(r.quality)) return false;
    return all || !lf.rows || lf.rows.has(r.id);
  }
  _lfChips(rows, ctx) {
    const lf = this._lf;
    if (!lf) return "";
    let html = "";
    if (lf.rows) {
      const al = lf.alert ? this._hass.states[lf.alert] : null;
      const n = rows.filter((r) => this._landed(r, ctx)).length, m = rows.filter((r) => this._landed(r, ctx, true)).length;
      html += `<button class="pinchip" data-unland="rows" style="--c:${PRIORITY_TONE[al?.attributes?.priority] || COL.bad}">${PH_ICON.bell}
        <span class="clab">${escapeHtml(al?.attributes?.friendly_name || "From a link")}</span><span class="pn">${n} of ${m}</span><span class="px">${PH_ICON.x}</span></button>`;
    }
    const chips = [...[...lf.status].map((v) => ["status", v, this._word(v)]), ...[...lf.plat].map((v) => ["plat", v, v.replace(/^_/, "")]),
      ...[...lf.area].map((v) => ["area", v, v]), ...[...lf.quality].map((v) => ["quality", v, `${v} signal`])];
    if (chips.length) {
      html += `<div class="chips">${chips.map(([k, v, label]) =>
        `<button class="chip" data-unland="${k}|${escapeHtml(v)}"><span class="clab">${escapeHtml(label)}</span>${PH_ICON.x}</button>`).join("")}</div>`;
    }
    return html;
  }
  _unland(k) {
    const lf = this._lf;
    if (!lf) return;
    if (k === "rows") { lf.rows = null; lf.alert = null; } else { const i = k.indexOf("|"); lf[k.slice(0, i)]?.delete(k.slice(i + 1)); }
    if (!lf.rows && !lf.status.size && !lf.plat.size && !lf.area.size && !lf.quality.size) this._lf = null;
    this._render(true);
  }

  /* ---------------------------------------------------------------- hide */

  /* What the header's filter button hides from the whole page - for now Weak signal: its card,
     its tab, its bars and its names in the chart's callout, its part of the summary line and
     a device's Signal row. Kept in the viewer's Home Assistant profile (frontend user data),
     so it follows them to every device; until they choose, PH_HIDE_DEFAULT. The button is
     white while something is hidden. */
  _hidden(key) { return this._hide.has(key); }
  async _loadHide() {
    const res = await this._card._ws({ type: "frontend/get_user_data", key: PH_HIDE_KEY });
    const v = res?.value;
    this._hide = new Set((Array.isArray(v) ? v : PH_HIDE_DEFAULT).filter((k) => PH_HIDE_ITEMS.some((x) => x.key === k)));
    this._applyHide(false);
  }
  // called by page-switcher-card's header button (button: { method: openHide, icon: filter })
  openHide(anchor) { this._openPmenu(anchor || this); }
  _toggleHide(key) {
    this._hide.has(key) ? this._hide.delete(key) : this._hide.add(key);
    this._card._ws({ type: "frontend/set_user_data", key: PH_HIDE_KEY, value: [...this._hide] });
    this._applyHide(true);
    this._paintPmenu();
  }
  _applyHide(toggled) {
    this.dispatchEvent(new CustomEvent("page-button-state", { detail: { on: this._hide.size > 0 }, bubbles: true, composed: true }));
    // just hidden while its list is open: the list moves to Devices
    if (toggled && this._hidden("sig") && this._push?.cat === "signal") { this._push.cat = "devices"; this._tab = "devices"; this._lf = null; }
    this._pin = null; this._sel = -1;
    if (!this._data) return;
    if (this._push) this._paintPage();
    this._render();
    this._paintChart();
  }
  _openPmenu(anchor) {
    const m = this._el.pmenu;
    m.hidden = false;
    this._paintPmenu();
    const b = anchor.getBoundingClientRect();
    const mw = Math.min(290, window.innerWidth - 24);
    const left = Math.min(window.innerWidth - mw - 12, Math.max(12, b.right - mw));
    Object.assign(m.style, { width: `${mw}px`, left: `${left}px`, top: `${b.bottom + 8}px`, maxHeight: `${window.innerHeight - b.bottom - 24}px`,
      transformOrigin: `${b.left + b.width / 2 - left}px 0` });
    this._el.scrim.hidden = false;
    this._el.scrim.classList.add("clear");
    if (!reduceMotion()) m.animate([{ opacity: 0, transform: "scale(.5)" }, { opacity: 1, transform: "none" }], { duration: 340, easing: IOS });
  }
  _paintPmenu() {
    this._el.pmenu.innerHTML = `<div class="mgh">Hide</div>` + PH_HIDE_ITEMS.map((x) => `<button class="mrow" data-hide="${x.key}">
      <span class="mck">${this._hide.has(x.key) ? PH_ICON.check : ""}</span><span class="mdot" style="--c:${x.tone}"></span>
      <span class="mlab">${escapeHtml(x.label)}</span></button>`).join("");
  }
  _closePmenu() {
    const m = this._el.pmenu;
    if (m.hidden) return;
    this._el.scrim.classList.remove("clear");
    if (!this._sheetOpen) this._el.scrim.hidden = true;
    if (reduceMotion()) { m.hidden = true; return; }
    m.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.85)" }], { duration: 180, easing: "ease-in" })
      .finished.then(() => { m.hidden = true; });
  }

  /* ================================================================ the chart
     The card's problem counts over time (offline, low battery, weak signal - what is not
     hidden): per slot, the rows that had the problem at any moment of it. The Alerts phone
     chart: a scale of two or three whole numbers, folded to its count when nothing happened;
     a finger names what is behind a slot, a tap lists it under a red chip. */

  async _loadChart() {
    this._chartAt = Date.now();
    const end = Date.now();
    const slots = slotGrid(end - (this._range === "7d" ? 7 * DAY_MS : DAY_MS), end, 12);
    const base = `sensor.entity_availability_${this._card._config.group}`;
    const ids = ["offline_count", "low_battery_count", "poor_signal_count"].map((k) => `${base}_${k}`);
    const seq = (this._chartSeq = (this._chartSeq || 0) + 1);
    const res = await this._card._ws({ type: "history/history_during_period", start_time: new Date(slots[0].a).toISOString(),
      end_time: new Date(end).toISOString(), entity_ids: [...ids, ...problemEntities(base)], minimal_response: false, no_attributes: false,
      significant_changes_only: false });
    if (seq !== this._chartSeq) return;
    const failing = this._card._hass?.states?.[`${base}_group_summary`]?.attributes?.failed_entities;
    this._chart = { slots, end, raw: { off: problemSets(res, base, slots, end, failing, (x) => (this._card._data && this._card._rowFor(x)?.id) || x),
      bat: slotSets(res?.[ids[1]] || [], slots, end, listIds), sig: slotSets(res?.[ids[2]] || [], slots, end, listIds) } };
    this._paintChart();
  }
  // one problem's bars, the entities its history names turned into rows
  _series(key) {
    const c = this._chart;
    if (!c) return { key, ...PH_SERIES[key], per: [] };
    const per = c.raw[key].map((p) => {
      const ids = new Set();
      if (p.ids) for (const x of p.ids) { const r = this._card._rowFor(x); if (r) ids.add(r.id); }
      return { v: p.ids ? ids.size : p.v, ids };
    });
    return { key, ...PH_SERIES[key], per };
  }
  _allSeries() { return ["off", "bat", "sig"].filter((k) => !this._hidden(k)).map((k) => this._series(k)); }
  _chartbox() { return this._$(".chartbox"); }
  _rangeSeg() {
    return `<div class="seg rseg" data-seg="range"><span class="thumb"></span>${["24h", "7d"].map((r) =>
      `<button class="${r === this._range ? "on" : ""}" data-v="${r}">${r.toUpperCase()}</button>`).join("")}</div>`;
  }
  /* `animate`: the bars grow; `dir`: drawn for another range - it comes in from that side.
     The card and its range pills stay; what is under them is drawn anew. */
  _paintChart(animate = true, dir = 0) {
    const box = this._chartbox();
    if (!box || this._push || !this._data || this._chartLeaving) return;
    let card = box.querySelector(".chart");
    if (!card) {
      box.innerHTML = `<div class="card chart"><div class="chd"><div class="ctext"></div>${this._rangeSeg()}</div>
        <div class="cbody"></div><div class="callout" hidden></div></div>`;
      card = box.querySelector(".chart");
      this._placeThumbs(false);
    }
    const text = card.querySelector(".ctext"), body = card.querySelector(".cbody");
    const c = this._chart;
    if (!c) { text.innerHTML = `<div class="abig">–</div><div class="asub">Loading…</div>`; body.innerHTML = ""; return; }
    const series = this._allSeries();
    this._shown = series;
    const { slots } = c, n = slots.length;
    const peak = Math.max(1, ...series.flatMap((s) => s.per.map((p) => p.v)));
    const step = peak <= 2 ? 1 : Math.ceil(peak / 2), max = peak <= 2 ? peak : step * 2;
    const ticks = [];
    for (let v = 0; v <= max; v += step) ticks.push(v);
    const fired = new Set();
    series.forEach((s) => s.per.forEach((p) => p.ids.forEach((id) => fired.add(id))));
    const count = fired.size || Math.max(0, ...series.flatMap((s) => s.per.map((p) => p.v)));
    // a slot where nothing happened: a short white stub at zero, a bar wide (as the Alerts card)
    const bars = slots.map((sl, i) => `<span class="slot${i === this._sel ? " sel" : ""}" data-i="${i}">${series.every((s) => !s.per[i].v)
      ? `<i class="zero" style="--d:${animate ? i * 14 : 0}ms${animate ? "" : ";animation:none"}"></i>`
      : series.map((s) => {
        const v = s.per[i].v;
        return `<i style="--c:${s.color};--d:${animate ? i * 14 : 0}ms;height:${v ? Math.max(5, (v / max) * 100) : 0}%${animate ? "" : ";animation:none"}"></i>`;
      }).join("")}</span>`).join("");
    const axis = [0, Math.round(n / 3), Math.round((2 * n) / 3)].map((i) => {
      const a = slots[i]?.a;
      if (!a) return "";
      const label = this._range === "24h" ? phHour(a) : new Date(a).toLocaleDateString(LOCALE.lang, { weekday: "short" });
      return `<span style="left:${(i / n) * 100}%">${escapeHtml(label)}</span>`;
    }).join("");
    const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span style="--c:${s.color}"><i></i>${s.name}</span>`).join("")}</div>` : "";
    const h0 = box.offsetHeight;
    card.classList.toggle("folded", !count);
    card.querySelector(".callout").hidden = true;
    text.innerHTML = `<div class="abig">${count}</div><div class="asub">${count === 1 ? "problem" : "problems"} in last ${PH_RANGE_WORDS[this._range]}</div>`;
    body.innerHTML = count ? `<div class="plot"><div class="yax"><i>${max}</i>${ticks.map((v) => `<span style="bottom:${(v / max) * 100}%">${v}</span>`).join("")}</div>
        <div class="bars k${series.length}" style="--n:${n}">${ticks.slice(1).map((v) => `<b class="gl" style="bottom:${(v / max) * 100}%"></b>`).join("")}${bars}</div>
        <span></span><div class="axis">${axis}</div></div>${legend}` : "";
    // folding or unfolding (another range): the card eases to its new height
    const h1 = box.offsetHeight;
    if (h0 && h1 !== h0 && !reduceMotion()) box.animate([{ height: `${h0}px`, overflow: "hidden" }, { height: `${h1}px`, overflow: "hidden" }], { duration: 320, easing: IOS });
    if (dir && !reduceMotion()) {
      for (const el of [text, body]) el.animate([{ opacity: 0, transform: `translateX(${dir * 48}px)` }, { opacity: 1, transform: "none" }], { duration: 360, easing: IOS });
    }
    if (this._sel >= 0 && this._sel < n) this._showCallout(this._sel); else this._sel = -1;
  }
  _slotAt(x) {
    const area = this._chartbox()?.querySelector(".bars");
    const c = this._chart;
    if (!area || !c) return -1;
    const r = area.getBoundingClientRect();
    if (x < r.left || x > r.right) return -1;
    return Math.min(c.slots.length - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * c.slots.length)));
  }
  _bindChart() {
    const root = this.shadowRoot;
    root.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".bars")) return;
      this._press = { x: e.clientX, y: e.clientY, moved: false };
      const i = this._slotAt(e.clientX);
      if (i >= 0) this._showCallout(i);
    });
    root.addEventListener("pointermove", (e) => {
      if (!this._press) return;
      if (Math.hypot(e.clientX - this._press.x, e.clientY - this._press.y) > 10) this._press.moved = true;
      const i = this._slotAt(e.clientX);
      if (i >= 0 && i !== this._sel) this._showCallout(i);
    });
    const up = (e) => {
      const p = this._press;
      this._press = null;
      if (!p || p.moved || e.type === "pointercancel") return;
      this._pick(e);
    };
    root.addEventListener("pointerup", up);
    root.addEventListener("pointercancel", up);
  }
  _showCallout(i) {
    const c = this._chart, box = this._chartbox();
    const co = box?.querySelector(".callout");
    if (!c || !co || !this._shown) return;
    // folded (nothing in the range) or not drawn yet: no slot to point at - the pick lets go
    if (!box.querySelector(`[data-i="${i}"]`)) { this._sel = -1; co.hidden = true; return; }
    this._sel = i;
    box.querySelectorAll("[data-i]").forEach((s) => s.classList.toggle("sel", Number(s.dataset.i) === i));
    const sl = c.slots[i];
    const parts = this._shown.map((s) => ({ s, p: s.per[i] })).filter((x) => x.p.v > 0)
      .map((x) => ({ ...x, names: [...x.p.ids].map((id) => this._byId.get(id)?.name || id).sort((a, b) => a.localeCompare(b)) }));
    const room = shareOut(parts.map((x) => x.names.length), 6);
    co.innerHTML = `<div class="cwhen">${escapeHtml(phSlot(sl.a, sl.b))}</div>` + (parts.length
      ? parts.map(({ s, p, names }, j) => `<div class="csec" style="--c:${s.color}"><div class="chd2"><i></i>${escapeHtml(s.name)}<b>${p.v}</b></div>
          ${names.slice(0, room[j]).map((nm) => `<div class="cname">${escapeHtml(nm)}</div>`).join("")}
          ${names.length > room[j] ? `<div class="cmore">and ${names.length - room[j]} more</div>` : ""}</div>`).join("")
      : `<div class="cnone">No problems</div>`);
    const wasHidden = co.hidden;
    co.hidden = false;
    // over the chart, above its slot; never past the card's edges
    const card = box.querySelector(".chart").getBoundingClientRect();
    const slot = box.querySelector(`[data-i="${i}"]`).getBoundingClientRect();
    const w = co.offsetWidth;
    co.style.transform = `translateX(${Math.round(Math.max(8, Math.min(card.width - w - 8, slot.left - card.left + slot.width / 2 - w / 2)))}px)`;
    if (wasHidden && !reduceMotion()) co.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
  }
  _hideCallout(force = false) {
    const box = this._chartbox();
    const co = box?.querySelector(".callout");
    if (!co || co.hidden) return;
    co.hidden = true;
    if (!this._pin || force) { this._sel = -1; box.querySelectorAll("[data-i].sel").forEach((s) => s.classList.remove("sel")); }
    // a finger that wandered off the picked slot: the highlight goes back to it
    else if (this._pin.i != null) {
      this._sel = this._pin.i;
      box.querySelectorAll("[data-i]").forEach((s) => s.classList.toggle("sel", Number(s.dataset.i) === this._sel));
    }
  }
  // a tap on a slot: every row that had a problem in it, whatever it is now, under a red chip
  _pick(e) {
    const c = this._chart, i = this._slotAt(e.clientX);
    if (!c || i < 0 || !this._shown) return;
    const ids = new Set(this._shown.flatMap((s) => [...s.per[i].ids]));
    if (!ids.size) return;
    this._pin = { ids, label: phSlot(c.slots[i].a, c.slots[i].b), i };
    this._render(true);
    this._showCallout(i);
  }

  /* ================================================================ the sheet
     The Alerts phone sheet: opens just tall enough for the page's own part, a drag or a
     scroll raises it to the full screen, pages push inside it. */

  _showSheet(page) {
    this._pages = [page];
    this._sheetOpen = true;
    const { sheet, scrim } = this._el;
    sheet.hidden = false; scrim.hidden = false;
    sheet.style.height = `${this._sheetH()}px`;
    this._paintSheet(true);
    this._detent = "medium";
    this._setSheet(this._y("medium"), false, true);
    if (!reduceMotion()) scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "linear" });
  }
  _sheetPush(page) {
    this._pages.push(page);
    if (this._detent !== "large") this._toDetent("large");
    this._slideSheet(1);
  }
  _sheetPop() { if (this._pages.length > 1) { this._pages.pop(); this._slideSheet(-1); } }
  _slideSheet(dir) {
    const b = this._el.sbody;
    if (reduceMotion()) { this._paintSheet(true); return; }
    b.getAnimations().forEach((a) => a.cancel());
    b.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-dir * 24}%)`, opacity: 0 }],
      { duration: 150, easing: "cubic-bezier(.4,0,1,1)" }).finished.then(() => {
      this._paintSheet(true);
      b.animate([{ transform: `translateX(${dir * 40}%)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, easing: IOS });
    }, () => {});
  }
  _paintSheet(fresh = false) {
    const p = this._pages[this._pages.length - 1];
    if (!p) return;
    const b = this._el.sbody;
    const scroll = fresh ? 0 : b.scrollTop;
    const r = this._byId.get(p.id);
    if (!r) { this._closeSheet(); return; }
    const body = b._page === p && b.querySelector(".hbody");
    if (body) { if (!this._hBusy) this._set(body, this._historyBody(r, p)); return; }
    const html = {
      row: () => this._rowPage(r, p), history: () => this._historyPage(r, p),
      entities: () => this._entitiesPage(r), reading: () => this._readingPage(r, p.kind),
    }[p.type]?.() || "";
    if (b._html !== html) { b._html = html; b.innerHTML = html; this._placeThumbs(false); }
    b._page = p;
    b.scrollTop = scroll;
  }
  _backBtn() { return this._pages.length > 1 ? `<button class="glass sback" data-sback aria-label="Back">${PH_ICON.back}</button>` : ""; }
  _closeBtn() { return `<button class="glass sclose" data-close aria-label="Close">${PH_ICON.x}</button>`; }
  // a page's heading under a row of its own for back and close, as in an iOS sheet
  _head(icon, title, sub) {
    return `<div class="sbar2">${this._backBtn() || "<span></span>"}${this._closeBtn()}</div>
      <div class="shead">${icon}<div class="shtxt"><div class="sht1">${escapeHtml(title)}</div>${sub}</div></div>`;
  }
  _listHead(title, sub = "") {
    return `<div class="sbar2">${this._backBtn() || "<span></span>"}${this._closeBtn()}</div>
      <div class="ph1">${escapeHtml(title)}</div>${sub ? `<div class="ph2">${escapeHtml(sub)}</div>` : ""}`;
  }
  _navRow(attrs, icon, label, value = "", tone = "") {
    return `<button class="nrow" ${attrs}><span class="tile sm" style="--c:${PH_QUIET}"><ha-icon icon="${icon}"></ha-icon></span>
      <span class="nlab">${escapeHtml(label)}</span>${value ? `<span class="nval${tone ? " tv" : ""}"${tone ? ` style="color:${tone}"` : ""}>${escapeHtml(value)}</span>` : ""}${PH_ICON.chev}</button>`;
  }
  _memberName(r, m) { return this._card._memberName(r, m); }

  /* A row: what it is and how it is now, More Info and Ignore, a job's last run, then its
     battery, signal, timeline & availability and entities behind rows - the reading the list
     is about first. */
  _rowPage(r, p) {
    const ctx = p.ctx || (isDevice(r) ? "devices" : "helpers");
    const st = statusOf(r, ctx);
    const id = escapeHtml(r.id);
    const sub = [phKind(r), isDevice(r) ? r.area : ""].filter(Boolean).join(" · ");
    const tile = `<span class="tile lg" style="--c:${PH_SEV[st.text] < 4 ? st.tone : r.ignored ? COL.ignored : PH_QUIET}"><ha-icon icon="${phIconOf(r)}"></ha-icon></span>`;
    const acts = `<div class="sacts"><button class="big" data-act="moreinfo" data-id="${id}">More Info</button>
      <button class="big${r.ignored ? " light" : ""}" data-act="ignore" data-id="${id}">${r.ignored ? "Ignored" : "Ignore"}</button></div>`;
    this._detail(r, this._range);   // fetched ahead: Timeline & Availability opens on it
    const rows = [
      // readings in the tablet's colours: battery by its level, signal by its quality
      r.battery !== null ? this._navRow(`data-spush="reading" data-kind="battery" data-id="${id}"`, "mdi:battery-70", "Battery", `${r.battery}%`, phLevelTone(r.battery)) : "",
      r.rssi !== null && !this._hidden("sig") ? this._navRow(`data-spush="reading" data-kind="signal" data-id="${id}"`, "mdi:wifi", "Signal", `${r.rssi} ${r.unit || "dBm"}`, qualityTone(r.quality)) : "",
      this._navRow(`data-spush="history" data-id="${id}"`, "mdi:timeline-clock-outline", "Timeline & Availability"),
      r.members.length > 1 ? this._navRow(`data-spush="entities" data-id="${id}"`, "mdi:format-list-bulleted", "Entities", String(r.members.length)) : "",
    ];
    if (ctx === "signal") rows.unshift(rows.splice(1, 1)[0]);
    return this._head(tile, r.name, `<div class="sht2">${escapeHtml(sub)}</div>`) + this._pill(r, ctx, st) + acts +
      (isJob(r) ? this._runCard(r) : "") + `<div class="group navs">${rows.join("")}</div>`;
  }
  _pill(r, ctx, st) {
    let tail, tone = "";
    if (st.text === "Ignored") tail = r.ignoredUntil ? `until ${fmtDT(r.ignoredUntil)}` : "until stopped";
    else if (st.text === "Unavailable") { const s = Date.parse(r.offlineSince || r.lastSeen); tail = s ? `for ${phFor(Date.now() - s)}` : ""; }
    else if (st.text === "Not updating") tail = r.staleSince ? `since ${phRelLong(Date.parse(r.staleSince))}` : "";
    else if (st.text === "Failed") tail = r.run?.finished ? phRelLong(Date.parse(r.run.finished)) : "";
    // a reading keeps its own colour (as on the tablet), whatever the status's
    else if (ctx === "battery" && r.battery !== null) { tail = `${r.battery}%`; tone = phLevelTone(r.battery); }
    else if (ctx === "signal" && r.rssi !== null) { tail = `${r.rssi} ${r.unit || "dBm"}`; tone = qualityTone(r.quality); }
    else if (isJob(r)) { const t = this._hass.states[r.id]?.attributes?.last_triggered; tail = t ? `ran ${phRelLong(Date.parse(t))}` : "never ran"; }
    else tail = "seen now";
    const val = tone ? `<span style="color:${tone}">${escapeHtml(tail)}</span>` : escapeHtml(tail);
    return `<div class="sstat" style="--c:${st.tone}"><span class="sdot"></span>${escapeHtml(this._word(st.text))}${tail ? ` · ${val}` : ""}</div>`;
  }
  _traceUrl(r) {
    let url = r.failed && r.run?.trace_url;
    if (!url) {
      const st = this._hass.states[r.id];
      const itemId = r.id.startsWith("automation.") ? st?.attributes?.id : r.id.split(".")[1];
      if (itemId) url = `/config/${r.id.split(".")[0]}/trace/${itemId}`;
    }
    return url || "";
  }
  // an automation's or a script's latest run: how it ended, why, and its trace
  _runCard(r) {
    const ran = this._hass.states[r.id]?.attributes?.last_triggered;
    const failed = r.failed && r.run;
    const when = failed ? Date.parse(r.run.finished) : ran ? Date.parse(ran) : null;
    const tone = failed ? COL.bad : ran ? COL.ok : COL.stale;
    const url = this._traceUrl(r);
    return `<div class="sh2">Last Run</div><div class="group runcard">
      <div class="runline" style="--c:${tone}"><span class="sdot"></span><b>${failed ? "Failed" : ran ? "Finished" : "Never ran"}</b>${when ? `<span class="evt">· ${escapeHtml(fmtDT(when))}</span>` : ""}</div>
      ${failed && r.run.error ? `<div class="runerr">${escapeHtml(r.run.error)}</div>` : ""}
      ${url ? `<button class="runbtn" data-nav="${escapeHtml(url)}">Open Trace${PH_ICON.chev}</button>` : ""}</div>`;
  }

  /* Availability: a bar per entity, the card's judgement (available, unavailable, a brief
     drop-out, a restart) over the range; the name over its bar, as fits a phone. */
  _bandCard(r, det) {
    if (det.loading) return `<div class="group bandcard"><div class="loading sm">Loading…</div></div>`;
    if (!det.ids.length) return `<div class="group bandcard"><div class="loading sm">No recorded history in this window.</div></div>`;
    const span = det.end - det.start;
    const seen = new Set();
    const tracks = det.ids.map((m) => {
      const pts = det.pts[m];
      const segs = pts.map(([t, s], i) => {
        const a = Math.max(t, det.start), b = Math.min(pts[i + 1]?.[0] ?? det.end, det.end);
        if (b <= a) return "";
        seen.add(s);
        const w = ((b - a) / span) * 100;
        return `<i style="left:${((a - det.start) / span) * 100}%;width:${s === AV.ok ? `${w}%` : `max(3px,${w}%)`};--c:${PH_AV_TONE[s]}"></i>`;
      }).join("");
      return `<div class="trk"><div class="tlab">${escapeHtml(this._memberName(r, m))}</div><div class="tbar">${segs}</div></div>`;
    }).join("");
    const lab = (t) => (span > 2 * DAY_MS ? new Date(t).toLocaleDateString(LOCALE.lang, { weekday: "short" }) : phHour(t));
    const legend = [AV.ok, AV.off, AV.fail, AV.brief, AV.restart].filter((s) => seen.has(s))
      .map((s) => `<span style="--c:${PH_AV_TONE[s]}"><i></i>${s === AV.restart ? "Restart" : s}</span>`).join("");
    return `<div class="group bandcard">${tracks}
      <div class="baxis"><span>${escapeHtml(lab(det.start))}</span><span>${escapeHtml(lab(det.start + span / 2))}</span><span>Now</span></div>
      <div class="legend">${legend}</div></div>`;
  }
  _tlHtml(det) {
    if (det.loading) return `<div class="loading sm">Loading…</div>`;
    if (!det.items.length) return `<div class="foot">No availability changes in this window.</div>`;
    return `<div class="tline">${det.items.map((it) => `<div class="tev"><span class="tt">${escapeHtml(fmtTime(it.t))}${phDayTitle(it.t) === "Today" ? "" : `<br><small>${escapeHtml(phDayTitle(it.t))}</small>`}</span>
      <span class="tdot" style="--c:${it.tone}"></span><span class="tbody"><span class="t1">${escapeHtml(it.text)}</span>${it.sub ? `<span class="t2">${escapeHtml(it.sub)}</span>` : ""}${
        it.trace ? `<button class="ttrace" data-nav="${escapeHtml(it.trace)}">Open Trace${PH_ICON.chev}</button>` : ""}</span></div>`).join("")}</div>`;
  }
  /* Timeline & Availability: a bar per entity, then every change, newest first - over 1D, 3D
     or 7D, picked right here (it opens on the chart's range). */
  _historyPage(r, p) {
    p.range ||= this._range;
    return this._listHead("Timeline & Availability", r.name) +
      `<div class="seg rseg hseg" data-seg="hrange"><span class="thumb"></span>${PH_DET_RANGES.map((x) =>
        `<button class="${x.id === p.range ? "on" : ""}" data-v="${x.id}">${x.label}</button>`).join("")}</div>
      <div class="hbody">${this._historyBody(r, p)}</div>`;
  }
  _historyBody(r, p) {
    const det = this._detail(r, p.range);
    return `<div class="sh2">Availability</div>${this._bandCard(r, det)}<div class="sh2">Timeline</div>${this._tlHtml(det)}`;
  }
  _entitiesPage(r) {
    return this._listHead("Entities", `What ${r.name} is watched by`) + `<div class="group navs0">${r.members.map((m) => {
      const s = this._hass.states[m]?.state;
      const off = s == null || BAD_STATES.has(String(s));
      return `<button class="nrow" data-ent="${escapeHtml(m)}"><span class="nlab">${escapeHtml(this._memberName(r, m))}</span>
        <span class="nval tv" style="color:${off ? COL.bad : COL.ok}">${off ? "Unavailable" : "Available"}</span>${PH_ICON.chev}</button>`;
    }).join("")}</div>`;
  }
  _readingPage(r, kind) {
    return this._listHead(kind === "battery" ? "Battery" : "Signal", `${r.name} · last ${PH_RANGE_WORDS[this._range]}`) + this._readingCard(r, kind);
  }

  /* ---------------------------------------------------------------- a row's history */

  _detail(r, range) {
    const key = `${r.id}|${range}`;
    const have = this._det.get(key);
    if (have && (have.loading || Date.now() - have.at < 60e3)) return have;
    const entry = { loading: true };
    this._det.set(key, entry);
    entry.ready = this._loadDetail(r, key, range);
    return have || entry;
  }
  async _loadDetail(r, key, range) {
    const end = Date.now(), start = end - (PH_DET_RANGES.find((x) => x.id === range)?.ms || DAY_MS);
    const [res, R, IG, F] = await Promise.all([this._card._ws({ type: "history/history_during_period", start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(), entity_ids: r.members, minimal_response: true, no_attributes: true, significant_changes_only: false }),
      this._card._restartInfo(), this._card._ignoreInfo(), isJob(r) ? this._card._failureInfo() : null]);
    const ids = r.members.filter((m) => (res?.[m] || []).length);
    const pts = Object.fromEntries(ids.map((m) => [m, availSegments(res[m], R, end)]));
    // a job: red while its runs were failing (the card's _drawTimeline)
    const fails = isJob(r) ? failSpans(r, F) : [];
    if (pts[r.id]) pts[r.id] = withFailing(pts[r.id], fails, end);
    this._det.set(key, { at: Date.now(), start, end, ids, pts, items: this._tlItems(r, ids, pts, R, IG, start, end, fails) });
    this._arrived(r.id);
  }
  // the card's timeline (_drawTimeline): going down, coming back, drop-outs, restarts once, ignores,
  // a job failing and recovering
  _tlItems(row, ids, pts, R, IG, startMs, endMs, fails = []) {
    const items = [];
    for (const s of fails) {
      const a = Date.parse(s.since), b = s.until ? Date.parse(s.until) : null;
      if (a >= startMs && a <= endMs) {
        items.push({ t: a, tone: COL.bad, text: "Failing", sub: [s.error, s.runs > 1 && `${s.runs} failed runs`].filter(Boolean).join(" · "), trace: s.trace_url });
      }
      if (b && b >= startMs && b <= endMs) items.push({ t: b, tone: COL.ok, text: "Recovered", sub: "" });
    }
    for (const m of ids) {
      const p = pts[m], nm = this._memberName(row, m);
      p.forEach(([t, st], i) => {
        if (i === 0 || t < startMs) return;
        if (st === AV.off) items.push({ t, tone: COL.bad, text: "Unavailable", sub: nm });
        else if (st === AV.brief) items.push({ t, tone: COL.brief, text: "Brief drop-out", sub: `${nm} · ${fmtDur((p[i + 1]?.[0] ?? endMs) - t)}` });
        else if (st === AV.ok && p[i - 1][1] === AV.off) items.push({ t, tone: COL.ok, text: "Available", sub: nm });
      });
    }
    for (const w of restartWindows(R)) {
      if (w.started < startMs || w.started > endMs) continue;
      const known = R.restarts.find((x) => Date.parse(x.started) === w.started)?.stopped;
      items.push({ t: w.started, tone: COL.stale, text: "Home Assistant restarted", sub: known ? `down ${fmtDur(w.started - w.down)}` : "" });
    }
    const mine = (IG || []).filter((e) => (e.entity_ids || []).some((x) => row.members.includes(x))).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const inWin = (t) => t >= startMs && t <= endMs;
    mine.forEach((e, k) => {
      const t = Date.parse(e.t);
      if (e.kind === "ignored") {
        const until = e.until ? Date.parse(e.until) : null;
        if (inWin(t)) items.push({ t, tone: COL.ignored, text: "Ignored", sub: [e.user && `by ${e.user}`, until ? `until ${fmtDT(until)}` : "until stopped"].filter(Boolean).join(" · ") });
        const next = mine[k + 1] ? Date.parse(mine[k + 1].t) : Infinity;
        if (until && until <= Date.now() && until < next && inWin(until)) items.push({ t: until, tone: COL.stale, text: "Ignore ended", sub: "its time was up" });
      } else if (e.kind === "unignored" && inWin(t)) items.push({ t, tone: COL.stale, text: "No longer ignored", sub: e.user ? `by ${e.user}` : "" });
    });
    return items.sort((a, b) => b.t - a.t);
  }
  _arrived(id) { if (this._sheetOpen && this._pages[this._pages.length - 1]?.id === id) this._paintSheet(); }

  /* Battery or signal over the range: a step line (a reading holds until the next), gaps where
     the sensor had none, now / lowest / highest under it. */
  _reading(r, kind) {
    const key = `${r.id}|${kind}|${this._range}`;
    const have = this._reads.get(key);
    if (have && (have.loading || Date.now() - have.at < 60e3)) return have;
    this._reads.set(key, { loading: true });
    (async () => {
      const src = kind === "battery" ? r.batterySource : r.signalSource;
      const end = Date.now(), start = end - (this._range === "7d" ? 7 * DAY_MS : DAY_MS);
      const res = src ? await this._card._ws({ type: "history/history_during_period", start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(), entity_ids: [src], minimal_response: true, no_attributes: true, significant_changes_only: false }) : null;
      const rows = (res?.[src] || []).map((h) => {
        const raw = h.s ?? h.state;
        const v = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
        return { t: Math.max(start, (h.lu ?? h.last_updated ?? 0) * 1000), v: Number.isFinite(v) ? v : null };
      }).filter((p) => p.t);
      this._reads.set(key, { at: Date.now(), start, end, rows, src });
      this._arrived(r.id);
    })();
    return have || { loading: true };
  }
  _readingCard(r, kind) {
    const d = this._reading(r, kind);
    const H = 150;
    if (d.loading) return `<div class="group rcard"><div class="loading sm" style="height:${H + 62}px;display:grid;place-items:center">Loading…</div></div>`;
    const rows = d.rows.slice();
    const pts = rows.filter((p) => p.v !== null);
    if (!pts.length) return `<div class="group rcard"><div class="loading sm">${d.src ? "No readings in this window." : "No sensor gives this reading."}</div></div>`;
    const W = Math.round(Math.max(260, (this._el.sbody.clientWidth || 390) - 36 - 32)), P = { l: 34, r: 8, t: 10, b: 22 };
    const s0 = d.start, s1 = d.end;
    if (rows[0].t > s0 && rows[0].v !== null) rows[0] = { ...rows[0], t: s0 };
    const runs = [];
    let run = null;
    rows.forEach((p, i) => {
      const until = i + 1 < rows.length ? rows[i + 1].t : s1;
      if (p.v === null) { run = null; return; }
      if (!run) runs.push(run = []);
      run.push({ ...p, until });
    });
    const vs = pts.map((p) => p.v);
    let lo, hi;
    if (kind === "battery") { lo = 0; hi = 100; }
    else { lo = Math.min(...vs); hi = Math.max(...vs); if (lo === hi) { lo -= 5; hi += 5; } const pad = (hi - lo) * 0.15; lo -= pad; hi += pad; }
    const x = (t) => P.l + ((t - s0) / (s1 - s0)) * (W - P.l - P.r);
    const y = (v) => H - P.b - ((v - lo) / (hi - lo)) * (H - P.t - P.b);
    const X = (t) => x(t).toFixed(1), Y = (v) => y(v).toFixed(1);
    const ticks = kind === "battery" ? [0, 50, 100] : [lo + (hi - lo) * 0.12, (lo + hi) / 2, hi - (hi - lo) * 0.12];
    const grid = ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.07)"/>
      <text x="${P.l - 7}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`).join("");
    const lab = (t) => (s1 - s0 > 2 * DAY_MS ? new Date(t).toLocaleDateString(LOCALE.lang, { weekday: "short" }) : phHour(t));
    const xl = `<text x="${P.l}" y="${H - 5}">${escapeHtml(lab(s0))}</text><text x="${X((s0 + s1) / 2)}" y="${H - 5}" text-anchor="middle">${escapeHtml(lab((s0 + s1) / 2))}</text>
      <text x="${W - P.r}" y="${H - 5}" text-anchor="end">Now</text>`;
    let line = "", area = "";
    for (const rn of runs) {
      let dd = `M${X(rn[0].t)},${Y(rn[0].v)}`;
      rn.forEach((p, i) => { if (i) dd += `L${X(p.t)},${Y(rn[i - 1].v)}L${X(p.t)},${Y(p.v)}`; });
      dd += `L${X(rn[rn.length - 1].until)},${Y(rn[rn.length - 1].v)}`;
      line += dd;
      area += `${dd}L${X(rn[rn.length - 1].until)},${H - P.b}L${X(rn[0].t)},${H - P.b}Z`;
    }
    // the tablet's reading colours: battery orange, signal yellow
    const c = kind === "battery" ? COL.battery : COL.signal;
    const last = rows[rows.length - 1].v === null ? null : rows[rows.length - 1];
    const unit = kind === "battery" ? "%" : ` ${r.unit || "dBm"}`;
    const lastRun = runs[runs.length - 1];
    return `<div class="group rcard"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="rsvg">${grid}${xl}
        <path d="${area}" fill="${c}" opacity=".14"/><path d="${line}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/>
        ${last ? `<circle cx="${X(lastRun[lastRun.length - 1].until)}" cy="${Y(last.v)}" r="4" fill="${c}"/>` : ""}</svg>
      <div class="stats"><span><small>Now</small><b>${last ? `${last.v}${unit}` : "—"}</b></span><span><small>Lowest</small><b>${Math.min(...vs)}${unit}</b></span>
        <span><small>Highest</small><b>${Math.max(...vs)}${unit}</b></span></div></div>`;
  }

  /* ---------------------------------------------------------------- sheet motion */

  // raised all the way, the sheet takes the whole screen - up to the status bar on an iPhone
  _sheetH() { return Math.round(window.innerHeight - this._safeTop()); }
  _safeTop() {
    if (this._safeT == null) {
      const p = document.createElement("div");
      p.style.cssText = "position:fixed;top:0;height:0;padding-top:env(safe-area-inset-top);visibility:hidden;pointer-events:none";
      this.shadowRoot.appendChild(p);
      this._safeT = p.offsetHeight;
      p.remove();
    }
    return this._safeT;
  }
  _y(detent) {
    const h = this._sheetH();
    if (detent === "large") return 0;
    if (detent === "closed") return h + 20;
    return Math.round(h - this._fitH());
  }
  // how tall the sheet opens: its grabber and the page - at most 88% of the screen
  _fitH() {
    const b = this._el.sbody;
    const last = b.lastElementChild;
    const grab = this._el.sheet.querySelector(".grabzone")?.offsetHeight || 17;
    const content = last ? last.offsetTop + last.offsetHeight + 26 : b.scrollHeight;
    return Math.min(window.innerHeight * 0.88, Math.max(160, grab + content));
  }
  _curY() { return new DOMMatrixReadOnly(getComputedStyle(this._el.sheet).transform).m42; }
  _setSheet(y, animate, from) {
    const s = this._el.sheet;
    s.style.height = `${this._sheetH()}px`;
    s.getAnimations().forEach((a) => a.cancel());
    if (from && !reduceMotion()) s.animate([{ transform: `translateY(${this._y("closed")}px)` }, { transform: `translateY(${y}px)` }], { duration: 520, easing: IOS });
    else if (animate && !reduceMotion()) s.animate([{ transform: `translateY(${this._lastY ?? y}px)` }, { transform: `translateY(${y}px)` }], { duration: 440, easing: IOS });
    s.style.transform = `translateY(${y}px)`;
    this._lastY = y;
    const large = y === 0;
    this._el.sbody.style.overflowY = large ? "auto" : "hidden";
    this._el.sbody.style.touchAction = large ? "pan-y" : "none";
  }
  _toDetent(d) { this._detent = d; this._setSheet(this._y(d), true); }
  _closeSheet() {
    const { sheet, scrim } = this._el;
    if (sheet.hidden) return;
    this._sheetOpen = false;
    this._closeMenu();
    if (reduceMotion()) { sheet.hidden = true; scrim.hidden = true; return; }
    const cur = this._lastY ?? this._curY();
    sheet.getAnimations().forEach((a) => a.cancel());
    sheet.animate([{ transform: `translateY(${cur}px)` }, { transform: `translateY(${this._y("closed")}px)` }], { duration: 340, easing: IOS })
      .finished.then(() => { if (!this._sheetOpen) sheet.hidden = true; });
    sheet.style.transform = `translateY(${this._y("closed")}px)`;
    this._lastY = null;
    scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "linear" }).finished.then(() => { if (!this._sheetOpen) scrim.hidden = true; });
  }
  _bindSheetDrag() {
    const s = this._el.sheet, body = this._el.sbody;
    let drag = false, y0 = 0, start = 0, last = 0, lastT = 0, v = 0, y = 0, scrolled = 0;
    s.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input, a")) return;
      const head = e.target.closest(".grabzone, .shead, .sbar2");
      // at the full height its content scrolls by itself; the top part still moves it
      if (!head && this._detent === "large") return;
      drag = true; y0 = e.clientY; last = e.clientY; lastT = performance.now(); v = 0; scrolled = 0;
      start = this._lastY ?? this._curY(); y = start;
      s.getAnimations().forEach((a) => a.cancel());
      s.style.transform = `translateY(${start}px)`;
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const now = performance.now();
      v = (e.clientY - last) / Math.max(1, now - lastT); last = e.clientY; lastT = now;
      y = start + (e.clientY - y0);
      // raised all the way: the rest of the drag scrolls its content on
      if (y < 0) { body.style.overflowY = "auto"; scrolled = -y; body.scrollTop = scrolled; y = 0; }
      s.style.transform = `translateY(${y}px)`;
      this._lastY = y;
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      const from = this._detent, moved = y - start;
      if (scrolled > 0 || (from === "medium" && (moved < -24 || v < -0.25))) { this._toDetent("large"); return; }
      if (from === "medium" && (moved > 110 || v > 0.6)) { this._closeSheet(); return; }
      if (from === "large" && (moved > this._y("medium") * 0.5 || v > 0.6)) {
        if (moved > this._y("medium") + 80 || v > 1.4) this._closeSheet(); else this._toDetent("medium");
        return;
      }
      this._toDetent(from);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    s.addEventListener("wheel", (e) => { if (this._detent === "medium" && e.deltaY > 2) { e.preventDefault(); this._toDetent("large"); } }, { passive: false });
  }

  /* ---------------------------------------------------------------- swipe to ignore */

  _bindSwipe() {
    let row = null, x0 = 0, y0 = 0, dx = 0, base = 0, lock = null, w = 0;
    const root = this.shadowRoot;
    root.addEventListener("pointerdown", (e) => {
      const r = e.target.closest(".swipe .row");
      if (!r) return;
      row = r; x0 = e.clientX; y0 = e.clientY; dx = 0; lock = null;
      w = r.parentElement.querySelector(".acts")?.offsetWidth || 0;
      base = r.classList.contains("open") ? -w : 0;
      if (!r.classList.contains("open")) this._closeSwipes();
    });
    root.addEventListener("pointermove", (e) => {
      if (!row) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!lock) { if (Math.abs(mx) < 8 && Math.abs(my) < 8) return; lock = Math.abs(mx) > Math.abs(my) ? "x" : "y"; }
      if (lock !== "x") return;
      dx = mx;
      let x = Math.min(0, base + dx);
      if (x < -w) x = -w + (x + w) / 3;
      row.style.transition = "none";
      row.style.transform = `translateX(${x}px)`;
    });
    const end = () => {
      if (!row) return;
      const r = row; row = null;
      if (lock !== "x") return;
      this._swiped = Date.now();
      const x = base + dx, open = x < -w / 2;
      r.style.transition = `transform .38s ${IOS}`;
      r.style.transform = open ? `translateX(${-w}px)` : "none";
      r.classList.toggle("open", open);
      // a full swipe asks at once
      if (x < -r.offsetWidth * 0.6) { const a = r.parentElement.querySelector(".swact"); if (a) setTimeout(() => this._act("ignore", a.dataset.id), 120); }
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", () => { if (row && lock !== "x") row = null; else end(); });
  }
  _closeSwipes() {
    for (const r of this.shadowRoot.querySelectorAll(".row.open")) { r.style.transition = `transform .34s ${IOS}`; r.style.transform = "none"; r.classList.remove("open"); }
  }

  /* ---------------------------------------------------------------- actions */

  _act(act, id) {
    const r = this._byId.get(id);
    if (!r) return;
    if (act === "ignore") { this._closeSwipes(); this._openIgnore(r); return; }
    // the device's page, where it can be changed; an entity without one: its settings
    if (act === "moreinfo") { if (r.deviceId) this._navigate(`/config/devices/device/${r.deviceId}`); else this._moreInfo(r.id); }
  }
  _moreInfo(eid) { this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: eid }, bubbles: true, composed: true })); }
  _navigate(path) {
    this._closeSheet();
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }
  /* Ignore: the card's choices as an iOS action sheet - Stop Ignoring while ignored, a day, a
     week, until stopped - Cancel apart below. */
  _openIgnore(r) {
    this._menuId = r.id;
    const now = Date.now(), m = this._el.menu;
    const opt = (key, label, until) => `<button class="arow" data-ign="${key}"><span>${label}</span>${until ? `<span class="aval">until ${escapeHtml(fmtDT(until))}</span>` : ""}</button>`;
    m.innerHTML = `<div class="asheet">
        <div class="ah">${r.ignored ? `Ignored ${r.ignoredUntil ? `until ${escapeHtml(fmtDT(r.ignoredUntil))}` : "until you stop it"}` : `Ignore this ${isDevice(r) ? "device" : "helper"}`}
          <div class="ahs">${escapeHtml(r.name)}</div>${r.ignored ? "" : `<div class="ahs2">While ignored it raises no alerts and shows no problems.</div>`}</div>
        ${r.ignored ? `<button class="arow end" data-ign="stop"><span>Stop Ignoring</span></button>` : ""}
        ${opt("1440", "For 1 Day", now + DAY_MS)}${opt("10080", "For 1 Week", now + 7 * DAY_MS)}
        ${r.ignored && !r.ignoredUntil ? "" : opt("forever", "Until I Stop It")}
      </div><button class="acancel" data-igncancel>Cancel</button>`;
    m.hidden = false;
    this._el.scrim.hidden = false;
    if (!reduceMotion()) m.animate([{ transform: "translateY(110%)" }, { transform: "none" }], { duration: 460, easing: IOS });
  }
  _closeMenu() {
    const m = this._el.menu;
    if (m.hidden) return;
    const done = () => { m.hidden = true; if (!this._sheetOpen) this._el.scrim.hidden = true; };
    if (reduceMotion()) { done(); return; }
    m.animate([{ transform: "none" }, { transform: "translateY(110%)" }], { duration: 300, easing: IOS }).finished.then(done);
  }
  // every entity of the row suppressed (or let go) at once, as the card's Ignore does
  async _ignore(choice) {
    const r = this._byId.get(this._menuId);
    this._closeMenu();
    if (!r) return;
    const call = (svc, data = {}) => this._hass.callService("entity_availability", svc, { entity_id: r.members, ...data });
    try {
      if (choice === "stop") await call("unsuppress");
      else if (choice === "forever") await call("suppress_indefinitely");
      else await call("suppress", { duration: Number(choice) });
    } catch (err) { this._toast(`Could not change the ignore: ${err?.message || err}`); return; }
    this._card._ignoreCache = null;
    this._det.clear();
    this._toast(choice === "stop" ? `${r.name}: no longer ignored`
      : `${r.name} ignored ${choice === "forever" ? "until you stop it" : `until ${fmtDT(Date.now() + Number(choice) * 60e3)}`}`);
  }
  _toast(text) {
    const t = this._el.toast;
    t.textContent = text;
    t.hidden = false;
    t.getAnimations().forEach((a) => a.cancel());
    t.animate([{ opacity: 0, transform: "translate(-50%,-12px) scale(.96)" }, { opacity: 1, transform: "translate(-50%,0)" },
      { opacity: 1, transform: "translate(-50%,0)", offset: 0.85 }, { opacity: 0, transform: "translate(-50%,-6px)" }],
      { duration: 2600, easing: PH_EASE }).finished.then(() => { t.hidden = true; }, () => {});
  }
}

/* The Alerts card's phone stylesheet, with the Health page's own parts. */
const PHONE_STYLES = `
/* never wider than the screen, whatever slides sideways in it (tabs, the chart, sheet pages);
   clip, not hidden - sticky parts keep working */
:host{display:block;overflow-x:clip;--bg:var(--ha-card-background,rgb(32,27,37));--cell:rgb(46,42,52);
  --sep:rgba(255,255,255,.09);--l1:#fff;--l2:rgba(235,235,245,.62);--l3:rgba(235,235,245,.32);
  --fill:rgba(118,118,128,.24);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;color:var(--l1);-webkit-tap-highlight-color:transparent}
*{box-sizing:border-box}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left;-webkit-tap-highlight-color:transparent}
svg{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
[hidden]{display:none!important}
.app{padding:0 16px calc(40px + env(safe-area-inset-bottom))}
.glass{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
  background:rgba(255,255,255,.1);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
  box-shadow:inset 0 0 0 .5px rgba(255,255,255,.22),0 4px 14px rgba(0,0,0,.25);transition:transform .2s ${PH_EASE}}
.glass:active{transform:scale(.9)}

/* segmented control: a track, a white thumb that slides */
.seg{position:relative;display:flex;background:var(--fill);border-radius:10px;padding:2px;isolation:isolate}
.seg button{position:relative;z-index:1;flex:1;min-height:30px;padding:0 14px;font-size:13px;font-weight:600;
  text-align:center;border-radius:8px;color:var(--l1);transition:color .25s}
.seg button.on{color:#1c1c1e}
.seg .thumb{position:absolute;z-index:0;top:2px;bottom:2px;left:2px;border-radius:8px;background:#fff;
  box-shadow:0 3px 8px rgba(0,0,0,.18),0 1px 1px rgba(0,0,0,.12)}
.tseg{margin:12px 0 16px;border-radius:22px;padding:3px}
.tseg button{min-height:38px;font-size:16px;border-radius:19px}
.tseg.four button{padding:0 4px;font-size:15px}
.tseg .thumb{top:3px;bottom:3px;left:3px;border-radius:19px}

.hero{padding:6px 2px 10px}
.hero h1{margin:0;font-size:34px;line-height:41px;font-weight:700;letter-spacing:.37px}
.sub{font-size:15px;color:var(--l2);margin-top:2px}
.search{display:flex;align-items:center;gap:6px;height:38px;padding:0 9px;border-radius:12px;background:var(--fill);color:var(--l2)}
.search svg{width:18px;height:18px;flex:0 0 auto}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--l1);font:inherit;font-size:17px}
.search input::placeholder{color:var(--l2)}
.search input::-webkit-search-cancel-button{filter:invert(1);opacity:.5}

/* a link's filters and the chart pick: chips that let go */
.lfx:empty{display:none}
.lfx{margin:-6px 0 4px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:30px;padding:0 8px 0 12px;border-radius:15px;background:#fff;color:#1c1c1e;font-size:13px;font-weight:600}
.clab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.chip svg{width:14px;height:14px;stroke-width:2.6;flex:0 0 auto}
.pinchip{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;margin:10px 0 2px;padding:0 8px 0 16px;border-radius:24px;
  font-size:16px;font-weight:600;color:var(--l1);background:color-mix(in srgb,var(--c) 18%,var(--bg));
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 50%,transparent)}
.pinchip .clab{flex:1}
.pinchip .pn{font-size:15px;font-weight:500;color:var(--l2);white-space:nowrap}
.pinchip .pic{width:18px;height:18px;flex:0 0 auto;color:var(--c);stroke-width:2.4}
.pinchip .px{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.12);flex:0 0 auto}
.pinchip .px svg{width:16px;height:16px;stroke-width:2.8}
.pinned{margin-top:12px}
.cdot{width:10px;height:10px;border-radius:50%;background:var(--c);flex:0 0 auto}
.pmenu{position:fixed;z-index:60;overflow-y:auto;border-radius:14px;padding:4px 0;
  background:rgba(58,52,64,.86);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);
  box-shadow:0 12px 40px rgba(0,0,0,.45),inset 0 0 0 .5px rgba(255,255,255,.14)}
.mgh{font-size:13px;color:var(--l2);padding:10px 16px 4px}
.mrow{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0 14px 0 10px;font-size:17px}
.mrow:active{background:rgba(255,255,255,.1)}
.mck{width:20px;display:grid;place-items:center}
.mck svg{width:16px;height:16px;stroke-width:3}
.mdot{width:9px;height:9px;border-radius:50%;background:var(--c);flex:0 0 auto}
.mlab{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* the chart */
.card{background:var(--cell);border-radius:22px;padding:16px}
.chart{position:relative;margin-bottom:6px}
.chd{display:flex;align-items:center;justify-content:space-between;gap:10px}
.abig{font-size:34px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.asub{font-size:15px;color:var(--l2);margin-top:4px}
.rseg{border-radius:20px;padding:3px;flex:0 0 auto}
.rseg button{min-height:36px;min-width:58px;padding:0 14px;font-size:15px;border-radius:17px}
.rseg .thumb{top:3px;bottom:3px;left:3px;border-radius:17px}
.plot{display:grid;grid-template-columns:auto 1fr;column-gap:8px;margin-top:20px}
.yax{position:relative;height:110px;font-size:12px;color:var(--l2);font-variant-numeric:tabular-nums;text-align:right}
.yax i{visibility:hidden;font-style:normal}
.yax span{position:absolute;right:0;transform:translateY(50%);line-height:1}
.bars{position:relative;display:grid;grid-template-columns:repeat(var(--n),1fr);height:110px;touch-action:pan-y;cursor:pointer;
  background:linear-gradient(to top,rgba(255,255,255,.08) 1px,transparent 1px)}
.gl{position:absolute;left:0;right:0;height:1px;background:rgba(255,255,255,.06);pointer-events:none}
.slot{display:flex;align-items:flex-end;justify-content:center;gap:2px;height:100%;border-radius:6px;transition:background .2s}
.slot.sel{background:rgba(255,255,255,.08)}
.slot i{display:block;width:min(18px,44%);background:var(--c);border-radius:3px 3px 1px 1px;transform-origin:bottom;
  animation:grow .5s ${PH_EASE} both;animation-delay:var(--d)}
.bars.k3 .slot i{width:min(10px,28%)}
.slot i.zero{height:3px;background:#fff;border-radius:1.5px}
@keyframes grow{from{transform:scaleY(0)}}
.axis{position:relative;height:18px;margin-top:6px;font-size:12px;color:var(--l2)}
.axis span{position:absolute;top:0;white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:13px;color:var(--l2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.callout{position:absolute;top:10px;left:0;z-index:5;min-width:170px;max-width:240px;padding:10px 12px;border-radius:14px;pointer-events:none;
  background:rgba(58,52,64,.94);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 0 0 .5px rgba(255,255,255,.14);transition:transform .18s ${PH_EASE}}
.cwhen{font-size:15px;font-weight:600;margin-bottom:4px}
.csec{margin-top:6px}
.chd2{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;color:var(--c)}
.chd2 i{width:8px;height:8px;border-radius:2px;background:var(--c)}
.chd2 b{margin-left:auto}
.cname{font-size:15px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:14px}
.cmore,.cnone{font-size:15px;color:var(--l2);padding-left:14px}
.cnone{padding-left:0}

/* the category cards */
.cats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
.cat{display:flex;flex-direction:column;min-height:124px;padding:12px 14px 14px;border-radius:18px;background:var(--cell);transition:transform .2s ${PH_EASE}}
.cat:active{transform:scale(.97)}
.ctop{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.cname{flex:1;font-size:15px;font-weight:600}
.ctop > svg,.cat.wide > svg{width:14px;height:14px;stroke-width:2.6;color:var(--l3)}
.cnum{font-size:30px;font-weight:700;line-height:1.05;font-variant-numeric:tabular-nums}
.cnum small{font-size:17px;font-weight:600;color:var(--l2)}
.clab2{font-size:15px;font-weight:600;margin-top:2px}
.csub{font-size:13px;color:var(--l2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cat.full{grid-column:1/-1}
.cat.wide{grid-column:1/-1;flex-direction:row;align-items:center;gap:10px;min-height:52px;padding:0 14px}
.cat.wide .nval{color:var(--l2);font-size:17px}
.tpane.untabbed{margin-top:4px}

/* inset grouped list - one line per row */
.sh{display:flex;align-items:baseline;gap:8px;font-size:20px;font-weight:700;letter-spacing:.38px;margin:22px 4px 8px;color:var(--l1)}
.shn{font-size:15px;font-weight:600;color:var(--l2);letter-spacing:0}
.group{background:var(--cell);border-radius:16px;overflow:hidden}
.swipe{position:relative;overflow:hidden}
.swipe + .swipe .row::before{content:"";position:absolute;left:60px;right:0;top:0;border-top:.5px solid var(--sep)}
.acts{position:absolute;inset:0 0 0 auto;display:flex}
.swact{min-width:96px;display:grid;place-items:center;font-size:15px;font-weight:600;background:${COL.ignored};color:#fff;text-align:center}
.row{position:relative;display:flex;align-items:center;gap:12px;width:100%;min-height:60px;padding:10px 12px 10px 14px;background:var(--cell);touch-action:pan-y}
.row:active{background-image:linear-gradient(rgba(255,255,255,.08),rgba(255,255,255,.08))}
.tile{flex:0 0 auto;width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--c);color:#fff}
.tile ha-icon{--mdc-icon-size:19px}
.tile.sm{width:26px;height:26px;border-radius:7px}.tile.sm ha-icon{--mdc-icon-size:16px}
.tile.lg{width:48px;height:48px;border-radius:12px}.tile.lg ha-icon{--mdc-icon-size:28px}
.t1{font-size:17px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row > .t1{flex:1;min-width:0}
.t2{font-size:15px;color:var(--l2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:6px;color:var(--l3);font-size:15px}
.meta > svg{width:14px;height:14px;stroke-width:2.6;flex:0 0 auto}
.stt{font-size:15px;font-weight:600;color:var(--c);white-space:nowrap}
.val{font-size:15px;color:var(--l2);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px}
.foot{font-size:13px;color:var(--l2);text-align:center;margin:14px 20px}
.loading{color:var(--l2);text-align:center;padding:40px 0;font-size:15px}
.loading.sm{padding:18px 0}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:48px 24px 40px}
.eic{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent);margin-bottom:16px}
.eic svg{width:32px;height:32px;stroke-width:2.6}
.et{font-size:22px;font-weight:700;letter-spacing:.35px}
.eb{font-size:15px;color:var(--l2);margin-top:6px;line-height:20px;max-width:280px}

/* timeline */
.tline{position:relative;padding:4px 0 4px}
.tline::before{content:"";position:absolute;left:79px;top:14px;bottom:14px;width:2px;background:rgba(255,255,255,.1);border-radius:1px}
.tev{position:relative;display:flex;align-items:flex-start;gap:12px;width:100%;padding:9px 0;text-align:left}
.tt{flex:0 0 64px;text-align:right;font-size:14px;color:var(--l2);font-variant-numeric:tabular-nums;padding-top:3px}
.tt small{font-size:11px;color:var(--l3)}
.tdot{flex:0 0 auto;width:12px;height:12px;border-radius:50%;background:var(--c);margin-top:6px;box-shadow:0 0 0 4px #2a2430;position:relative;z-index:1}
.tbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.tbody .t2{line-height:20px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
/* a failure's trace, under its error */
.ttrace{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;min-height:36px;font-size:15px;color:var(--l1)}
.ttrace svg{width:12px;height:12px;stroke-width:2.6;color:var(--l3)}

/* ---- the sheet, the action sheet, the toast ---- */
.scrim{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.45)}
.scrim.clear{background:transparent}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:50;background:#2a2430;border-radius:28px 28px 0 0;
  box-shadow:0 -10px 40px rgba(0,0,0,.4);display:flex;flex-direction:column;max-width:600px;margin:0 auto}
.grabzone{padding:8px 0 4px;touch-action:none;cursor:grab}
.grab{width:38px;height:5px;border-radius:3px;background:rgba(255,255,255,.3);margin:0 auto}
.sbody{position:relative;flex:1;overflow:hidden;padding:4px 18px calc(30px + env(safe-area-inset-bottom));overscroll-behavior:contain}
.shead{display:flex;align-items:center;gap:12px;touch-action:none}
.shtxt{flex:1;min-width:0}
.sht1{font-size:22px;font-weight:700;letter-spacing:.35px;line-height:27px}
.sht2{font-size:15px;color:var(--l2)}
.sclose,.sback{width:44px;height:44px;flex:0 0 auto;background:rgba(255,255,255,.12)}
.sclose svg{width:20px;height:20px;stroke-width:2.6}
.sback svg{width:22px;height:22px;stroke-width:2.6}
.sbar2{display:flex;align-items:center;justify-content:space-between;margin-top:-4px;touch-action:none}
.sbar2 + .shead{padding-top:16px}
.sstat{display:inline-flex;align-items:center;gap:7px;margin:16px 0 0;padding:6px 12px;border-radius:14px;font-size:15px;font-weight:600;
  color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent)}
.sdot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto}
.sacts{display:flex;gap:10px;margin:18px 0 6px}
.big{flex:1;min-height:50px;border-radius:25px;background:rgba(255,255,255,.12);font-size:17px;font-weight:600;text-align:center;transition:transform .15s ${PH_EASE}}
.big.light{background:#fff;color:#1c1c1e}
.big:active{transform:scale(.96)}
.navs{margin-top:16px}
.nrow{position:relative;display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:0 14px;font-size:17px}
.nrow + .nrow::before{content:"";position:absolute;left:52px;right:0;top:0;border-top:.5px solid var(--sep)}
.navs0 .nrow + .nrow::before{left:14px}
.nrow:active{background:rgba(255,255,255,.08)}
.nlab{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nval{color:var(--l2);font-size:17px;white-space:nowrap}
.nval.tv{font-weight:600}
.nrow > svg{width:14px;height:14px;stroke-width:2.6;color:var(--l3);flex:0 0 auto}
.evt{color:var(--l2);font-weight:400}
.ph1{font-size:22px;font-weight:700;letter-spacing:.35px;margin:16px 2px 2px}
.ph2{font-size:15px;color:var(--l2);margin:0 2px 10px}
.hseg{margin:6px 0 2px}
.sh2{font-size:20px;font-weight:700;letter-spacing:.38px;margin:24px 2px 8px}
.runcard{padding:14px 16px}
.runline{display:flex;align-items:center;gap:7px;font-size:17px;color:var(--l1)}
.runline .sdot{width:10px;height:10px}
.runerr{margin-top:10px;font-size:15px;line-height:20px;color:var(--l2);white-space:pre-wrap;overflow-wrap:anywhere}
.runbtn{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:44px;margin:10px 0 -6px;padding-top:6px;
  border-top:.5px solid var(--sep);font-size:17px}
.runbtn svg{width:14px;height:14px;stroke-width:2.6;color:var(--l3)}
.bandcard{padding:14px 16px}
.trk + .trk{margin-top:10px}
.tlab{font-size:13px;color:var(--l2);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tbar{position:relative;height:10px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden}
.tbar i{position:absolute;top:0;bottom:0;background:var(--c)}
.baxis{display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--l2)}
.rcard{padding:12px 14px 14px}
.rsvg text{font-size:11px;fill:var(--l2);stroke:none;font-family:inherit}
.stats{display:grid;grid-template-columns:repeat(3,1fr);margin-top:10px;border-top:.5px solid var(--sep);padding-top:10px}
.stats span{display:flex;flex-direction:column;align-items:center;gap:2px}
.stats small{font-size:13px;color:var(--l2)}
.stats b{font-size:17px;font-variant-numeric:tabular-nums}
.menu{position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:60;max-width:584px;margin:0 auto;display:flex;flex-direction:column;gap:8px}
.asheet,.acancel{border-radius:16px;background:rgba(58,52,64,.92);-webkit-backdrop-filter:blur(24px) saturate(180%);
  backdrop-filter:blur(24px) saturate(180%);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.14)}
.asheet{overflow:hidden}
.ah{font-size:13px;font-weight:600;color:var(--l2);text-align:center;padding:14px 16px 12px}
.ahs{font-weight:400;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ahs2{font-weight:400;margin-top:6px}
.arow{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:0 18px;font-size:19px;border-top:.5px solid var(--sep)}
.arow:active{background:rgba(255,255,255,.1)}
.arow > span:first-child{flex:1}
.aval{font-size:15px;color:var(--l2)}
.arow.end > span:first-child{color:${COL.ok}}
.acancel{min-height:56px;font-size:19px;font-weight:600;text-align:center}
.toast{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;z-index:70;transform:translateX(-50%);
  max-width:calc(100vw - 32px);padding:10px 18px;border-radius:22px;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  background:rgba(58,52,64,.92);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
  box-shadow:0 8px 30px rgba(0,0,0,.4),inset 0 0 0 .5px rgba(255,255,255,.14)}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
`;

customElements.define("health-phone-view", HealthPhoneView);

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
