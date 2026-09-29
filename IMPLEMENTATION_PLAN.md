# Rewards Search Automator — Implementation Plan & Status

Mục tiêu: làm extension **đáng tin cậy và ổn định** (không mất state, không rò debugger, không tạo traffic rác). Tài liệu này không đề cập tới việc né tránh phát hiện hay tối ưu hóa cho mục đích vượt rào.

> Lưu ý thực tế: Microsoft Rewards **cấm** tìm kiếm tự động trong Điều khoản dịch vụ. Mọi công cụ loại này đều có rủi ro khoá tài khoản. Kế hoạch dưới đây chỉ giải quyết chất lượng kỹ thuật, không phải việc tối ưu hóa rủi ro.

---

## Trạng thái

Phase 1–2 và 4 đã triển khai xong, có test. Phase 3, 5 còn nợ.

| Hạng mục | Trạng thái |
|---|---|
| Manifest | MV3, service worker dạng `type: "module"`, `host_permissions: *.bing.com` |
| Luồng chính | `startSearches` → `runSearch` → timer/alarm → `finishPhase` |
| Nguồn từ khóa | `data/keywords.js` (sinh từ `data/words.js` bởi `tools/build-keywords.js`) |
| State | `searchState` v3, version guard, mirror RAM + `chrome.storage.local` |
| Test | `npm test` — 23 case, 0 fail |

---

## Phase 1 — Lỗi correctness (P0) ✅

### 1.1 Crash khi 30% số lần hoàn tất — **đã sửa**
`openAuthorWebsite()` chọn random giữa `authorWebsiteLinkThanks[0]` và `[1]`, nhưng mảng chỉ có một phần tử → `tabs.update({url: undefined})`. Hàm này đã bị xoá hoàn toàn; vòng lặp dừng ở `completeSearches()`.

### 1.2 `randomDelay()` trả về `NaN` — **đã sửa**
`background.js:randomDelay()` giờ dùng `Number.isFinite` và tự swap min/max. UI cũng clamp trước khi gửi. Test: `inverted min/max is normalised instead of producing NaN`.

### 1.3 Double-resume gây chạy trùng — **đã sửa**
Cả `onStartup` và `onInstalled` giờ gọi chung `resumeIfRunning()`, có cờ `inFlight` chặn re-entry.

### 1.4 Mất UA mobile khi restart — **đã sửa**
`resumeIfRunning()` kiểm tra `state.emulation`; nếu đang ở phase mobile thì re-attach debugger + `applyMobile()` lại trước khi search tiếp.

### 1.5 Silent `chrome.runtime.lastError` — **đã sửa, và đây là nguyên nhân gốc của "mobile không hoạt động"**

Hai lỗi riêng biệt:

1. Mọi `debugger.sendCommand` bỏ qua `lastError`. Giờ tất cả đi qua wrapper `debuggerCall()` duy nhất, reject kèm message.
2. `lastError()` được viết sai: `chrome.runtime.lastError?.message ?? "unknown debugger error"`. Khi **không** có lỗi, hàm vẫn trả về chuỗi truthy → `if (err)` luôn đúng → **mọi lệnh CDP đều bị coi là thất bại**. Test đã bắt được bug này trước khi deploy.

Ngoài ra `attachDebugger()` coi `Another debugger is already attached` là thành công (DevTools đang mở trên tab), các lỗi khác thì fail sạch.

---

## Phase 2 — Vòng đời tab (P0) ✅

- `getTabId()` đã bị xoá. Mọi thao tác dùng `state.tabId`, không query lại tab active.
- `chrome.tabs.onRemoved` → `stopSearches("tab-closed")`, giải phóng debugger.
- `chrome.tabs.onUpdated` → dừng nếu tab rời khỏi `bing.com`.
- `stopSearches()` gọi `loadState()` trước, nên debugger không bị rò sau khi service worker restart.
- `onConnect` disconnect dùng `state.tabId` thay vì tab active.
- `onSuspend` dọn timer.

### Bug mới phát hiện khi test
`loadState()` trước đây `return false` ngay khi storage rỗng mà **không reset state trong RAM** → `isRunning: true` tồn đọng. Tương tự, `startSearches()` tin state trong RAM nên sau worker restart có thể khởi động run thứ hai đè lên run đang chạy. Cả hai đã sửa; test `stale state from an older schema is discarded` phủ.

---

## Phase 3 — Scheduler (P1) ✅ một nửa

### 3.1 Clamp 30 giây của `chrome.alarms` — **đã sửa**
`chrome.alarms` bỏ qua mọi delay dưới 30s kể từ Chrome 120, tức cấu hình 8–10s của người dùng trước đây chưa bao giờ có hiệu lực. Nay:
- delay < 25s → `setTimeout` (service worker sống khi còn timer pending)
- luôn đăng ký `chrome.alarms` làm backstop phục vụ trường hợp worker bị suspend

Test: `a 8s delay uses a timer, not a 30s alarm`.

### 3.2/3.3 Còn nợ
- Giữ service worker sống qua chuỗi `await` dài ở `applyMobile()` chưa có cơ chế keepalive.
- `runSearch()` vẫn tăng `doneInPhase` trước khi ghi state; nếu worker chết giữa chừng thì resume sẽ lệch một nhịp.

---

## Phase 4 — Dữ liệu từ khóa (P1) ✅

### 4.1 Xoá nguồn trùng lặp — **đã sửa**
`data/words.js` (1940 dòng, không ai import) giờ là **input** của generator; `data/keywords.js` là output duy nhất mà code chạy thực sự dùng.

### 4.2 Chuẩn hoá — **đã sửa**

```
raw        1940
dupes       159
>60 ký tự  125
giữ lại    1656  (11 nhóm, 0 trùng lặp)
```

Quy tắc: gộp smart-quote, collapse whitespace, trim, dedupe không phân biệt hoa thường, giới hạn 10–60 ký tự (loại bỏ chuỗi dài kiểu SEO spam).

### 4.3 Cân bằng nhóm — **đã sửa một phần**
Dữ liệu gốc lệch cực nặng: `car` 281, `pets` 234, `entertainment` 231 trên tổng 1656 (~46%), trong khi `travel` chỉ 21, `finance` 31.

Đã chia 11 nhóm và thêm bộ chọn luân phiên nhóm, nên hai từ liên tiếp không cùng chủ đề. **Phần còn nợ:** `travel` và `finance` vẫn thiếu dữ liệu thô — nếu muốn đều thật sự thì phải bổ sung từ khoá cho các nhóm này, không phải chỉ dựa vào logic chia.

### 4.4 Không lặp trong phiên — **đã sửa**
`pickKeyword()` loại các từ đã dùng, ghi `usedKeywords` vào state để resume được. Test chạy 12 search và assert không trùng.

### 4.5 Validate input — **đã sửa**
`validate()` trong background + clamp ở popup (`1..30` search, `1000..600000` ms). Test: `out-of-range input is rejected up front`.

---

## Phase 5 — UX & quan sát (P2) 🔶 một phần

- **Progress bar nhiều phase** — **đã sửa**: tính trên tổng `doneOverall/totalOverall`, kèm nhãn `Desktop 2/3`.
- **Panel diagnostics** — **đã sửa**. Sau khi vào mobile mode, worker `Runtime.evaluate` đọc lại `navigator.userAgent`, `devicePixelRatio`, touch, viewport rồi báo OK/FAILED. Đây là thứ biến "mobile không hoạt động" từ im lặng thành lỗi nhìn thấy được. Nút **Check emulation** chạy lại probe bất cứ lúc nào.
- **cvid rỗng** — **đã sửa**: `cvid` giờ lấy từ URL Bing hiện tại rồi dùng lại cho cả run; nếu không có thì **bỏ hẳn khỏi query string** thay vì gửi `cvid=`.
- **Log debug** — **đã sửa**: `const DEBUG = false` ở đầu `background.js`.
- **`host_permissions`** — **đã sửa**: khai báo `https://*.bing.com/*`.
- **Xoá `js/event.js`** — file rỗng, không ai import.

---

## Bug tìm được trong v2.3–v2.4

| # | Bug | Hậu quả | Test phủ |
|---|---|---|---|
| 1 | `lastError()` trả chuỗi truthy khi không lỗi | **mọi** lệnh CDP bị coi là thất bại | `lastError() cannot report a phantom failure` |
| 2 | `loadState()` không reset state khi storage rỗng | `isRunning` tồn đọng, chặn run sau | `stale state from an older schema is discarded` |
| 3 | `startSearches` tin state RAM | worker restart → chạy 2 run chồng nhau | `settings accept both key spellings` |
| 4 | `stopSearches` không `loadState()` | rò debugger sau restart | `stopping detaches the debugger` |
| 5 | `pickKeyword` trả object | query ra chuỗi `[object Object]` | `search URL keeps Bing's session id` |
| 6 | popup gửi `desktop`, background đọc `desktopSearches` | validate luôn fail | `settings accept both key spellings` |
| 7 | `pop()` từ cuối deck round-robin | 40 search cuối rơi hết 1 category | `keywords rotate category` |
| 8 | retry trong 1 lần gọi | tab hỏng → loop vô hạn | `repeated failures stop the run` |
| 9 | `recordRun` ghi vào mảng của log search | popup render dòng trống | `run summaries are kept out of the per-search log` |
| 10 | `nextKeyword` có thể trả `undefined` | search chuỗi `"undefined"` | `no empty query can escape` |
| 11 | `flash()` với selector `null` | message hoàn thành **không bao giờ hiện** | — |
| 12 | `setEta(0)` return sớm | run xong vẫn hiện "còn N phút" | — |
| 13 | preset không persist | chọn preset rồi đóng popup mất | — |
| 14 | `ownNavigation` là cửa sổ thời gian 5s | user detour trong lúc Bing load bị bỏ sót | `the extension's own navigation never trips the guard` |
| 15 | watchdog dựa vào handle timer trong RAM | vô dụng sau suspension | `the watchdog recovers a run whose timer was lost` |

---

## Đã trả hết nợ

```
[x] keepalive service worker qua chuỗi await dài
    startKeepAlive(): ping API mỗi 20s, chỉ khi có run. stopKeepAlive() khi
    complete/stop. Test: keep-alive is armed on start and cleared on stop

[x] idempotency + hồi phục khi mất timer
    counter lưu trước khi arm timer; lastSearchAt chặn watchdog chạy lại
    nhúng bước vừa xong. Watchdog: quá hạn <2 phút → chạy tiếp; >2 phút →
    stop("stalled"). Test: watchdog recovers / watchdog gives up

[x] cân bằng dữ liệu từ khóa
    data/seeds.js: 194 từ cho travel/finance/education/health/cooking
    travel 21→60, finance 31→70, general 24.9%→20.2%
    Test: no category is starved

[x] test cho tabs.onUpdated (navigated-away)
    + test tab-closed qua listener thật thay vì gián tiếp
    Test: navigating the tab away from bing stops the run

[x] pre-commit gate
    node tools/install-hooks.js — không dependency, chạy npm run check
    (đã cài tại .git/hooks/pre-commit)

[x] serialize ghi storage
    mutateJson() đưa mọi read-modify-write của history/runs qua 1 hàng đợi
    promise, tránh mất entry khi hai writer chồng nhau

[x] test reproducibility của generator
    Test: regenerating the dataset is reproducible
```

---

## Kiểm chứng

```bash
npm test             # 44 case
npm run check:ui     # selector
npm run check        # cả hai
```

Bộ test mô phỏng lớp CDP thật chứ không stub, nên hỏng hát lặp lại ở phase
mobile sẽ làm đỏ suite thay vì hỏng âm thầm trong trình duyệt. Chạy lặp lại
nhiều lần cho kết quả giống nhau.

## Định nghĩa "xong"

- [x] Không còn URL `undefined`, delay `NaN`, query rỗng, hay lệnh CDP không kiểm tra lỗi
- [x] Đóng tab / restart browser giữa chừng: tự dọn debugger, state nhất quán, không chạy trùng
- [x] Kill Chrome giữa phase mobile rồi mở lại: phase đó vẫn chạy đúng UA mobile
- [x] Worker bị suspend giữa run: watchdog phục hồi, không treo
- [x] Không dùng lại từ đã tìm trong cùng phiên, không trùng chủ đề liền nhau
- [x] Cấu hình delay người dùng nhập được áp dụng đúng như hiển thị
- [x] Trạng thái mobile sai hiện ra rõ ràng trong UI thay vì im lặng
- [x] Dữ liệu từ khóa cân bằng, không nhóm nào bị bỏ đói
- [x] Mọi message hoàn thành/lỗi thực sự hiển thị lên UI
