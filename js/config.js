let config = {
    general: {
        appVersion: "v2.4.0",
        authorWebsiteLink: "https://andreacorriga.com",
        authorWebsiteLinkThanks: [
            "https://rewards.bing.com/"
        ],
        repositoryGithubLink: "https://github.com/AsoStrife/Rewards-Search-Automator",
        storeLink: "https://chromewebstore.google.com/detail/rewards-search-automator/paohfpjfibchbhbkdnlhjpfblafifehg?hl=it",
        rewardsLink: "https://rewards.microsoft.com/",
    },
    bing: {
        url: "https://bing.com/search?q={q}&form={form}",
        form: "QBRE"
    },

    devices: {
        phone: {
            title: "Samsung Galaxy S21",
            model: "SM-S908B",
            width: 360,
            height: 800,
            deviceScaleFactor: 3,
            userAgent: "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
            acceptLanguage: "en-US,en;q=0.9",
            touch: true,
            mobile: true
        },
        desktop: {
            title: "Dell Xps 15",
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            acceptLanguage: "en-US,en;q=0.9",
            touch: false,
            mobile: false
        }
    },

    searches: {
        millisecondsMin: 8000,
        millisecondsMax: 15000,
        desktop: 45,
        mobile: 15
    },

    // Quick / Daily / Heavy. `desktop` and `mobile` are search counts.
    presets: {
        quick: { label: 'Quick', desktop: 15, mobile: 5, millisecondsMin: 8000, millisecondsMax: 12000 },
        daily: { label: 'Daily', desktop: 45, mobile: 15, millisecondsMin: 8000, millisecondsMax: 15000 },
        heavy: { label: 'Heavy', desktop: 80, mobile: 25, millisecondsMin: 10000, millisecondsMax: 20000 }
    },

    limits: {
        maxSearches: 90,
        minDelayMs: 1000,
        maxDelayMs: 600000,
        maxConsecutiveFailures: 5,
        historySize: 60
    },

    domElements: {
        desktopButton: '#desktopButton',
        mobileButton: '#mobileButton',
        desktopMobileButton: '#desktopMobileButton',
        stopButton: '#stopButton',
        presetQuick: '#presetQuick',
        presetDaily: '#presetDaily',
        presetHeavy: '#presetHeavy',
        totDesktopSearchesForm: '#totDesktopSearchesForm',
        totMobileSearchesForm: '#totMobileSearchesForm',
        waitingBetweenSearchesFormMin: '#waitingBetweenSearchesFormMin',
        waitingBetweenSearchesFormMax: '#waitingBetweenSearchesFormMax',
        appVersion: "#appVersion",
        authorWebsiteLink: "#authorWebsiteLink",
        repositoryGithubLink: "#repositoryGithubLink",
        storeLink: "#storeLink",
        rewardsLink: "#rewardsLink",
        f1PromoLink: "#btn-f1-promo",
        progressBar: ".progress-bar",
        progressLabel: "#progressLabel",
        countdownLabel: "#countdownLabel",
        etaLabel: "#etaLabel",
        keywordPoolLabel: "#keywordPoolLabel",
        saveConfigButton: "#saveConfigButton",
        saveNotification: "#saveNotification",
        saveText: "#saveText",
        errorNotification: "#errorNotification",
        errorText: "#errorText",
        diagnosticsPanel: "#diagnosticsPanel",
        diagnosticsBody: "#diagnosticsBody",
        checkEmulationButton: "#checkEmulationButton",
        runLog: "#runLog",
        runLogHead: "#runLogHead",
        lastRunLabel: "#lastRunLabel",
        statsToday: "#statsToday",
        statsStreak: "#statsStreak",
        statsTotal: "#statsTotal",
        clearStatsButton: "#clearStatsButton"
    }
}

export default config
