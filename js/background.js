import config from "./config.js";
import KEYWORDS from "../data/keywords.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const DEBUG = false;
const log = (...a) => DEBUG && console.log("[RSA]", ...a);
const warn = (...a) => console.warn("[RSA]", ...a);

// ---------------------------------------------------------------------------
// Keyword pool
// ---------------------------------------------------------------------------
const POOL = (() => {
  const lanes = [];
  let total = 0;
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    lanes.push({ cat, words });
    total += words.length;
  }
  return { lanes, total };
})();

const HISTORY_KEY = "rsaHistory";
const RUNS_KEY = "rsaRuns";
const STATS_KEY = "rsaStats";

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------
const STATE_VERSION = 4;

function freshState() {
  return {
    v: STATE_VERSION,
    isRunning: false,
    tabId: null,
    searchType: null, // 'desktop' | 'mobile' | 'desktopMobile'
    phase: null, // 'desktop' | 'mobile'
    doneInPhase: 0,
    totalInPhase: 0,
    doneOverall: 0,
    totalOverall: 0,
    desktopSearches: 0,
    mobileSearches: 0,
    minMs: config.searches.millisecondsMin,
    maxMs: config.searches.millisecondsMax,
    cvid: null,
    deck: [], // pre-shuffled, round-robin across categories
    deckPos: 0,
    usedKeywords: [],
    lastCategory: null,
    startedAt: 0,
    nextSearchAt: 0, // drives the countdown in the popup
    lastSearchAt: 0, // stops the watchdog re-running the step it just ran
    emulation: null, // null | 'mobile'
    diagnostics: null,
    consecutiveFailures: 0,
    lastError: null,
  };
}

let state = freshState();

async function saveState() {
  await chrome.storage.local.set({ searchState: state });
}

async function loadState() {
  const { searchState } = await chrome.storage.local.get("searchState");
  if (!searchState) {
    // Nothing persisted: the in-memory copy may still be a finished run, so
    // reset it rather than leaving a stale isRunning behind.
    state = freshState();
    return false;
  }
  if (searchState.v !== STATE_VERSION) {
    // Schema changed under a live run: drop it rather than resume into garbage.
    await clearRun();
    return false;
  }
  state = { ...freshState(), ...searchState };
  return true;
}

async function clearRun() {
  state = freshState();
  clearSchedule();
  await chrome.storage.local.remove("searchState");
}

// ---------------------------------------------------------------------------
// History & stats (survive run teardown, so a crash does not lose the record)
// ---------------------------------------------------------------------------
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function readJson(key, fallback) {
  const res = await chrome.storage.local.get(key);
  return res[key] ?? fallback;
}

// readJson + modify + set is a read-modify-write. Without serialisation two
// overlapping writers lose each other's entries, so every history/stats update
// goes through one queue.
let writeQueue = Promise.resolve();

function mutateJson(key, limit, mutate) {
  writeQueue = writeQueue.then(async () => {
    const current = await readJson(key, []);
    const next = mutate(current.slice());
    await chrome.storage.local.set({ [key]: next.slice(0, limit) });
    return next;
  });
  return writeQueue;
}

async function recordRun() {
  // Run summaries live under their own key: mixing them into the per-search log
  // makes the popup render summary rows as blank queries.
  await mutateJson(RUNS_KEY, config.limits.historySize, (runs) => {
    runs.unshift({
      at: Date.now(),
      searches: state.doneOverall,
      type: state.searchType,
      durationMs: Date.now() - state.startedAt,
      phase: state.phase,
    });
    return runs;
  });

  const stats = await readJson(STATS_KEY, { totalSearches: 0, totalRuns: 0, days: {}, lastDay: null });
  const today = dayKey();
  const yesterday = dayKey(new Date(Date.now() - 86400000));

  // A day only counts once, no matter how many runs happen inside it.
  if (stats.lastDay !== today) {
    stats.streak = stats.lastDay === yesterday ? (stats.streak ?? 0) + 1 : 1;
    stats.lastDay = today;
  }
  stats.totalSearches += state.doneOverall;
  stats.totalRuns += 1;

  const d = (stats.days[today] ??= { searches: 0, runs: 0 });
  d.searches += state.doneOverall;
  d.runs += 1;

  // Keep the map small: drop days older than a fortnight.
  for (const k of Object.keys(stats.days)) {
    if (k < dayKey(new Date(Date.now() - 13 * 86400000))) delete stats.days[k];
  }

  await chrome.storage.local.set({ [STATS_KEY]: stats });
  return stats;
}

async function clearStats() {
  await chrome.storage.local.remove([HISTORY_KEY, RUNS_KEY, STATS_KEY]);
}

async function getStats() {
  const stats = await readJson(STATS_KEY, { totalSearches: 0, totalRuns: 0, days: {}, streak: 0, lastDay: null });
  const today = stats.days[dayKey()] ?? { searches: 0, runs: 0 };
  return { today: today.searches, runsToday: today.runs, streak: stats.streak ?? 0, total: stats.totalSearches };
}

// ---------------------------------------------------------------------------
// CDP helpers — every call is error-checked. A silent CDP failure is how
// "mobile mode" ends up running with a desktop user agent.
// ---------------------------------------------------------------------------
// Returns null when the call succeeded. Note: this must NOT coerce "no error"
// into a truthy string, otherwise every CDP call looks like a failure.
function lastError() {
  if (!chrome.runtime.lastError) return null;
  return chrome.runtime.lastError.message ?? "unknown debugger error";
}

function debuggerCall(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const err = lastError();
      if (err) reject(new Error(`${method}: ${err}`));
      else resolve(res);
    });
  });
}

async function attachDebugger(tabId) {
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = lastError();
        if (err) reject(new Error(err));
        else resolve();
      });
    });
    log("debugger attached", tabId);
  } catch (e) {
    // "Another debugger is already attached" means DevTools is open on the tab.
    // Treat an already-attached debugger as success, anything else as fatal.
    if (/already attached/i.test(e.message)) {
      warn("debugger already attached (is DevTools open on the tab?)", tabId);
      return true;
    }
    throw e;
  }
  return true;
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      const err = lastError();
      if (err && !/not attached/i.test(err)) warn("detach:", err);
      resolve();
    });
  });
}

// The real client version, so the spoofed UA / UA-CH cannot contradict the
// browser's own TLS + HTTP2 + Sec-CH-UA fingerprint.
function realChromeVersion() {
  const m = /Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(navigator.userAgent);
  if (!m) return { major: "131", full: "131.0.0.0" };
  return { major: m[1], full: `${m[1]}.${m[2]}.${m[3]}.${m[4]}` };
}

function uaMetadata(version, mobile) {
  return {
    brands: [
      { brand: "Chromium", version: version.major },
      { brand: "Google Chrome", version: version.major },
      { brand: "Not?A_Brand", version: "24" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: version.full },
      { brand: "Google Chrome", version: version.full },
      { brand: "Not?A_Brand", version: "24.0.0.0" },
    ],
    platform: mobile ? "Android" : "Windows",
    platformVersion: mobile ? "13.0.0" : "15.0.0",
    architecture: mobile ? "arm" : "x86",
    model: mobile ? config.devices.phone.model : "",
    mobile,
    bitness: "64",
    wow64: false,
  };
}

async function applyMobile(tabId) {
  const version = realChromeVersion();
  const d = config.devices.phone;

  await debuggerCall(tabId, "Network.setUserAgentOverride", {
    userAgent: d.userAgent,
    acceptLanguage: d.acceptLanguage,
    platform: "Linux armv8l",
    userAgentMetadata: uaMetadata(version, true),
  });

  await debuggerCall(tabId, "Emulation.setDeviceMetricsOverride", {
    width: d.width,
    height: d.height,
    deviceScaleFactor: d.deviceScaleFactor,
    mobile: true,
    screenWidth: d.width,
    screenHeight: d.height,
    positionX: 0,
    positionY: 0,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });

  await debuggerCall(tabId, "Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });

  await debuggerCall(tabId, "Emulation.setEmitTouchEventsForMouse", {
    enabled: true,
    configuration: "mobile",
  });

  state.emulation = "mobile";
  log("mobile emulation applied", tabId);
}

async function clearEmulation(tabId) {
  try {
    await debuggerCall(tabId, "Network.setUserAgentOverride", {
      userAgent: config.devices.desktop.userAgent,
      acceptLanguage: config.devices.desktop.acceptLanguage,
      platform: "Win32",
      userAgentMetadata: uaMetadata(realChromeVersion(), false),
    });
    await debuggerCall(tabId, "Emulation.clearDeviceMetricsOverride");
    await debuggerCall(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
    await debuggerCall(tabId, "Emulation.setEmitTouchEventsForMouse", { enabled: false });
  } catch (e) {
    // A closed/navigated-away tab can throw here; cleanup is best-effort.
    warn("clearEmulation:", e.message);
  }
  state.emulation = null;
}

// Read back what the page actually sees. This is the check that was missing:
// without it, failed emulation is indistinguishable from success.
async function probeEmulation(tabId) {
  try {
    const res = await debuggerCall(tabId, "Runtime.evaluate", {
      expression: `JSON.stringify({
        ua: navigator.userAgent,
        dpr: window.devicePixelRatio,
        touch: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0),
        w: window.innerWidth
      })`,
      returnByValue: true,
    });
    return JSON.parse(res.result.value);
  } catch (e) {
    warn("probeEmulation:", e.message);
    return null;
  }
}

function verify(probe, expected) {
  if (!probe) return { ok: false, phase: expected, error: "could not read page state" };
  const isMobileUA = /Mobile|Android/.test(probe.ua);
  return {
    ok: expected === "mobile" ? isMobileUA && probe.touch : !isMobileUA,
    phase: expected,
    userAgent: probe.ua,
    devicePixelRatio: probe.dpr,
    touch: probe.touch,
    viewportWidth: probe.w,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
//
// chrome.alarms clamps any delay below 30s (Chrome 120+), which silently threw
// away the user's 8-10s setting. Short delays therefore use setTimeout -- the
// service worker stays alive while a timer is pending -- with the alarm kept
// purely as a suspension backstop.
// ---------------------------------------------------------------------------
const ALARM_NAME = "searchAlarm";
const WATCHDOG_NAME = "searchWatchdog";
const WATCHDOG_MINUTES = 0.5; // Chrome's floor for alarms
const TIMER_THRESHOLD_MS = 25000;
const STALE_RUN_MS = 2 * 60 * 1000;

let pendingTimer = null;
let inFlight = false;
let keepAliveTimer = null;
let ownNavigation = false;

function clearSchedule() {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  state.nextSearchAt = 0;
  chrome.alarms.clear(ALARM_NAME);
}

// An MV3 worker is torn down after ~30s idle, which can land in the middle of
// a chain of awaited debugger calls. A cheap API call on an interval keeps it
// resident for the duration of a run.
function startKeepAlive() {
  if (keepAliveTimer !== null) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function startWatchdog() {
  chrome.alarms.create(WATCHDOG_NAME, {
    periodInMinutes: WATCHDOG_MINUTES,
    delayInMinutes: WATCHDOG_MINUTES,
  });
}

function stopWatchdog() {
  chrome.alarms.clear(WATCHDOG_NAME);
}

function scheduleNext(delayMs) {
  clearSchedule();
  state.nextSearchAt = Date.now() + delayMs;

  if (delayMs < TIMER_THRESHOLD_MS) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void runSearch();
    }, delayMs);
  }

  // Backstop: survives service-worker suspension. No-op if the timer wins,
  // because runSearch() schedules the following step and clears this alarm.
  chrome.alarms.create(ALARM_NAME, { when: state.nextSearchAt });
}

// The watchdog exists for one case the timer cannot cover: the worker was
// suspended after the counter was persisted but before the next timer was
// armed. It deliberately does not consult the in-memory timer handle, because
// after a restart that handle is gone and the persisted state is all we have.
async function watchdogTick() {
  if (!(await loadState()) || !state.isRunning) return;
  if (inFlight) return;

  const due = state.nextSearchAt;
  if (!due) {
    // A run is active with nothing scheduled: it stalled between steps.
    warn("run is active with nothing scheduled, recovering");
    scheduleNext(1000);
    return;
  }

  const late = Date.now() - due;
  if (late < 1000) return;
  if (late > STALE_RUN_MS) {
    warn(`run is ${Math.round(late / 1000)}s overdue, treating it as dead`);
    await stopSearches("stalled");
    return;
  }
  // The step may have run a moment ago and died before re-arming the timer.
  if (state.lastSearchAt && Date.now() - state.lastSearchAt < 1500) return;
  void runSearch();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_NAME) {
    void watchdogTick();
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  void (async () => {
    if (!(await loadState())) return;
    if (state.isRunning && !inFlight) void runSearch();
  })();
});

// ---------------------------------------------------------------------------
// Keywords
//
// The deck is built once per cycle and drawn from the end: O(1) per search and
// no per-search array rebuild. It is filled round-robin across categories, so
// two consecutive queries can never sit in the same topic lane, and shuffled
// inside each lane so repeats are spread out rather than clustered.
// ---------------------------------------------------------------------------
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck() {
  const used = new Set(state.usedKeywords);
  const lanes = POOL.lanes.map(({ cat, words }) => ({
    cat,
    items: shuffled(words.filter((w) => !used.has(w))),
  }));

  const deck = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const lane of lanes) {
      if (i < lane.items.length) {
        deck.push(lane.items[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return deck;
}

// The deck is filled round-robin across categories, so two consecutive entries
// can never sit in the same lane. It is consumed from the FRONT via an index:
// popping from the end would drain the tail of the longest lane (the deck is
// ragged, so the last pass can be one category only) and make every late search
// come from the same topic.
function nextKeyword() {
  if (state.deckPos >= state.deck.length) {
    state.deck = buildDeck();
    state.deckPos = 0;
    if (state.deck.length === 0) {
      // Every keyword has been used this run: start the cycle over.
      state.usedKeywords = [];
      state.deck = buildDeck();
    }
  }
  // Never hand back undefined: an empty pool must stop the run, not turn into a
  // search for the literal string "undefined".
  const w = state.deck[state.deckPos];
  if (typeof w !== "string" || !w) return null;
  state.deckPos += 1;
  state.usedKeywords.push(w);
  return w;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
function randomDelay() {
  const min = Number.isFinite(state.minMs) ? state.minMs : config.searches.millisecondsMin;
  let max = Number.isFinite(state.maxMs) ? state.maxMs : config.searches.millisecondsMax;
  if (max < min) max = min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Messaging to popup
// ---------------------------------------------------------------------------
function notify(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function pushProgress() {
  const pct = state.totalOverall
    ? Math.min(100, Math.round((state.doneOverall / state.totalOverall) * 100))
    : 0;

  // Rough ETA from the average time actually observed so far.
  const elapsed = state.doneOverall ? Date.now() - state.startedAt : 0;
  const perSearch = state.doneOverall ? elapsed / state.doneOverall : 0;
  const remaining = Math.max(0, state.totalOverall - state.doneOverall) * perSearch;

  notify({
    type: "progress",
    progress: pct,
    currentSearch: state.doneInPhase,
    totalSearches: state.totalInPhase,
    doneOverall: state.doneOverall,
    totalOverall: state.totalOverall,
    phase: state.phase,
    nextSearchAt: state.nextSearchAt,
    etaMs: remaining,
  });
}

function pushDiagnostics(diagnostics) {
  state.diagnostics = diagnostics;
  notify({ type: "diagnostics", diagnostics });
}

// ---------------------------------------------------------------------------
// Search execution
// ---------------------------------------------------------------------------
function buildSearchUrl(keyword) {
  const url = new URL(config.bing.url);
  url.searchParams.set("q", keyword);
  url.searchParams.set("form", config.bing.form);
  // cvid is Bing's session id. Sending it empty is worse than omitting it.
  if (state.cvid) url.searchParams.set("cvid", state.cvid);
  else url.searchParams.delete("cvid");
  return url.toString();
}

// One navigation attempt per runSearch call. Retries are handled by the
// scheduler, so a persistently failing tab burns down consecutiveFailures and
// eventually stops the run instead of looping forever.
async function runSearch() {
  if (inFlight) return;
  inFlight = true;

  try {
    if (!state.isRunning || !state.tabId) return;

    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab) {
      warn("automation tab is gone, stopping");
      await stopSearches("tab-closed");
      return;
    }

    // Remember Bing's session id so every search in this run shares it.
    if (!state.cvid && /bing\.com/.test(tab.url ?? "")) {
      state.cvid = new URL(tab.url).searchParams.get("cvid") || null;
    }

    const keyword = nextKeyword();
    if (!keyword) {
      await stopSearches("empty-keyword-pool");
      return;
    }

    // Flag the navigation so the onUpdated guard does not mistake our own
    // redirect (Bing bounces between www./cn./consent hosts) for a user detour.
    ownNavigation = true;
    await chrome.tabs.update(state.tabId, { url: buildSearchUrl(keyword) });

    state.consecutiveFailures = 0;
    state.lastError = null;
    state.doneInPhase += 1;
    state.doneOverall += 1;
    state.lastSearchAt = Date.now();

    await mutateJson(HISTORY_KEY, config.limits.historySize, (h) => {
      h.unshift({ at: Date.now(), q: keyword, phase: state.phase });
      return h;
    });

    // Report before branching: the final search of a run must publish its
    // progress too, otherwise the bar freezes one step short of 100%.
    const phaseDone = state.doneInPhase >= state.totalInPhase;

await saveState();

    // Arm the timer before reporting so the message carries nextSearchAt, which
    // drives the countdown. Reporting after would publish a stale (or zero)
    // countdown.
    if (!phaseDone) scheduleNext(randomDelay());

    // Report even on the final search of a run, otherwise the bar freezes one
    // step short of 100%.
    pushProgress();

    if (phaseDone) {
      const finished = await finishPhase();
      // completeSearches() already cleared the run. Persisting or reporting
      // progress now would rewrite a dead state and publish a bogus 0%.
      if (finished) return;
    }

    await saveState();
  } catch (e) {
    state.consecutiveFailures += 1;
    state.lastError = e.message;
    warn("runSearch failed:", e.message, `(${state.consecutiveFailures})`);

    if (state.consecutiveFailures >= config.limits.maxConsecutiveFailures) {
      await stopSearches("error");
      return;
    }
    // Back off and retry the next step rather than abandoning the run.
    await saveState();
    scheduleNext(Math.max(3000, randomDelay()));
  } finally {
    inFlight = false;
  }
}

// Returns true when the whole run is over, false when a further phase remains.
async function finishPhase() {
  if (state.searchType === "desktop") {
    await completeSearches();
    return true;
  }

  if (state.searchType === "mobile") {
    await shutdownEmulation();
    await completeSearches();
    return true;
  }

  // desktopMobile
  if (state.phase === "desktop") {
    state.phase = "mobile";
    state.doneInPhase = 0;
    state.totalInPhase = state.mobileSearches;

    try {
      await attachDebugger(state.tabId);
      await applyMobile(state.tabId);
      const probe = await probeEmulation(state.tabId);
      pushDiagnostics(verify(probe, "mobile"));
    } catch (e) {
      warn("failed to enter mobile phase:", e.message);
      pushDiagnostics({ ok: false, phase: "mobile", error: e.message });
      await stopSearches("emulation-failed");
      return true;
    }

    notify({ type: "phaseChange", phase: "mobile", totalSearches: state.totalInPhase });
    await saveState();
    scheduleNext(randomDelay());
    return false;
  }

  await shutdownEmulation();
  await completeSearches();
  return true;
}

async function shutdownEmulation() {
  if (!state.tabId || !state.emulation) return;
  await clearEmulation(state.tabId);
  await detachDebugger(state.tabId);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function completeSearches() {
  clearSchedule();
  stopKeepAlive();
  stopWatchdog();
  await recordRun();
  // sendStats() shape, not the raw accumulator, so the popup gets .today/.streak
  const stats = await getStats();
  notify({ type: "complete", stats });
  await clearRun();
}

async function stopSearches(reason) {
  // Read persisted state first: after a worker restart the in-memory copy does
  // not know which tab was being emulated, and the debugger would leak.
  await loadState();
  const wasEmulating = Boolean(state.tabId && state.emulation);
  const error = state.lastError;
  clearSchedule();
  stopKeepAlive();
  stopWatchdog();
  notify({ type: "stopped", reason, error });
  if (wasEmulating) await shutdownEmulation();
  await clearRun();
}

// The popup, the preset buttons and config.js all name the counts differently
// at different call sites, so accept both spellings rather than silently
// reading undefined and failing validation.
function normalizeSettings(s = {}) {
  return {
    desktopSearches: Number(s.desktopSearches ?? s.desktop),
    mobileSearches: Number(s.mobileSearches ?? s.mobile),
    millisecondsMin: Number(s.millisecondsMin),
    millisecondsMax: Number(s.millisecondsMax),
  };
}

function totalsFor(type, settings) {
  const desktop = Number(settings.desktopSearches);
  const mobile = Number(settings.mobileSearches);
  if (type === "mobile") return { totalInPhase: mobile, totalOverall: mobile };
  if (type === "desktopMobile") return { totalInPhase: desktop, totalOverall: desktop + mobile };
  return { totalInPhase: desktop, totalOverall: desktop };
}

function validate(settings) {
  const errors = [];
  for (const key of ["desktopSearches", "mobileSearches"]) {
    const n = Number(settings[key]);
    if (!Number.isInteger(n) || n < 1 || n > config.limits.maxSearches) {
      errors.push(`${key} must be between 1 and ${config.limits.maxSearches}`);
    }
  }
  for (const key of ["millisecondsMin", "millisecondsMax"]) {
    const n = Number(settings[key]);
    if (!Number.isFinite(n) || n < config.limits.minDelayMs) {
      errors.push(`${key} must be at least ${config.limits.minDelayMs} ms`);
    }
  }
  return errors;
}

async function startSearches(type, settings) {
  // Re-read persisted state first: after a worker restart the in-memory copy is
  // a fresh object, and trusting it would allow a second run to clobber a run
  // that is still live in storage.
  await loadState();
  if (state.isRunning) return { success: false, error: "A run is already in progress" };

  const s = normalizeSettings(settings);
  const errors = validate(s);
  if (errors.length) return { success: false, error: errors.join("; ") };

  let tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  } catch {
    tabId = null;
  }
  if (typeof tabId !== "number") {
    return { success: false, error: "No active tab to run in" };
  }

  const { totalInPhase, totalOverall } = totalsFor(type, s);

  state = {
    ...freshState(),
    isRunning: true,
    tabId,
    searchType: type,
    phase: type === "mobile" ? "mobile" : "desktop",
    doneInPhase: 0,
    totalInPhase,
    doneOverall: 0,
    totalOverall,
    minMs: Math.min(s.millisecondsMin, s.millisecondsMax),
    maxMs: Math.max(s.millisecondsMin, s.millisecondsMax),
    desktopSearches: s.desktopSearches,
    mobileSearches: s.mobileSearches,
    startedAt: Date.now(),
  };

  if (type === "mobile") {
    try {
      await attachDebugger(tabId);
      await applyMobile(tabId);
      const probe = await probeEmulation(tabId);
      pushDiagnostics(verify(probe, "mobile"));
    } catch (e) {
      warn("startSearches emulation failed:", e.message);
      await clearRun();
      return { success: false, error: `Mobile emulation failed: ${e.message}` };
    }
  }

  await saveState();
  startKeepAlive();
  startWatchdog();
  void runSearch();
  return { success: true, totalOverall };
}

// Re-attach after a service-worker restart or browser relaunch. Without this a
// run resumed into the mobile phase kept the desktop user agent.
async function resumeIfRunning() {
  if (!(await loadState()) || !state.isRunning) return;

  if (state.tabId) {
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab) {
      warn("resuming but automation tab no longer exists");
      await stopSearches("tab-closed");
      return;
    }
  }

  if (state.emulation) {
    try {
      await attachDebugger(state.tabId);
      await applyMobile(state.tabId);
      const probe = await probeEmulation(state.tabId);
      pushDiagnostics(verify(probe, "mobile"));
    } catch (e) {
      warn("resume could not restore mobile emulation:", e.message);
      pushDiagnostics({ ok: false, phase: "mobile", error: e.message });
      await stopSearches("emulation-failed");
      return;
    }
  }

  startKeepAlive();
  startWatchdog();
  // If the previous step was already due, do not add another full delay: the
  // watchdog would have caught it, but firing now keeps the run moving.
  const overdue = state.nextSearchAt && Date.now() >= state.nextSearchAt;
  scheduleNext(overdue ? 0 : randomDelay());
}

chrome.runtime.onStartup.addListener(() => void resumeIfRunning());
chrome.runtime.onInstalled.addListener(() => void resumeIfRunning());

// ---------------------------------------------------------------------------
// Message API
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "startSearches":
      startSearches(message.searchType, message.settings).then(sendResponse);
      return true;
    case "stopSearches":
      stopSearches("user").then(() => sendResponse({ success: true }));
      return true;
    case "getState":
      loadState().then(async () => {
        sendResponse({
          isRunning: state.isRunning,
          phase: state.phase,
          searchType: state.searchType,
          currentSearch: state.doneInPhase,
          totalSearches: state.totalInPhase,
          doneOverall: state.doneOverall,
          totalOverall: state.totalOverall,
          nextSearchAt: state.nextSearchAt,
          diagnostics: state.diagnostics,
          totalKeywords: POOL.total,
          limits: config.limits,
        });
      });
      return true;
    case "getDiagnostics":
      loadState().then(async () => {
        if (!state.tabId) return sendResponse(null);
        const probe = await probeEmulation(state.tabId);
        sendResponse(verify(probe, state.emulation ?? "desktop"));
      });
      return true;
    case "getHistory":
      readJson(HISTORY_KEY, []).then((h) => sendResponse(h.slice(0, 25)));
      return true;
    case "getRuns":
      readJson(RUNS_KEY, []).then((r) => sendResponse(r.slice(0, 10)));
      return true;
    case "getStats":
      getStats().then(sendResponse);
      return true;
    case "clearStats":
      clearStats().then(() => sendResponse({ success: true }));
      return true;
    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Tab lifecycle guards
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.isRunning && tabId === state.tabId) void stopSearches("tab-closed");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!state.isRunning || tabId !== state.tabId) return;

  // Consume the flag on the first event caused by our own navigation. A timer
  // based window would swallow a genuine user detour that happens while a
  // slow Bing response is still landing.
  if (ownNavigation) {
    ownNavigation = false;
    return;
  }

  // A user-initiated navigation away from Bing breaks the run's contract.
  if (changeInfo.status === "loading" && changeInfo.url && !/bing\.com/.test(changeInfo.url)) {
    warn("tab left bing.com during a run, stopping");
    void stopSearches("navigated-away");
  }
});

// Releasing the tab must not leave DevTools emulation pinned on it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  port.onDisconnect.addListener(() => {
    void (async () => {
      const ok = await loadState();
      if (ok && state.isRunning) return;
      if (state.tabId) await detachDebugger(state.tabId);
    })();
  });
});

chrome.runtime.onSuspend.addListener(() => clearSchedule());
