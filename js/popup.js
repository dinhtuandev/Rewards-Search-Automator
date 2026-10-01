import config from './config.js'

// Keeps a port open so the background worker can observe popup lifecycle and
// release the automation tab when the popup goes away.
chrome.runtime.connect({ name: 'popup' })

let countdownTimer = null
let progressState = null

init()

function init() {
    setDefaultUI()
    applyPreset('daily', { silent: true })
    loadConfigurationFromStorage()
    refreshStats()
    renderHistory()
    checkRunningState()
    bindEvents()
    startCountdownLoop()
}

function bindEvents() {
    $(config.domElements.desktopButton).on('click', () => startSearches('desktop'))
    $(config.domElements.mobileButton).on('click', () => startSearches('mobile'))
    $(config.domElements.desktopMobileButton).on('click', () => startSearches('desktopMobile'))
// Wrap in an arrow: jQuery invokes handlers with (event), so passing the
// function by reference made `settings` the click event and stored it.
$(config.domElements.saveConfigButton).on('click', () => saveConfigurationToStorage())
$(config.domElements.stopButton).on('click', () => stopRun())

    $(config.domElements.checkEmulationButton).on('click', () => {
        chrome.runtime.sendMessage({ type: 'getDiagnostics' }, (d) => {
            if (!d) return showError('No active automation tab to inspect.')
            renderDiagnostics(d)
        })
    })

    $(config.domElements.clearStatsButton).on('click', () => {
        chrome.runtime.sendMessage({ type: 'clearStats' }, () => {
            refreshStats()
            renderHistory()
        })
    })

    for (const key of ['presetQuick', 'presetDaily', 'presetHeavy']) {
        $(config.domElements[key]).on('click', () => applyPreset(key.replace('preset', '').toLowerCase()))
    }
}

// ---------------------------------------------------------------------------
// Message pump
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
        case 'progress':
            setProgress(message.progress)
            progressState = message
            setProgressLabel(
                message.phase === 'mobile' ? 'Mobile' : 'Desktop',
                message.currentSearch,
                message.totalSearches
            )
            setEta(message.etaMs)
            updateCountdown()
            break

        case 'phaseChange':
            setProgressLabel('Mobile', 0, message.totalSearches)
            break

        case 'diagnostics':
            renderDiagnostics(message.diagnostics)
            break

        case 'complete':
            finishRun('complete', message.stats)
            break

        case 'stopped':
            finishRun('stopped', null, message)
            break
    }
})

function finishRun(kind, stats, message) {
    setProgress(100)
    setProgressLabel('', 0, 0)
    setEta(0)
    updateCountdown()
    activateForms()
    showPanel(false)
    refreshStats()
    renderHistory()
    progressState = null

    if (kind === 'complete') {
        showSuccess(`Finished ${stats?.today ?? '?'} searches today. Streak: ${stats?.streak ?? 0}.`)
    } else {
        const reason = stoppedReasonText(message?.reason)
        if (message?.error) showError(`${reason} (${message.error})`)
        else if (message?.reason !== 'user') showError(reason)
    }
}

function stoppedReasonText(reason) {
    return {
        'emulation-failed': 'Stopped: mobile emulation could not be applied.',
        'tab-closed': 'Stopped: the automation tab was closed.',
        'navigated-away': 'Stopped: the tab navigated away from Bing.',
        'error': 'Stopped after too many consecutive failures.',
        'user': 'Stopped.',
    }[reason] ?? 'Stopped.'
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------
function startCountdownLoop() {
    if (countdownTimer) clearInterval(countdownTimer)
    countdownTimer = setInterval(updateCountdown, 250)
}

function updateCountdown() {
    const el = $(config.domElements.countdownLabel)
    const at = progressState?.nextSearchAt
    if (!at) {
        el.text('')
        return
    }
    const left = Math.max(0, Math.round((at - Date.now()) / 1000))
    el.text(left > 0 ? `next search in ${left}s` : 'searching…')
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function applyPreset(name, { silent = false } = {}) {
    const preset = config.presets[name]
    if (!preset) return

    const settings = {
        desktop: preset.desktop,
        mobile: preset.mobile,
        millisecondsMin: preset.millisecondsMin,
        millisecondsMax: preset.millisecondsMax,
    }
    writeSettings(settings)
    config.searches = settings

    for (const key of ['presetQuick', 'presetDaily', 'presetHeavy']) {
        $(config.domElements[key]).removeClass('active')
    }
    const id = 'preset' + name[0].toUpperCase() + name.slice(1)
    $(config.domElements[id]).addClass('active')

    // A preset the user picked should survive closing the popup.
    if (!silent) saveConfigurationToStorage(settings)
}

function readSettings() {
    const { limits } = config
    const num = (sel) => Number($(sel).val())
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)))

    let millisecondsMin = clamp(num(config.domElements.waitingBetweenSearchesFormMin), limits.minDelayMs, limits.maxDelayMs)
    let millisecondsMax = clamp(num(config.domElements.waitingBetweenSearchesFormMax), limits.minDelayMs, limits.maxDelayMs)
    if (millisecondsMax < millisecondsMin) {
        [millisecondsMin, millisecondsMax] = [millisecondsMax, millisecondsMin]
    }

    return {
        desktop: clamp(num(config.domElements.totDesktopSearchesForm), 1, limits.maxSearches),
        mobile: clamp(num(config.domElements.totMobileSearchesForm), 1, limits.maxSearches),
        millisecondsMin,
        millisecondsMax,
    }
}

function writeSettings(s) {
    $(config.domElements.totDesktopSearchesForm).val(s.desktop)
    $(config.domElements.totMobileSearchesForm).val(s.mobile)
    $(config.domElements.waitingBetweenSearchesFormMin).val(s.millisecondsMin)
    $(config.domElements.waitingBetweenSearchesFormMax).val(s.millisecondsMax)
}

function startSearches(searchType) {
    const settings = readSettings()
    writeSettings(settings)
    // Persist silently: the user did not press Save, and a "Saved!" toast here
    // would compete with the run itself.
    saveConfigurationToStorage(settings, { quiet: true })

    deactivateForms()
    showPanel(false)
    setProgress(0)
    setEta(0)
    setProgressLabel(
        searchType === 'mobile' ? 'Mobile' : 'Desktop',
        0,
        searchType === 'mobile' ? settings.mobile : settings.desktop
    )

    chrome.runtime.sendMessage({ type: 'startSearches', searchType, settings }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
            showError(response?.error ?? 'Could not start the run.')
            setProgress(0)
            setProgressLabel('', 0, 0)
            activateForms()
        }
    })
}

function stopRun() {
    if (!confirm('Stop the current run?')) return
    $(config.domElements.stopButton).prop('disabled', true)
    chrome.runtime.sendMessage({ type: 'stopSearches' })
}

function setDefaultUI() {
    $(config.domElements.appVersion).html(config.general.appVersion)
    $(config.domElements.authorWebsiteLink).attr('href', config.general.authorWebsiteLink)
    $(config.domElements.repositoryGithubLink).attr('href', config.general.repositoryGithubLink)
    $(config.domElements.storeLink).attr('href', config.general.storeLink)
    $(config.domElements.rewardsLink).attr('href', config.general.rewardsLink)
    $(config.domElements.f1PromoLink).attr('href', config.general.authorWebsiteLinkThanks[0])

    // Reflect which preset the saved settings correspond to.
    const s = config.searches
    const match = Object.entries(config.presets).find(([, p]) =>
        p.desktop === Number(s.desktop) && p.mobile === Number(s.mobile))
    for (const key of ['presetQuick', 'presetDaily', 'presetHeavy']) {
        $(config.domElements[key]).removeClass('active')
    }
    if (match) $(config.domElements['preset' + match[0][0].toUpperCase() + match[0].slice(1)]).addClass('active')

    const { limits } = config
    $(config.domElements.totDesktopSearchesForm).attr({ min: 1, max: limits.maxSearches })
    $(config.domElements.totMobileSearchesForm).attr({ min: 1, max: limits.maxSearches })
    $(config.domElements.waitingBetweenSearchesFormMin).attr({ min: limits.minDelayMs, step: 500 })
    $(config.domElements.waitingBetweenSearchesFormMax).attr({ min: limits.minDelayMs, step: 500 })
}

// ---------------------------------------------------------------------------
// Progress / labels
// ---------------------------------------------------------------------------
function setProgress(value) {
    const pct = Math.max(0, Math.min(100, value))
    const bar = document.querySelector(config.domElements.progressBar)
    bar.style.width = pct + '%'
    bar.innerText = pct + '%'
}

function setProgressLabel(phase, current, total) {
    const el = $(config.domElements.progressLabel)
    el.text(total ? `${phase} ${current}/${total}` : '')
}

function setEta(ms) {
    // Must clear on 0, otherwise a finished run keeps advertising time left.
    if (!ms || ms <= 0) return $(config.domElements.etaLabel).text('')
    const mins = Math.ceil(ms / 60000)
    $(config.domElements.etaLabel).text(mins <= 1 ? '~1 min left' : `~${mins} min left`)
}

// ---------------------------------------------------------------------------
// Stats & history
// ---------------------------------------------------------------------------
function refreshStats() {
    chrome.runtime.sendMessage({ type: 'getStats' }, (stats) => {
        if (!stats) return
        $(config.domElements.statsToday).text(stats.today)
        $(config.domElements.statsStreak).text(stats.streak)
        $(config.domElements.statsTotal).text(stats.total)
    })
}

function renderHistory() {
    renderLastRun()
    chrome.runtime.sendMessage({ type: 'getHistory' }, (entries) => {
        const el = $(config.domElements.runLog)
        if (!el) return
        if (!entries?.length) {
            el.html('<div class="runlog-empty">No searches yet.</div>')
            return
        }
        el.html(entries.map((e) => {
            const t = new Date(e.at)
            const hh = String(t.getHours()).padStart(2, '0')
            const mm = String(t.getMinutes()).padStart(2, '0')
            const ss = String(t.getSeconds()).padStart(2, '0')
            const phase = e.phase === 'mobile' ? 'M' : 'D'
            return `<div class="runlog-row">
                <span class="runlog-time">${hh}:${mm}:${ss}</span>
                <span class="runlog-phase">${phase}</span>
                <span class="runlog-q">${escapeHtml(e.q)}</span>
            </div>`
        }).join(''))
    })
}

function renderLastRun() {
    chrome.runtime.sendMessage({ type: 'getRuns' }, (runs) => {
        const el = $(config.domElements.lastRunLabel)
        if (!el) return
        const r = runs?.[0]
        if (!r) return el.text('')
        const mins = Math.max(1, Math.round((r.durationMs ?? 0) / 60000))
        const when = new Date(r.at)
        const hh = String(when.getHours()).padStart(2, '0')
        const mm = String(when.getMinutes()).padStart(2, '0')
        el.text(`last run: ${r.searches} searches in ~${mins} min (${hh}:${mm})`)
    })
}

// ---------------------------------------------------------------------------
// Notifications & diagnostics
// ---------------------------------------------------------------------------
function flash(textSelector, panelSelector, message) {
    // $() on a missing selector is a silent no-op, which made completion
    // messages vanish: always resolve the text node explicitly.
    const textEl = textSelector ? $(config.domElements[textSelector]) : $(panelSelector).find('span').first()
    if (message) textEl.text(message)
    const el = $(panelSelector)
    el.css('display', 'block').addClass('show')
    clearTimeout(flash._t)
    flash._t = setTimeout(() => {
        el.removeClass('show')
        setTimeout(() => el.css('display', 'none'), 200)
    }, 4000)
}

function showError(message) {
    flash('errorText', config.domElements.errorNotification, message)
}

function showSuccess(message) {
    flash('saveText', config.domElements.saveNotification, message)
}

function showPanel(visible) {
    const el = $(config.domElements.diagnosticsPanel)
    el.toggleClass('show', visible)
    el.css('display', visible ? 'block' : 'none')
}

function renderDiagnostics(d) {
    if (!d) return
    showPanel(true)

    const rows = [
        row('Status', `<strong class="${d.ok ? 'text-success' : 'text-danger'}">${d.ok ? 'OK' : 'FAILED'}</strong>`),
        row('Expected', `<strong>${escapeHtml(d.phase)}</strong>`),
    ]
    if (d.userAgent) {
        const short = d.userAgent.length > 46 ? d.userAgent.slice(0, 46) + '…' : d.userAgent
        rows.push(row('User agent', `<strong class="text-end" style="font-size:.7rem">${escapeHtml(short)}</strong>`))
    }
    if (d.devicePixelRatio !== undefined) rows.push(row('Pixel ratio', `<strong>${d.devicePixelRatio}</strong>`))
    if (d.touch !== undefined) rows.push(row('Touch', `<strong>${d.touch ? 'enabled' : 'off'}</strong>`))
    if (d.viewportWidth !== undefined) rows.push(row('Viewport', `<strong>${d.viewportWidth}px</strong>`))
    if (d.error) rows.push(`<div class="text-danger mt-2" style="font-size:.72rem">${escapeHtml(d.error)}</div>`)

    $(config.domElements.diagnosticsBody).html(rows.join(''))
}

function row(label, value) {
    return `<div class="d-flex justify-content-between"><span>${escapeHtml(label)}</span>${value}</div>`
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ))
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
// Settings must never be an event object: a mistake here silently overwrites
// the saved configuration and empties every form field.
function isSettingsLike(v) {
    return !!v && typeof v === 'object'
        && Number.isFinite(Number(v.desktop ?? v.desktopSearches))
        && Number.isFinite(Number(v.mobile ?? v.mobileSearches))
}

function saveConfigurationToStorage(settings, { quiet = false } = {}) {
    const s = isSettingsLike(settings) ? settings : readSettings()
    writeSettings(s)
    config.searches = s
    chrome.storage.local.set({ rewardsSearchConfig: s }, () => {
        if (chrome.runtime.lastError) {
            showError('Could not save the configuration.')
            return
        }
        if (!quiet) showSuccess('Configuration saved.')
    })
}

function loadConfigurationFromStorage() {
    chrome.storage.local.get(['rewardsSearchConfig'], (result) => {
        const saved = result.rewardsSearchConfig
        if (!saved) return
        config.searches = { ...config.searches, ...saved }
        writeSettings(config.searches)
    })
}

// ---------------------------------------------------------------------------
// Run state on open
// ---------------------------------------------------------------------------
function checkRunningState() {
    chrome.runtime.sendMessage({ type: 'getState' }, (response) => {
        if (chrome.runtime.lastError || !response) return
        if (response.totalKeywords) {
            $(config.domElements.keywordPoolLabel).text(`${response.totalKeywords} keywords loaded`)
        }
        if (!response.isRunning) {
            activateForms()
            return
        }

        deactivateForms()
        setProgress(response.totalOverall
            ? Math.round((response.doneOverall / response.totalOverall) * 100)
            : 0)
        setProgressLabel(
            response.phase === 'mobile' ? 'Mobile' : 'Desktop',
            response.currentSearch,
            response.totalSearches
        )
        progressState = {
            nextSearchAt: response.nextSearchAt,
            doneOverall: response.doneOverall,
            totalOverall: response.totalOverall,
        }
        updateCountdown()
        if (response.diagnostics) renderDiagnostics(response.diagnostics)
    })
}

// ---------------------------------------------------------------------------
// Form enable/disable
// ---------------------------------------------------------------------------
const FORM_KEYS = [
    'desktopButton', 'mobileButton', 'desktopMobileButton',
    'totDesktopSearchesForm', 'totMobileSearchesForm',
    'waitingBetweenSearchesFormMin', 'waitingBetweenSearchesFormMax',
    'presetQuick', 'presetDaily', 'presetHeavy', 'saveConfigButton',
]

function deactivateForms() {
    for (const key of FORM_KEYS) $(config.domElements[key]).prop('disabled', true)
    $(config.domElements.stopButton).prop('disabled', false).css('display', 'flex')
}

function activateForms() {
    for (const key of FORM_KEYS) $(config.domElements[key]).prop('disabled', false)
    $(config.domElements.stopButton).prop('disabled', true).css('display', 'none')
}
