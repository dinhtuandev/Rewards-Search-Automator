<div align="center">

# 🏆 Rewards Search Automator

<img src="https://raw.githubusercontent.com/AsoStrife/Rewards-Search-Automator/47d130ff07c6fe779984987cdcdbe747fd244ac9/img/icon128.png" alt="Rewards Search Automator Logo" width="128">

### Automate your Bing searches to earn Microsoft Rewards points effortlessly!

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-blue?style=for-the-badge&logo=googlechrome)](https://chromewebstore.google.com/u/3/detail/paohfpjfibchbhbkdnlhjpfblafifehg/preview?hl=it)
[![Version](https://img.shields.io/badge/version-2.0.0-green?style=for-the-badge)](https://github.com/AsoStrife/Rewards-Search-Automator/releases)
[![License](https://img.shields.io/badge/license-MIT-orange?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/AsoStrife/Rewards-Search-Automator?style=for-the-badge&logo=github)](https://github.com/AsoStrife/Rewards-Search-Automator/stargazers)

[🚀 Features](#-features) • [📦 Installation](#-installation) • [🎯 Usage](#-usage) • [⚙️ Configuration](#️-configuration) • [🤝 Support](#-support)

---

</div>

## 📖 About

**Rewards Search Automator** is a powerful Chrome/Edge extension designed to help you maximize your **Microsoft Rewards** points by automating Bing searches. Whether you're on desktop or mobile, this extension handles the tedious task of performing daily searches, so you can focus on redeeming your rewards!

✨ **Completely free** • 🚫 **No ads** • 🔒 **Privacy-focused** • 🎨 **Modern UI**

<div align="center">
<img src="https://raw.githubusercontent.com/AsoStrife/Rewards-Search-Automator/fcf4a996ef7f3cfcbfaac59a53a27dd36abbb48b/img/preview-big.png" alt="Extension Preview" width="600">
</div>

---

## ✨ Features

### 🖥️ **Desktop & Mobile Search Automation**
- Perform automated searches on both desktop and mobile user agents
- Smart device emulation for accurate mobile searches
- Separate or combined search modes

### ⚡ **Customizable Settings**
- **Presets**: Quick (15/5), Daily (45/15), Heavy (80/25)
- **Adjustable search count**: up to 90 per phase
- **Random delays**: customize minimum and maximum wait times between searches
- **Real-time progress**: progress bar, phase counter, countdown to the next
  search, and estimated time remaining
- **Run log**: every query with timestamp and device badge, plus last-run summary
- **Stats**: searches today, day streak, all-time total

### 🎨 **Modern User Interface**
- Beautiful gradient design with smooth animations
- Compact popup that fits perfectly in your browser
- Intuitive controls with clear visual feedback
- **Stop button** that appears only while a run is active
- Responsive layout

### 🔐 **Safe & Reliable**
- 1,656 keyword pool split across 11 categories, no repeat inside a run
- Queries rotate category, so consecutive searches are never the same topic
- Randomised timing to mimic human behaviour
- A failed navigation is retried; 5 consecutive failures stop the run cleanly
- No data collection or tracking
- Open-source and transparent

---

## 📦 Installation

### Option 1: Chrome Web Store (Recommended)
1. Visit the [Chrome Web Store listing](https://chromewebstore.google.com/detail/rewards-search-automator/paohfpjfibchbhbkdnlhjpfblafifehg?hl=it)
2. Click **"Add to Chrome"**
3. Confirm the installation
4. The extension icon will appear in your toolbar

### Option 2: Manual Installation (Developer Mode)
1. Download or clone this repository:
   ```bash
   git clone https://github.com/AsoStrife/Rewards-Search-Automator.git
   ```
2. Open Chrome/Edge and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **"Load unpacked"**
5. Select the extension folder
6. The extension is now installed!

---

## 🎯 Usage

### Quick Start
1. Click the extension icon in your browser toolbar
2. Configure your preferences (optional):
   - **Desktop searches**: Number of desktop searches (default: 3)
   - **Mobile searches**: Number of mobile searches (default: 3)
   - **Min/Max delay**: Wait time between searches in milliseconds (default: 8000-10000ms)
3. Choose your automation mode:
   - 🖥️ **Desktop**: Desktop searches only
   - 📱 **Mobile**: Mobile searches only
   - 📊 **Both**: Desktop followed by mobile searches
4. Watch the progress bar and let the automation do its magic!

### Pro Tips
- **Daily routine**: Run the extension once per day to maximize rewards
- **Natural timing**: Keep delays between 8-15 seconds for more realistic behavior
- **Combined mode**: Use "Both" mode to complete all daily searches in one go
- **Check progress**: The progress bar shows real-time completion status

---

## ⚙️ Configuration

### Defaults
```javascript
Desktop Searches: 45
Mobile Searches: 15
Min Delay: 8000ms
Max Delay: 15000ms
```

### Presets
| Preset | Desktop | Mobile | Delay |
|---|---|---|---|
| Quick | 15 | 5 | 8–12s |
| Daily | 45 | 15 | 8–15s |
| Heavy | 80 | 25 | 10–20s |

All four values can be edited directly and saved. Anything outside
`1..90` searches or below `1000` ms is clamped in the popup and rejected by the
background worker.

### Keyword dataset

`data/keywords.js` is generated from two inputs by `npm run build:keywords`:

- `data/words.js` — the original flat list, left untouched
- `data/seeds.js` — top-up queries for the categories the original left thin;
  a seed keeps the category it declares instead of being re-inferred

Normalisation applied: smart-quote folding, whitespace collapse, trim,
case-insensitive dedupe, length band 10–60 characters.

```
input     2134  (1940 base + 194 seeds)
dupes      159
>60 chars  125
kept      1850  across 11 categories, 0 duplicates
```

| Category | Count | Share |
|---|---|---|
| general | 373 | 20.2% |
| automotive | 281 | 15.2% |
| pets | 234 | 12.6% |
| entertainment | 231 | 12.5% |
| home | 168 | 9.1% |
| health | 114 | 6.2% |
| education | 110 | 5.9% |
| tech | 105 | 5.7% |
| cooking | 104 | 5.6% |
| finance | 70 | 3.8% |
| travel | 60 | 3.2% |

Before seeding, `travel` held 21 keywords (1.3%) and `general` held 22.5% of
the pool. Both are asserted in the test suite.

Queries are drawn from a deck filled round-robin across categories, so two
consecutive searches can never land in the same topic. The deck is built once
and consumed by index, so picking a keyword is O(1).

---

## 🛠️ Technical Details

- **Manifest Version**: 3 (Latest Chrome extension standard)
- **Permissions**: `debugger` (mobile device emulation), `tabs`, `alarms`, `storage`, host access to `*.bing.com`
- **Technologies**: JavaScript (ES6+ modules), jQuery, Bootstrap 5, Font Awesome
- **Compatible with**: Chrome, Edge, Brave, and other Chromium-based browsers

### Keyword dataset

`data/keywords.js` is generated from the legacy `data/words.js` by
`npm run build:keywords`. Normalisation applied:

- smart-quote folding (`'` `"` → `'` `"`)
- whitespace collapse + trim
- case-insensitive dedupe
- length band 10–60 characters (drops SEO-stuffed strings)
- bucketed into 11 categories

The picker avoids repeating a query within a run and rotates category between
searches, so consecutive queries do not all land in the same topic.

Edit `tools/build-keywords.js` if you want to change the rules, then regenerate.

### Delay behaviour

`chrome.alarms` clamps any delay below 30 seconds (Chrome 120+). Delays under
25 seconds therefore run on a service-worker timer, with the alarm kept only as
a backstop in case the worker is suspended. The value you type is the value that
is applied.

### Emulation self-check

Mobile emulation silently failing is the most common failure mode, because a
failed CDP command is not distinguishable from a successful one. After entering
mobile mode the worker reads back what the page actually sees (`navigator.userAgent`,
`devicePixelRatio`, touch support, viewport width) and shows the result in the
popup. Use **Check emulation** to re-run the probe at any time.

If the panel reports `FAILED`, close DevTools on the automation tab — an open
DevTools window holds the debugger and blocks `Network.setUserAgentOverride`.

### Reliability internals

- **Keep-alive**: an MV3 worker is torn down after ~30s idle, which can land
  mid-way through a chain of awaited debugger calls. A run arms a 20s API ping
  for its duration.
- **Watchdog**: a repeating 30s alarm recovers a run whose timer was lost by
  suspension, and gives up on a run that is more than 2 minutes overdue so it
  cannot spin forever.
- **Idempotency**: the counter is persisted before the next timer is armed, and
  `lastSearchAt` stops the watchdog re-running the step it just finished.
- **Write serialisation**: history and stats go through one promise queue, so
  two overlapping read-modify-write cycles cannot drop entries.
- **One-shot navigation flag**: the `tabs.onUpdated` guard consumes a single
  event caused by the extension's own navigation, so a Bing redirect is not
  mistaken for a user detour.

### Development

```bash
npm test             # 44 behaviour + invariant tests against a chrome.* mock
npm run check:ui     # every config.domElements selector resolves in index.html
npm run check        # both
npm run hooks:install  # dependency-free pre-commit gate running npm run check
```

`npm test` runs the real emulation code paths against a mocked CDP layer, so
regressions in the mobile path fail the suite rather than failing silently in
the browser. The suite is deterministic and safe to run repeatedly.

### Storage keys
| Key | Contents |
|---|---|
| `searchState` | live run state (versioned, dropped on schema change) |
| `rewardsSearchConfig` | the settings you saved in the popup |
| `rsaHistory` | per-search log entries (`q`, `phase`, `at`) |
| `rsaRuns` | run summaries (`searches`, `type`, `durationMs`) |
| `rsaStats` | per-day counters plus streak |

`rsaHistory` and `rsaRuns` are deliberately separate: mixing them makes the run
log render summary rows as blank queries.

---

## 🤝 Support

### 💖 Show Your Support

If this extension has helped you earn more Microsoft Rewards points, please consider:

<div align="center">

[![Star this repo](https://img.shields.io/badge/⭐-Star%20this%20repo-yellow?style=for-the-badge&logo=github)](https://github.com/AsoStrife/Rewards-Search-Automator)
[![Donate via PayPal](https://img.shields.io/badge/💰-Donate%20via%20PayPal-blue?style=for-the-badge&logo=paypal)](https://paypal.me/AsoStrife)

**Your support keeps this project alive and helps fund future updates!** ✨

</div>

### 📬 Connect With The Author

- 🌐 **Personal Website**: [andreacorriga.com](https://andreacorriga.com)
- 🏢 **Company**: [Strifelab](https://strifelab.com)
- 💼 **GitHub**: [@AsoStrife](https://github.com/AsoStrife)

### 🐛 Found a Bug?

Please [open an issue](https://github.com/AsoStrife/Rewards-Search-Automator/issues) with:
- Detailed description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Browser version and OS

### 💡 Feature Requests

Have an idea to improve the extension? [Create a feature request](https://github.com/AsoStrife/Rewards-Search-Automator/issues/new) and let's discuss it!

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This extension is an independent project and is **not affiliated with, endorsed by, or connected to Microsoft Corporation** or the Microsoft Rewards program. Use this tool responsibly and in accordance with Microsoft Rewards terms of service. The author is not responsible for any account actions taken by Microsoft.

---

<div align="center">

### 🌟 If you like this project, don't forget to give it a star! 🌟

Made with ❤️ by [Andrea Corriga](https://andreacorriga.com) | [Strifelab](https://strifelab.com)

[![GitHub followers](https://img.shields.io/github/followers/AsoStrife?style=social)](https://github.com/AsoStrife)
[![GitHub stars](https://img.shields.io/github/stars/AsoStrife/Rewards-Search-Automator?style=social)](https://github.com/AsoStrife/Rewards-Search-Automator/stargazers)

</div>