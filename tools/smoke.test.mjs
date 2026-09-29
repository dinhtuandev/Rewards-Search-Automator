import assert from "node:assert/strict";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// chrome.* mock. Emulation is exercised for real, because the mobile path is
// exactly what keeps regressing.
// ---------------------------------------------------------------------------
const calls = [];
const messages = [];
let attached = false;
let failMethod = null;
let runtimeView = { ua: "desktop-ua", dpr: 1, touch: false, w: 1920 };
let timers = [];

const listeners = { message: [], startup: [], installed: [], alarm: [], tabRemoved: [], tabUpdated: [] };

function mkEl() {
  return {
    innerText: "", style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => mkEl(),
  };
}
globalThis.document = { querySelector: () => mkEl(), createElement: () => mkEl() };

const store = {};

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    onStartup: { addListener: (f) => listeners.startup.push(f) },
    onInstalled: { addListener: (f) => listeners.installed.push(f) },
    onMessage: { addListener: (f) => listeners.message.push(f) },
    onConnect: { addListener() {} },
    onSuspend: { addListener() {} },
    sendMessage: (m) => { messages.push(m); return Promise.resolve(); },
  },
  storage: {
    local: {
      get: async (k) => (k in store ? { [k]: store[k] } : {}),
      set: async (o) => Object.assign(store, o),
      remove: async (k) => {
        // chrome.storage.local.remove accepts a string or an array of keys
        for (const key of Array.isArray(k) ? k : [k]) delete store[key];
      },
    },
  },
  alarms: {
    onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    create: (n, o) => calls.push({ m: "alarms.create", p: o }),
    clear: (n) => calls.push({ m: "alarms.clear", p: n }),
  },
  tabs: {
    query: async () => [{ id: 7, url: "https://bing.com/search?q=x&cvid=SESSION42" }],
    get: async () => ({ id: 7, url: "https://bing.com/search?q=y&cvid=SESSION42" }),
    update: async (id, o) => calls.push({ m: "tabs.update", p: o }),
    onRemoved: { addListener: (f) => listeners.tabRemoved.push(f) },
    onUpdated: { addListener: (f) => listeners.tabUpdated.push(f) },
  },
  debugger: {
    attach: (t, v, cb) => {
      calls.push({ m: "debugger.attach" });
      if (failMethod === "attach") { failMethod = null; chrome.runtime.lastError = { message: "cannot attach" }; cb(); return; }
      if (attached) { chrome.runtime.lastError = { message: "Another debugger is already attached" }; cb(); return; }
      chrome.runtime.lastError = undefined; attached = true; cb();
    },
    detach: (t, cb) => { calls.push({ m: "debugger.detach" }); chrome.runtime.lastError = undefined; attached = false; cb(); },
    sendCommand: (t, method, params, cb) => {
      calls.push({ m: method, p: params });
      if (failMethod === method) {
        failMethod = null;
        chrome.runtime.lastError = { message: `${method} refused` };
        cb();
        return;
      }
      chrome.runtime.lastError = undefined;
      cb(method === "Runtime.evaluate" ? { result: { value: JSON.stringify(runtimeView) } } : {});
    },
  },
};

globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, done: false }); return timers.length; };
globalThis.clearTimeout = () => {};
// background.js keeps the MV3 worker alive with a setInterval during a run;
// capture it so it does not keep the test process alive either.
const intervals = [];
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = (id) => { if (id) intervals[id - 1] = null; };
// background.js reads navigator.userAgent to keep the spoofed UA client hints in
// step with the real browser. Node's own UA is not Chrome, so pin it.
Object.defineProperty(globalThis.navigator, "userAgent", {
  value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  configurable: true,
});

await import("../js/background.js");

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}

function send(msg) {
  return new Promise((resolve) => {
    for (const l of listeners.message) {
      const r = l(msg, {}, resolve);
      if (r === true) return;
    }
    resolve(undefined);
  });
}

// background.js starts the first search with `void runSearch()`; let that chain
// settle before asserting.
const flush = () => new Promise((r) => setImmediate(r));

// Lets queued microtasks/promises (history writes, stats updates, completion)
// run to completion before asserting.
async function settle(n = 6) {
  for (let i = 0; i < n; i++) await flush();
}

// Fire the scheduled timers one at a time, the way real time would, until the
// expected number of searches has happened. Missing a timer is not a reason to
// stop: the first one is only registered after the initial navigation resolves.
async function drain(searches) {
  for (let i = 0; i < 400; i++) {
    await flush();
    const done = calls.filter((c) => c.m === "tabs.update").length;
    if (done >= searches) return true;
    const tmr = timers.find((t) => !t.done);
    if (tmr) {
      tmr.done = true;
      tmr.fn();
    }
  }
  return false;
}

const MOBILE_VIEW = {
  ua: "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  dpr: 3, touch: true, w: 360,
};
const DESKTOP_VIEW = {
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  dpr: 1, touch: false, w: 1920,
};

const settings = { desktopSearches: 45, mobileSearches: 15, millisecondsMin: 8000, millisecondsMax: 15000 };
const has = (m) => calls.some((c) => c.m === m);
const last = (m) => [...calls].reverse().find((c) => c.m === m);

// Unwinds any in-flight run first: timers and counters from a previous case
// must not bleed into the next one.
async function reset({ attached: att = false, view = MOBILE_VIEW, keepStats = false } = {}) {
  for (let i = 0; i < 20; i++) {
    const tmr = timers.find((x) => !x.done);
    if (!tmr) break;
    tmr.done = true;
    tmr.fn();
    await flush();
  }
  await send({ type: "stopSearches" }).catch(() => {});
  await settle(20);
  delete store.searchState;
  if (!keepStats) {
    delete store.rsaHistory;
  delete store.rsaRuns;
    delete store.rsaStats;
  }
  // A tail from the previous run can still land after the delete above.
  await settle(20);
  if (!keepStats) {
    delete store.rsaHistory;
  delete store.rsaRuns;
    delete store.rsaStats;
  }
  calls.length = 0;
  timers = [];
  messages.length = 0;
  attached = att;
  runtimeView = view;
  failMethod = null;
}

async function start(type, s = settings, opts) {
  await reset(opts);
  const r = await send({ type: "startSearches", searchType: type, settings: s });
  await flush();
  return r;
}

console.log("\n--- mobile emulation ---");

await t("mobile run attaches the debugger and applies mobile metrics", async () => {
  const r = await start("mobile");
  assert.equal(r.success, true, r.error);
  assert.ok(has("debugger.attach"), "never attached");
  assert.ok(has("Network.setUserAgentOverride"), "no UA override");
  assert.ok(has("Emulation.setDeviceMetricsOverride"), "no device metrics");
  assert.ok(has("Emulation.setTouchEmulationEnabled"), "no touch emulation");

  const metrics = last("Emulation.setDeviceMetricsOverride").p;
  assert.equal(metrics.mobile, true, "mobile flag not set");
  assert.equal(metrics.width, 360);
  assert.equal(metrics.deviceScaleFactor, 3);
  assert.equal(last("Emulation.setTouchEmulationEnabled").p.enabled, true);
  assert.equal(last("Emulation.setEmitTouchEventsForMouse").p.enabled, true);
});

await t("UA metadata advertises the real browser version", async () => {
  await start("mobile");
  const meta = last("Network.setUserAgentOverride").p.userAgentMetadata;
  const chromeVersions = meta.fullVersionList
    .filter((b) => !b.brand.startsWith("Not"))
    .map((b) => b.version);
  assert.ok(chromeVersions.length && chromeVersions.every((v) => v.startsWith("140")),
    "UA client hints still advertise a stale Chrome: " + JSON.stringify(meta.fullVersionList));
  assert.equal(meta.mobile, true);
  assert.equal(meta.platform, "Android");
  assert.equal(meta.model, "SM-S908B");
});

await t("run reports a successful self-check", async () => {
  await start("mobile");
  const diag = messages.filter((m) => m.type === "diagnostics").pop();
  assert.ok(diag, "no diagnostics emitted");
  assert.equal(diag.diagnostics.ok, true, JSON.stringify(diag.diagnostics));
  assert.equal(diag.diagnostics.phase, "mobile");
  assert.equal(diag.diagnostics.devicePixelRatio, 3);
});

await t("a mismatch between intent and page state is reported FAILED", async () => {
  await start("mobile", settings, { view: DESKTOP_VIEW });
  const diag = messages.filter((m) => m.type === "diagnostics").pop();
  assert.ok(diag, "no diagnostics emitted");
  assert.equal(diag.diagnostics.ok, false,
    "silent mismatch - this is the original bug");
});

await t("a failing CDP call aborts the run instead of pretending", async () => {
  await reset();
  failMethod = "Network.setUserAgentOverride";
  const r = await send({ type: "startSearches", searchType: "mobile", settings });
  await flush();
  assert.equal(r.success, false, "reported success despite CDP failure");
  assert.match(r.error, /Mobile emulation failed/);
  assert.ok(!store.searchState?.isRunning, "left a run marked active");
});

await t("DevTools already holding the debugger is tolerated", async () => {
  const r = await start("mobile", settings, { attached: true });
  assert.equal(r.success, true, r.error);
  assert.ok(has("Emulation.setDeviceMetricsOverride"), "emulation skipped");
});

console.log("\n--- search execution ---");

await t("search URL keeps Bing's session id and never sends cvid empty", async () => {
  await start("mobile");
  const u = new URL(last("tabs.update").p.url);
  assert.equal(u.searchParams.get("cvid"), "SESSION42", "session id lost");
  assert.equal(u.searchParams.get("form"), "QBRE");
  assert.ok(u.searchParams.get("q"), "no query string");
});

await t("queries do not repeat inside a run", async () => {
  await reset({ view: MOBILE_VIEW });
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 12 } });
  await drain(12);
  const qs = calls.filter((c) => c.m === "tabs.update").map((c) => new URL(c.p.url).searchParams.get("q"));
  assert.equal(qs.length, 12, `expected 12 searches, got ${qs.length}`);
  assert.equal(new Set(qs).size, qs.length, "repeat detected: " + qs.join(" | "));
});

console.log("\n--- lifecycle ---");

await t("stopping detaches the debugger and reverts emulation", async () => {
  await start("mobile");
  await reset({ attached: true, view: MOBILE_VIEW });
  await send({ type: "startSearches", searchType: "mobile", settings });
  await flush();
  calls.length = 0;
  await send({ type: "stopSearches" });
  assert.ok(has("debugger.detach"), "debugger left attached");
  assert.ok(has("Emulation.clearDeviceMetricsOverride"), "viewport left overridden");
  assert.equal(store.searchState, undefined, "state left behind");
});

await t("a 8s delay uses a timer, not a 30s alarm", async () => {
  await start("mobile");
  const tmr = timers[timers.length - 1];
  assert.ok(tmr, "no timer scheduled");
  assert.ok(tmr.ms >= 8000 && tmr.ms <= 15000, "timer was " + tmr.ms + "ms");
  assert.ok(has("alarms.create"), "no suspension backstop registered");
});

await t("inverted min/max is normalised instead of producing NaN", async () => {
  const r = await start("mobile", { ...settings, millisecondsMin: 20000, millisecondsMax: 5000 });
  assert.equal(r.success, true, r.error);
  const tmr = timers[timers.length - 1];
  assert.ok(Number.isFinite(tmr.ms), "NaN reached the scheduler");
  assert.ok(tmr.ms >= 5000 && tmr.ms <= 20000, `out of range: ${tmr.ms}`);
});

await t("out-of-range input is rejected up front", async () => {
  await reset();
  const r = await send({ type: "startSearches", searchType: "desktop", settings: { ...settings, desktopSearches: 9999 } });
  assert.equal(r.success, false);
  assert.match(r.error, /between 1 and 90/);
});

await t("the default 45/15 configuration is accepted", async () => {
  const { default: cfg } = await import("../js/config.js");
  assert.equal(cfg.searches.desktop, 45);
  assert.equal(cfg.searches.mobile, 15);
  assert.ok(cfg.limits.maxSearches >= 45, "maxSearches too low to allow the default");
  const r = await start("desktop", cfg.searches, { view: DESKTOP_VIEW });
  assert.equal(r.success, true, r.error);
  assert.equal(store.searchState.totalInPhase, 45);
});

await t("every preset validates against the limits", async () => {
  const { default: cfg } = await import("../js/config.js");
  for (const [name, p] of Object.entries(cfg.presets)) {
    assert.ok(p.desktop <= cfg.limits.maxSearches, `${name} desktop over limit`);
    assert.ok(p.mobile <= cfg.limits.maxSearches, `${name} mobile over limit`);
    assert.ok(p.millisecondsMax >= p.millisecondsMin, `${name} delay band inverted`);
    assert.ok(p.millisecondsMin >= cfg.limits.minDelayMs, `${name} min delay too low`);
  }
  assert.deepEqual(Object.keys(cfg.presets).sort(), ["daily", "heavy", "quick"]);
});

console.log("\n--- new features ---");

await t("keywords rotate category between consecutive searches", async () => {
  await reset({ view: MOBILE_VIEW });
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 40 } });
  await drain(40);
  const qs = calls.filter((c) => c.m === "tabs.update").map((c) => new URL(c.p.url).searchParams.get("q"));
  assert.equal(qs.length, 40, `expected 40 searches, got ${qs.length}`);

  // Rebuild the category of each query and assert no two neighbours match.
  const { default: KW } = await import("../data/keywords.js");
  const catOf = new Map();
  for (const [cat, words] of Object.entries(KW)) for (const w of words) catOf.set(w, cat);
  const cats = qs.map((q) => catOf.get(q));
  let sameNeighbour = 0;
  for (let i = 1; i < cats.length; i++) if (cats[i] === cats[i - 1]) sameNeighbour++;
  assert.equal(sameNeighbour, 0, `${sameNeighbour} adjacent pairs share a category; `
    + `catOf.size=${catOf.size} missing=${qs.filter((q) => !catOf.has(q)).length} `
    + `cats=${[...new Set(cats)].join(",")} `
    + `deckLen=${store.searchState?.deck?.length} used=${store.searchState?.usedKeywords?.length} `
    + `sample=${qs.slice(0, 2).join(" | ")}`);
});

await t("deck is drawn once and consumed by index, not rebuilt per search", async () => {
  await reset({ view: MOBILE_VIEW });
  // deliberately longer than the run so the deck is still live when inspected
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 20 } });
  await drain(5);
  const st = store.searchState;
  assert.ok(st, "run ended before the deck could be inspected");
  assert.ok(Array.isArray(st.deck), "no deck persisted");
  assert.ok(st.deck.length > 1000, `deck looks rebuilt: ${st.deck.length} entries`);
  assert.equal(st.deckPos, 5, "deck position does not track picks");
  assert.equal(st.usedKeywords.length, 5);
  await send({ type: "stopSearches" });
});

await t("a transient tab failure is retried, not fatal", async () => {
  await reset({ view: MOBILE_VIEW });
  const orig = chrome.tabs.update;
  let n = 0;
  chrome.tabs.update = async (id, o) => {
    n++;
    if (n === 1) throw new Error("net::ERR_ABORTED");
    calls.push({ m: "tabs.update", p: o });
  };
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 3 } });
  await drain(2);
  chrome.tabs.update = orig;

  assert.ok(n >= 2, "update was not retried (n=" + n + ")");
  assert.equal(store.searchState.consecutiveFailures, 0, "retry did not clear the failure counter");
  assert.equal(store.searchState.doneOverall, 2, "the failed attempt was counted as done, or the retry was lost");
});

await t("repeated failures stop the run instead of looping forever", async () => {
  await reset({ view: MOBILE_VIEW });
  const orig = chrome.tabs.update;
  let attempts = 0;
  chrome.tabs.update = async () => { attempts++; throw new Error("net::ERR_CONNECTION_RESET"); };
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 50 } });

  for (let i = 0; i < 400 && store.searchState; i++) {
    await flush();
    if (!store.searchState) break;
    const tmr = timers.find((t) => !t.done);
    if (tmr) { tmr.done = true; tmr.fn(); }
  }
  chrome.tabs.update = orig;

  assert.equal(store.searchState, undefined, "run never gave up after " + attempts + " attempts");
  const stopped = messages.filter((m) => m.type === "stopped").pop();
  assert.ok(stopped, "no stop message");
  assert.equal(stopped.reason, "error");
  assert.match(stopped.error, /ERR_CONNECTION_RESET/);
  assert.ok(attempts <= 6, `gave up too late: ${attempts} attempts`);
});

await t("settings accept both key spellings", async () => {
  const { default: cfg } = await import("../js/config.js");
  // config.js uses desktop/mobile, the popup historically used desktopSearches
  const r = await start("desktop", cfg.searches);
  assert.equal(r.success, true, r.error);
  assert.equal(store.searchState.totalInPhase, 45, "config.searches not understood");
  assert.equal(store.searchState.totalInPhase, settings.desktopSearches);
});

await t("countdown and ETA are published for the popup", async () => {
  await reset({ view: MOBILE_VIEW });
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 5 } });
  await drain(1);
  const prog = messages.filter((m) => m.type === "progress").pop();
  assert.ok(prog.nextSearchAt > Date.now(), "nextSearchAt not set: " + prog.nextSearchAt);
  assert.ok(Number.isFinite(prog.etaMs) && prog.etaMs >= 0, "eta not estimated: " + prog.etaMs);
});

await t("completing a run updates streak and totals once per day", async () => {
  await reset({ view: DESKTOP_VIEW });
  await send({ type: "startSearches", searchType: "desktop", settings: { ...settings, desktopSearches: 3 } });
  await drain(3);
  await settle();
  const done = messages.filter((m) => m.type === "complete").pop();
  assert.ok(done, "no completion message");
  assert.equal(done.stats.streak, 1);
  assert.equal(done.stats.today, 3);

  // A second run the same day must not inflate the streak.
  await reset({ view: DESKTOP_VIEW, keepStats: true });
  await send({ type: "startSearches", searchType: "desktop", settings: { ...settings, desktopSearches: 2 } });
  await drain(2);
  await settle();
  const stats = await new Promise((r) => {
    for (const l of listeners.message) if (l({ type: "getStats" }, {}, r) === true) return;
    r(null);
  });
  assert.equal(stats.streak, 1, "streak double-counted within one day");
  assert.equal(stats.today, 5, "today total wrong");
  assert.equal(stats.total, 5);
});

const getHistory = () => new Promise((r) => {
  for (const l of listeners.message) if (l({ type: "getHistory" }, {}, r) === true) return;
  r(null);
});

await t("each search is written to the run log", async () => {
  await reset({ view: MOBILE_VIEW });
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 4 } });
  await drain(4);
  await settle();
  const log = await getHistory();
  const updates = calls.filter((c) => c.m === "tabs.update").length;
  assert.equal(updates, 4, `expected 4 navigations, got ${updates}`);
  // The four newest entries must be this run's, well formed and non-repeating.
  const mine = log.slice(0, 4);
  assert.ok(mine.every((e) => typeof e.q === "string" && e.q && e.phase && e.at),
    "malformed log entry: " + JSON.stringify(mine));
  assert.equal(new Set(mine.map((e) => e.q)).size, 4, "duplicate query in the log");
});

await t("run summaries are kept out of the per-search log", async () => {
  await reset({ view: DESKTOP_VIEW });
  await send({ type: "startSearches", searchType: "desktop", settings: { ...settings, desktopSearches: 3 } });
  await drain(3);
  await settle(10);

  const log = await getHistory();
  const runs = await new Promise((r) => {
    for (const l of listeners.message) if (l({ type: "getRuns" }, {}, r) === true) return;
    r(null);
  });

  assert.ok(log.every((e) => typeof e.q === "string" && e.q),
    "a run summary leaked into the search log: " + JSON.stringify(log));
  assert.equal(runs.length, 1, "run summary not recorded");
  assert.equal(runs[0].searches, 3);
  assert.equal(runs[0].type, "desktop");
});

await t("stats can be cleared", async () => {
  await new Promise((r) => {
    for (const l of listeners.message) if (l({ type: "clearStats" }, {}, r) === true) return;
    r(null);
  });
  const stats = await new Promise((r) => {
    for (const l of listeners.message) if (l({ type: "getStats" }, {}, r) === true) return;
    r(null);
  });
  assert.equal(stats.total, 0);
  assert.equal(stats.streak, 0);
});

await t("desktopMobile progress spans both phases", async () => {
  const r = await start("desktopMobile", settings, { view: DESKTOP_VIEW });
  assert.equal(r.success, true, r.error);
  assert.equal(store.searchState.totalOverall, 60, "total should be desktop+mobile");
  assert.equal(store.searchState.totalInPhase, 45);
  assert.equal(store.searchState.doneOverall, 1);
  const prog = messages.filter((m) => m.type === "progress").pop();
  assert.equal(prog.progress, 2, "progress should be overall, not per-phase");
});

await t("stale state from an older schema is discarded", async () => {
  store.searchState = { v: 1, isRunning: true, tabId: 7 };
  const r = await send({ type: "getState" });
  await flush();
  assert.ok(!r.isRunning, "resumed into an unknown schema");
  assert.equal(store.searchState, undefined, "stale state left behind");
});

// Global so a failing case cannot leave chrome.tabs.get poisoned for the rest.
const origGet = chrome.tabs.get;
async function withVanishedTab(fn) {
  chrome.tabs.get = async () => { throw new Error("No tab with id: 7"); };
  try { await fn(); } finally { chrome.tabs.get = origGet; }
}
const tabListeners = listeners;

console.log("\n--- tab guards ---");

await t("closing the automation tab stops the run and releases the debugger", async () => {
  await start("mobile");
  await flush();
  calls.length = 0;

  await withVanishedTab(async () => {
    const tmr = timers.find((t) => !t.done);
    assert.ok(tmr, "no scheduled search to fire");
    tmr.done = true;
    tmr.fn();
    await settle(25);
  });

  assert.ok(has("debugger.detach"), "debugger leaked when the tab vanished");
  assert.equal(store.searchState, undefined, "run left marked active");
});

await t("navigating the tab away from bing stops the run", async () => {
  const r = await start("mobile");
  assert.equal(r.success, true, r.error);
  await flush();

  const [onUpdated] = tabListeners.tabUpdated;
  assert.ok(onUpdated, "no onUpdated guard registered");

  // A bing URL must not stop the run.
  onUpdated(7, { status: "loading", url: "https://www.bing.com/search?q=other" });
  await settle(6);
  assert.ok(store.searchState?.isRunning, "bing.com navigation stopped the run");

  // Leaving bing entirely must stop it.
  onUpdated(7, { status: "loading", url: "https://example.com/" });
  await settle(25);
  assert.equal(store.searchState, undefined, "run continued after leaving bing");
  assert.ok(has("debugger.detach"), "debugger leaked on navigated-away");
  const stopped = messages.filter((m) => m.type === "stopped").pop();
  assert.equal(stopped.reason, "navigated-away");
});

await t("the extension's own navigation never trips the guard", async () => {
  await start("mobile");
  await drain(2);
  await settle(6);

  // Drain fires real timers, so the guard has seen the real bing navigations
  // that this.runSearch performs. If any of them stopped the run, the drain
  // could not have reached two searches.
  const done = calls.filter((c) => c.m === "tabs.update").length;
  assert.ok(done >= 2, `only ${done} searches survived the navigation guard`);
  assert.ok(store.searchState?.isRunning, "the run was stopped by its own navigation");
});

await t("keep-alive is armed on start and cleared on stop", async () => {
  intervals.length = 0;
  await start("mobile");
  await flush();
  assert.ok(intervals.some(Boolean), "no keep-alive interval registered");

  intervals.length = 0;
  await send({ type: "stopSearches" });
  await settle(10);
  assert.equal(intervals.filter(Boolean).length, 0, "keep-alive left running after stop");
});

await t("the watchdog recovers a run whose timer was lost", async () => {
  await reset({ view: MOBILE_VIEW });
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 30 } });
  await drain(2);
  await settle(6);
  const before = calls.filter((c) => c.m === "tabs.update").length;

  // Simulate the worker being suspended mid-run: the in-memory timer is gone
  // and the persisted state says a step ran but the next was never armed.
  timers.length = 0;
  store.searchState.nextSearchAt = Date.now() - 5000;
  store.searchState.lastSearchAt = Date.now() - 5000;

  const [onAlarm] = listeners.alarm;
  assert.ok(onAlarm, "no alarm listener registered");
  onAlarm({ name: "searchWatchdog" });
  await settle(25);

  const after = calls.filter((c) => c.m === "tabs.update").length;
  assert.equal(after, before + 1, "watchdog did not recover the lost step");
});

await t("the watchdog gives up on a badly stalled run", async () => {
  await reset({ view: MOBILE_VIEW });
  await send({ type: "startSearches", searchType: "mobile", settings: { ...settings, mobileSearches: 30 } });
  await drain(1);
  await settle(6);
  timers.length = 0;
  store.searchState.nextSearchAt = Date.now() - 10 * 60 * 1000;

  const [onAlarm] = listeners.alarm;
  onAlarm({ name: "searchWatchdog" });
  await settle(25);

  assert.equal(store.searchState, undefined, "a 10-minute-stale run was never cleaned up");
  const stopped = messages.filter((m) => m.type === "stopped").pop();
  assert.equal(stopped.reason, "stalled");
});

console.log("\n--- source invariants ---");
const src = await fs.readFile("js/background.js", "utf8");
for (const [name, ok] of [
  ["exactly one raw sendCommand, inside the checked wrapper",
   (src.match(/chrome\.debugger\.sendCommand/g) || []).length === 1
   && /function debuggerCall[\s\S]*?sendCommand/.test(src)],
  ["lastError() cannot report a phantom failure", /if \(!chrome\.runtime\.lastError\) return null;/.test(src)],
  ["no delayInMinutes on the search path (it would be clamped to 30s)",
   !/chrome\.alarms\.create\(ALARM_NAME, \{[^}]*delayInMinutes/.test(src)],
  ["watchdog alarm is registered for stalled runs",
   /WATCHDOG_NAME/.test(src) && /startWatchdog\(\)/.test(src)],
  ["service worker is kept alive during a run", /startKeepAlive\(\)/.test(src)],
  ["no getTabId() helper left", !/getTabId/.test(src)],
  ["keyword pool built from data/keywords.js", /import KEYWORDS from "..\/data\/keywords\.js"/.test(src)],
  ["legacy word list removed", !/Best coffee shops near me/.test(src)],
]) {
  if (ok) { console.log("  ok   " + name); pass++; }
  else { console.log("  FAIL " + name); fail++; }
}

console.log("\n--- keyword data ---");
const { default: KEYWORDS } = await import("../data/keywords.js");
const all = Object.values(KEYWORDS).flat();

await t("deduped and normalised", () => {
  assert.equal(all.length, new Set(all.map((s) => s.toLowerCase())).size, "duplicates present");
  assert.ok(all.every((s) => s === s.trim() && !/\s{2,}/.test(s)), "whitespace not normalised");
  assert.ok(all.every((s) => s.length >= 10 && s.length <= 60), "length band violated");
  assert.ok(all.every((s) => !/[\u2018\u2019\u201c\u201d]/.test(s)), "smart quotes remain");
});

await t("not dominated by one topic", () => {
  const sizes = Object.values(KEYWORDS).map((v) => v.length);
  const maxShare = Math.max(...sizes) / all.length;
  assert.ok(maxShare < 0.25, `largest category is ${(maxShare * 100).toFixed(0)}%`);
  assert.ok(Object.keys(KEYWORDS).length >= 8, "too few categories");
});

await t("no category is starved", () => {
  const share = (c) => KEYWORDS[c].length / all.length;
  for (const cat of ["travel", "finance", "education", "health", "cooking", "tech"]) {
    assert.ok(KEYWORDS[cat].length >= 60, `${cat} has only ${KEYWORDS[cat].length} keywords`);
    assert.ok(share(cat) >= 0.03, `${cat} is only ${(share(cat) * 100).toFixed(1)}% of the pool`);
  }
});

await t("regenerating the dataset is reproducible", async () => {
  const { execFileSync } = await import("node:child_process");
  const fsSync = await import("node:fs");
  const file = "data/keywords.js";
  const before = fsSync.readFileSync(file, "utf8");
  try {
    execFileSync("node", ["tools/build-keywords.js"], { stdio: "pipe" });
    assert.equal(fsSync.readFileSync(file, "utf8"), before, "generator is not deterministic");
  } finally {
    fsSync.writeFileSync(file, before);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
