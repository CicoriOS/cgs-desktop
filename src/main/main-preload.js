"use strict";
// Injects into ompweb's DOM:
//   1. Minimize / maximize-restore / close window controls, immediately right of `button.shell-panel-opener`
//      inside `[data-topbar-right-group]` (or floating at top-right on narrow/loading layouts).
//   2. Brand and tier display; the CGS account card and sign-in entry (below).
//   3. Branding (always, signed in or not): ompweb's mark and name are replaced by the CGS logo and "CGS Desktop", and an
//      accent-colour stylesheet (the new-api console purple) overrides ompweb's accent variables.
//   4. First-run default theme "system" (only when the user has not chosen one).
//   5. ompweb's `omp-*` localStorage prefs (language, theme, font size, UI scale, usage-widget prefs, ...) are mirrored
//      in <userData>/web-prefs.json: restored before ompweb's scripts run, deltas sent back, so they survive an origin
//      (port) change on top of the stable port from services.choosePort.
//   6. While signed in: a compact CGS balance/subscription row above the Settings footer in ompweb's sidebar ("PAYG" when
//      there is no subscription) and a CGS account card at the top of Settings → Usage (`#settings-panel-usage`), fed by
//      the main process (`/api/device/usage`: every 5 min, on window focus, manual refresh). ompweb's cost figures in
//      that panel are shown in CNY (the CGS models are priced in yuan).
//   7. Settings → Agents: the orchestrator (main model + one model per subagent, config.yml), see ensureOrchestratorCard.
//   8. Self-update: a card in Settings → System and a banner once an update is downloaded (updater.js).
// Everything injected follows ompweb's language (`<html lang>`): see STRINGS / t().
const { contextBridge, ipcRenderer } = require("electron");

const ROOT_ID = "cgs-window-controls";
const OVERLAY_ID = "cgs-overlay-root";
const STYLE_ID = "cgs-window-controls-style";
const THEME_STYLE_ID = "cgs-theme-style";
const OPENER_SELECTOR = "[data-topbar-right-group] button.shell-panel-opener";
const USAGE_PANEL_SELECTOR = "#settings-panel-usage";
const SETTINGS_ROW_SELECTOR = "button.sidebar-settings-row";
const USAGE_ROW_ID = "cgs-usage-row";
const USAGE_CARD_ID = "cgs-usage-card";
// ompweb's brand mark (components/OmpWebLogo.tsx): <svg role="img" viewBox="0 0 64 64">.
const OMP_LOGO_SELECTOR = 'svg[role="img"][viewBox="0 0 64 64"]';
const BRAND_NAME = "CGS Desktop";
const LOGO_SCALE = 1.25;

// ---- i18n -------------------------------------------------------------------------------------------------------------
// Follows ompweb's own language (it sets <html lang> to "en" | "zh-CN" | "zh-TW" | "ja", from localStorage "omp-lang").
const LOCALES = ["en", "zh-CN", "zh-TW", "ja"];

function locale() {
  const lang = (document.documentElement && document.documentElement.lang) || "";
  if (LOCALES.includes(lang)) return lang;
  const low = (lang || navigator.language || "").toLowerCase();
  if (low.startsWith("zh")) return /^zh-(tw|hk|mo|hant)\b/.test(low) ? "zh-TW" : "zh-CN";
  if (low.startsWith("ja")) return "ja";
  return "en";
}

/* eslint-disable quote-props */
const STRINGS = {
  "win.minimize": { en: "Minimize", "zh-CN": "最小化", "zh-TW": "最小化", ja: "最小化" },
  "win.maximize": { en: "Maximize", "zh-CN": "最大化", "zh-TW": "最大化", ja: "最大化" },
  "win.restore": { en: "Restore", "zh-CN": "还原", "zh-TW": "還原", ja: "元に戻す" },
  "win.close": { en: "Close", "zh-CN": "关闭", "zh-TW": "關閉", ja: "閉じる" },
  "tier.dedicated": { en: "Dedicated", "zh-CN": "独享", "zh-TW": "獨享", ja: "専用" },
  "plan.noSubscription": { en: "No subscription", "zh-CN": "无订阅", "zh-TW": "無訂閱", ja: "サブスクなし" },
  "plan.subscription": { en: "Subscription", "zh-CN": "订阅", "zh-TW": "訂閱", ja: "サブスク" },
  "plan.subscriptionN": { en: "Subscription #{id}", "zh-CN": "订阅 #{id}", "zh-TW": "訂閱 #{id}", ja: "サブスク #{id}" },
  "usage.balance": { en: "Balance", "zh-CN": "余额", "zh-TW": "餘額", ja: "残高" },
  "usage.unlimited": { en: "Unlimited", "zh-CN": "不限量", "zh-TW": "不限量", ja: "無制限" },
  "usage.used": { en: "Used {used}", "zh-CN": "已用 {used}", "zh-TW": "已用 {used}", ja: "使用済み {used}" },
  "usage.usedUnlimited": { en: "Used {used} (unlimited)", "zh-CN": "已用 {used}（不限量）", "zh-TW": "已用 {used}（不限量）", ja: "使用済み {used}（無制限）" },
  "usage.resetsIn": { en: "Resets {when}", "zh-CN": "{when}重置", "zh-TW": "{when}重置", ja: "{when}にリセット" },
  "usage.expiresOn": { en: "Expires {date}", "zh-CN": "{date} 到期", "zh-TW": "{date} 到期", ja: "{date} に期限切れ" },
  "usage.dailyLimitsSummary": { en: "Daily limits: {count} models · peak {pct}", "zh-CN": "日限额 {count} 个模型 · 最高 {pct}", "zh-TW": "日限額 {count} 個模型 · 最高 {pct}", ja: "日次上限 {count} モデル · 最大 {pct}" },
  "usage.stale": { en: "Data may be out of date", "zh-CN": "数据可能已过期", "zh-TW": "資料可能已過期", ja: "データが古い可能性があります" },
  "usage.staleAt": { en: "Data may be out of date (last updated {time})", "zh-CN": "数据可能已过期（上次更新 {time}）", "zh-TW": "資料可能已過期（上次更新 {time}）", ja: "データが古い可能性があります（最終更新 {time}）" },
  "usage.refresh": { en: "Refresh CGS usage", "zh-CN": "刷新 CGS 用量", "zh-TW": "重新整理 CGS 用量", ja: "CGS 使用量を更新" },
  "usage.cardTitle": { en: "CGS account & subscription", "zh-CN": "CGS 账户与订阅", "zh-TW": "CGS 帳戶與訂閱", ja: "CGS アカウントとサブスク" },
  "usage.updatedAt": { en: "Updated {time}", "zh-CN": "更新于 {time}", "zh-TW": "更新於 {time}", ja: "{time} 更新" },
  "usage.loading": { en: "Loading usage…", "zh-CN": "正在获取用量…", "zh-TW": "正在取得用量…", ja: "使用量を取得中…" },
  "usage.unavailable": { en: "Usage is unavailable right now; refresh later with the button above.", "zh-CN": "暂时无法获取用量数据，请稍后点击右上角刷新。", "zh-TW": "暫時無法取得用量資料，請稍後點擊右上角重新整理。", ja: "現在使用量を取得できません。後で右上のボタンで更新してください。" },
  "usage.payg": { en: "No active subscription: billed pay-as-you-go from the balance.", "zh-CN": "暂无生效中的订阅，按余额计费。", "zh-TW": "暫無生效中的訂閱，依餘額計費。", ja: "有効なサブスクはありません。残高から従量課金されます。" },
  "usage.usedOf": { en: "Used {used} / {total}", "zh-CN": "已用 {used} / {total}", "zh-TW": "已用 {used} / {total}", ja: "使用済み {used} / {total}" },
  "usage.usedUnlimitedShort": { en: "Used {used} · unlimited", "zh-CN": "已用 {used} · 不限量", "zh-TW": "已用 {used} · 不限量", ja: "使用済み {used} · 無制限" },
  "usage.nextReset": { en: "Next reset {at} ({when})", "zh-CN": "下次重置 {at}（{when}）", "zh-TW": "下次重置 {at}（{when}）", ja: "次回リセット {at}（{when}）" },
  "usage.expires": { en: "Expires {date}", "zh-CN": "到期 {date}", "zh-TW": "到期 {date}", ja: "期限 {date}" },
  "usage.noExpiry": { en: "No expiry", "zh-CN": "长期有效", "zh-TW": "長期有效", ja: "無期限" },
  "usage.dailyTokenLimits": { en: "Daily token limits", "zh-CN": "每日 Token 限额", "zh-TW": "每日 Token 限額", ja: "1 日のトークン上限" },
  "usage.limitUnlimited": { en: "{used} · unlimited", "zh-CN": "{used} · 不限量", "zh-TW": "{used} · 不限量", ja: "{used} · 無制限" },
  "usage.resetsAt": { en: "Resets {at}", "zh-CN": "{at} 重置", "zh-TW": "{at} 重置", ja: "{at} にリセット" },
  "reset.never": { en: "Never resets", "zh-CN": "不重置", "zh-TW": "不重置", ja: "リセットなし" },
  "reset.daily": { en: "Resets daily", "zh-CN": "每日重置", "zh-TW": "每日重置", ja: "毎日リセット" },
  "reset.weekly": { en: "Resets weekly", "zh-CN": "每周重置", "zh-TW": "每週重置", ja: "毎週リセット" },
  "reset.monthly": { en: "Resets monthly", "zh-CN": "每月重置", "zh-TW": "每月重置", ja: "毎月リセット" },
  "reset.custom": { en: "Resets per period", "zh-CN": "按周期重置", "zh-TW": "依週期重置", ja: "期間ごとにリセット" },
  "time.soon": { en: "soon", "zh-CN": "即将", "zh-TW": "即將", ja: "まもなく" },
  "time.minutes": { en: "in {n} min", "zh-CN": "{n} 分钟后", "zh-TW": "{n} 分鐘後", ja: "{n} 分後" },
  "time.hours": { en: "in {n} h", "zh-CN": "{n} 小时后", "zh-TW": "{n} 小時後", ja: "{n} 時間後" },
  "time.days": { en: "in {n} days", "zh-CN": "{n} 天后", "zh-TW": "{n} 天後", ja: "{n} 日後" },
  "cost.title": { en: "CGS cost (CNY)", "zh-CN": "CGS 费用（人民币）", "zh-TW": "CGS 費用（人民幣）", ja: "CGS 料金（人民元）" },
  "cost.note": { en: "* at CGS prices, in CNY", "zh-CN": "* 按 CGS 实际价格计算（人民币）", "zh-TW": "* 依 CGS 實際價格計算（人民幣）", ja: "* CGS の実価格で計算（人民元）" },
  "cost.otherUsd": { en: "+ other providers {amount} (USD)", "zh-CN": "+ 其他提供商 {amount}（美元）", "zh-TW": "+ 其他提供者 {amount}（美元）", ja: "+ 他のプロバイダー {amount}（米ドル）" },
  "pc.logoutTitle": { en: "Sign out of CGS?", "zh-CN": "退出 CGS 账户？", "zh-TW": "登出 CGS 帳戶？", ja: "CGS からサインアウトしますか？" },
  "pc.logoutLabel": { en: "Sign out of CGS", "zh-CN": "退出 CGS 账户", "zh-TW": "登出 CGS 帳戶", ja: "CGS からサインアウト" },
  "pc.logoutP1": { en: "This device's CGS key is revoked on the server and can no longer be used.", "zh-CN": "此设备上的 CGS 密钥将在服务器端吊销，无法再使用。", "zh-TW": "此裝置上的 CGS 金鑰將在伺服器端撤銷，無法再使用。", ja: "このデバイスの CGS キーはサーバー側で失効し、使用できなくなります。" },
  "pc.logoutP2": { en: "The CGS model providers and the model settings that point at them are removed; settings you changed yourself stay.", "zh-CN": "CGS 模型提供方以及指向它们的模型设置将被移除；你自己修改过的其他设置不受影响。", "zh-TW": "CGS 模型提供者以及指向它們的模型設定將被移除；你自己修改過的其他設定不受影響。", ja: "CGS のモデルプロバイダーとそれを指すモデル設定は削除されます。自分で変更した設定はそのまま残ります。" },
  "pc.logoutP3": { en: "You can sign in again at any time.", "zh-CN": "之后可以随时重新登录。", "zh-TW": "之後可以隨時重新登入。", ja: "いつでも再度サインインできます。" },
  "pc.cancel": { en: "Cancel", "zh-CN": "取消", "zh-TW": "取消", ja: "キャンセル" },
  "pc.logout": { en: "Sign out", "zh-CN": "退出账户", "zh-TW": "登出帳戶", ja: "サインアウト" },
  "pc.loggingOut": { en: "Signing out…", "zh-CN": "正在退出…", "zh-TW": "正在登出…", ja: "サインアウト中…" },
  "pc.logoutFailed": { en: "Sign-out failed: {error}", "zh-CN": "退出失败：{error}", "zh-TW": "登出失敗：{error}", ja: "サインアウトに失敗しました: {error}" },
  "pc.unknownError": { en: "unknown error", "zh-CN": "未知错误", "zh-TW": "未知錯誤", ja: "不明なエラー" },
  "pc.notRevoked": { en: "Signed out on this device, but the server key could not be revoked; delete it in the CGS console", "zh-CN": "已在本机退出，但服务器端密钥未能吊销，可在 CGS 后台删除", "zh-TW": "已在本機登出，但伺服器端金鑰未能撤銷，可在 CGS 後台刪除", ja: "このデバイスではサインアウトしましたが、サーバーのキーを失効できませんでした。CGS コンソールで削除してください" },
  "pc.cleanupFailed": { en: "Some local settings could not be cleaned up: {errors}", "zh-CN": "部分本地配置未能清理：{errors}", "zh-TW": "部分本機設定未能清理：{errors}", ja: "一部のローカル設定を削除できませんでした: {errors}" },
  "pc.loggedOut": { en: "Signed out of CGS; the device key was revoked", "zh-CN": "已退出 CGS 账户，设备密钥已吊销", "zh-TW": "已登出 CGS 帳戶，裝置金鑰已撤銷", ja: "CGS からサインアウトし、デバイスキーを失効しました" },
  "pc.connected": { en: "Connected", "zh-CN": "连接正常", "zh-TW": "連線正常", ja: "接続済み" },
  "pc.noUsage": { en: "No usage data yet", "zh-CN": "暂无用量数据", "zh-TW": "暫無用量資料", ja: "使用量データなし" },
  "pc.models": { en: "{id} · {n} models", "zh-CN": "{id} · {n} 个模型", "zh-TW": "{id} · {n} 個模型", ja: "{id} · {n} モデル" },
  "pc.openConsole": { en: "Open CGS console", "zh-CN": "打开 CGS 后台", "zh-TW": "開啟 CGS 後台", ja: "CGS コンソールを開く" },
  "pc.clients": { en: "Manage clients", "zh-CN": "客户端管理", "zh-TW": "用戶端管理", ja: "クライアント管理" },
  "pc.refresh": { en: "Refresh", "zh-CN": "刷新", "zh-TW": "重新整理", ja: "更新" },
  "pc.refreshing": { en: "Refreshing…", "zh-CN": "刷新中…", "zh-TW": "重新整理中…", ja: "更新中…" },
  "pc.keyRejected": { en: "Key rejected", "zh-CN": "密钥已失效", "zh-TW": "金鑰已失效", ja: "キーが無効です" },
  "pc.keyRejectedHint": { en: "The server rejected this device's key{account}. Sign in again, or sign out to clean up this device.", "zh-CN": "{account}设备密钥已被服务器拒绝，请重新登录，或退出账户清理本机配置。", "zh-TW": "{account}裝置金鑰已被伺服器拒絕，請重新登入，或登出帳戶清理本機設定。", ja: "{account}デバイスキーがサーバーに拒否されました。再度サインインするか、サインアウトしてこのデバイスを整理してください。" },
  "pc.keyRejectedAccount": { en: " (account {name})", "zh-CN": "账户 {name} 的", "zh-TW": "帳戶 {name} 的", ja: "アカウント {name} の" },
  "pc.signInAgain": { en: "Sign in again", "zh-CN": "重新登录", "zh-TW": "重新登入", ja: "再度サインイン" },
  "pc.signedOut": { en: "Not signed in", "zh-CN": "未登录", "zh-TW": "未登入", ja: "未サインイン" },
  "pc.signedOutHint": { en: "Sign in to set up the CGS models and see your balance and subscription usage.", "zh-CN": "登录后自动配置 CGS 模型，并显示余额与订阅用量。", "zh-TW": "登入後自動設定 CGS 模型，並顯示餘額與訂閱用量。", ja: "サインインすると CGS モデルが設定され、残高とサブスクの使用量が表示されます。" },
  "pc.signIn": { en: "Sign in to CGS", "zh-CN": "登录 CGS", "zh-TW": "登入 CGS", ja: "CGS にサインイン" },
  "orc.title": { en: "Agent orchestration", "zh-CN": "智能体编排", "zh-TW": "智慧體編排", ja: "エージェント構成" },
  "orc.desc": { en: "The orchestrator is the main model you chat with; it hands work to the subagents below. Each role runs on its own model and thinking level.", "zh-CN": "Orchestrator 是与你对话的主模型，它把工作分派给下方的子智能体。每个角色使用各自的模型与思考强度。", "zh-TW": "Orchestrator 是與你對話的主模型，它把工作分派給下方的子智慧體。每個角色使用各自的模型與思考強度。", ja: "Orchestrator は会話するメインモデルで、下のサブエージェントに作業を振り分けます。各ロールは独自のモデルと思考レベルで動きます。" },
  "orc.orchestrator": { en: "Main model", "zh-CN": "主模型", "zh-TW": "主模型", ja: "メインモデル" },
  "orc.subagent": { en: "Subagent", "zh-CN": "子智能体", "zh-TW": "子智慧體", ja: "サブエージェント" },
  "orc.model": { en: "Model", "zh-CN": "模型", "zh-TW": "模型", ja: "モデル" },
  "orc.thinking": { en: "Thinking", "zh-CN": "思考", "zh-TW": "思考", ja: "思考" },
  "orc.inherit": { en: "Agent default (no override)", "zh-CN": "智能体默认（不覆盖）", "zh-TW": "智慧體預設（不覆蓋）", ja: "エージェント既定（上書きなし）" },
  "orc.thinkingDefault": { en: "Default", "zh-CN": "默认", "zh-TW": "預設", ja: "既定" },
  "orc.notListed": { en: "{model} (unavailable)", "zh-CN": "{model}（不可用）", "zh-TW": "{model}（不可用）", ja: "{model}（利用不可）" },
  "orc.remove": { en: "Remove role", "zh-CN": "移除角色", "zh-TW": "移除角色", ja: "ロールを削除" },
  "orc.addRole": { en: "Add role", "zh-CN": "添加角色", "zh-TW": "新增角色", ja: "ロールを追加" },
  "orc.addPlaceholder": { en: "Agent name, e.g. scout", "zh-CN": "智能体名称，例如 scout", "zh-TW": "智慧體名稱，例如 scout", ja: "エージェント名（例: scout）" },
  "orc.add": { en: "Add", "zh-CN": "添加", "zh-TW": "新增", ja: "追加" },
  "orc.badName": { en: "Use letters, digits, '.', '_' or '-' (max 64)", "zh-CN": "名称只能包含字母、数字、.、_、-（最长 64）", "zh-TW": "名稱只能包含字母、數字、.、_、-（最長 64）", ja: "英数字と . _ - のみ（最大 64 文字）" },
  "orc.duplicate": { en: "{name} is already in the layout", "zh-CN": "{name} 已在编排中", "zh-TW": "{name} 已在編排中", ja: "{name} はすでにあります" },
  "orc.save": { en: "Save", "zh-CN": "保存", "zh-TW": "儲存", ja: "保存" },
  "orc.saving": { en: "Saving…", "zh-CN": "保存中…", "zh-TW": "儲存中…", ja: "保存中…" },
  "orc.revert": { en: "Discard changes", "zh-CN": "撤销更改", "zh-TW": "捨棄變更", ja: "変更を破棄" },
  "orc.restore": { en: "Restore defaults", "zh-CN": "恢复默认", "zh-TW": "還原預設", ja: "既定に戻す" },
  "orc.restoreUnavailable": { en: "The server's default layout is unavailable right now", "zh-CN": "暂时无法从服务器获取默认编排", "zh-TW": "暫時無法從伺服器取得預設編排", ja: "サーバーの既定構成を取得できません" },
  "orc.restored": { en: "Defaults loaded; save to apply", "zh-CN": "已载入默认编排，保存后生效", "zh-TW": "已載入預設編排，儲存後生效", ja: "既定を読み込みました。保存すると適用されます" },
  "orc.saved": { en: "Saved; new sessions use this layout", "zh-CN": "已保存，新会话将使用此编排", "zh-TW": "已儲存，新工作階段將使用此編排", ja: "保存しました。新しいセッションから適用されます" },
  "orc.unsaved": { en: "Unsaved changes", "zh-CN": "有未保存的更改", "zh-TW": "有未儲存的變更", ja: "未保存の変更があります" },
  "orc.loading": { en: "Loading…", "zh-CN": "加载中…", "zh-TW": "載入中…", ja: "読み込み中…" },
  "orc.loadFailed": { en: "Could not read the configuration: {error}", "zh-CN": "无法读取配置：{error}", "zh-TW": "無法讀取設定：{error}", ja: "設定を読み込めません: {error}" },
  "orc.saveFailed": { en: "Save failed: {error}", "zh-CN": "保存失败：{error}", "zh-TW": "儲存失敗：{error}", ja: "保存に失敗しました: {error}" },
  "orc.needModel": { en: "Choose a main model first", "zh-CN": "请先选择主模型", "zh-TW": "請先選擇主模型", ja: "先にメインモデルを選んでください" },
  "think.off": { en: "Off", "zh-CN": "关闭", "zh-TW": "關閉", ja: "オフ" },
  "think.minimal": { en: "Minimal", "zh-CN": "极低", "zh-TW": "極低", ja: "最小" },
  "think.low": { en: "Low", "zh-CN": "低", "zh-TW": "低", ja: "低" },
  "think.medium": { en: "Medium", "zh-CN": "中", "zh-TW": "中", ja: "中" },
  "think.high": { en: "High", "zh-CN": "高", "zh-TW": "高", ja: "高" },
  "think.xhigh": { en: "Extra high", "zh-CN": "超高", "zh-TW": "超高", ja: "超高" },
  "think.max": { en: "Max", "zh-CN": "最大", "zh-TW": "最大", ja: "最大" },
  "think.auto": { en: "Auto", "zh-CN": "自动", "zh-TW": "自動", ja: "自動" },
  "upd.title": { en: "CGS Desktop updates", "zh-CN": "CGS Desktop 更新", "zh-TW": "CGS Desktop 更新", ja: "CGS Desktop の更新" },
  "upd.current": { en: "Version {version}", "zh-CN": "当前版本 {version}", "zh-TW": "目前版本 {version}", ja: "バージョン {version}" },
  "upd.disabled": { en: "Updates are only available in installed builds", "zh-CN": "仅安装版支持自动更新", "zh-TW": "僅安裝版支援自動更新", ja: "自動更新はインストール版のみ対応しています" },
  "upd.idle": { en: "Updates are checked automatically", "zh-CN": "将自动检查更新", "zh-TW": "將自動檢查更新", ja: "更新は自動で確認されます" },
  "upd.checking": { en: "Checking for updates…", "zh-CN": "正在检查更新…", "zh-TW": "正在檢查更新…", ja: "更新を確認中…" },
  "upd.latest": { en: "You're up to date", "zh-CN": "已是最新版本", "zh-TW": "已是最新版本", ja: "最新です" },
  "upd.downloading": { en: "Downloading {version}… {percent}%", "zh-CN": "正在下载 {version}… {percent}%", "zh-TW": "正在下載 {version}… {percent}%", ja: "{version} をダウンロード中… {percent}%" },
  "upd.downloaded": { en: "{version} is ready; restart to update", "zh-CN": "{version} 已就绪，重启即可更新", "zh-TW": "{version} 已就緒，重新啟動即可更新", ja: "{version} の準備ができました。再起動で更新します" },
  "upd.error": { en: "Update check failed: {error}", "zh-CN": "检查更新失败：{error}", "zh-TW": "檢查更新失敗：{error}", ja: "更新の確認に失敗しました: {error}" },
  "upd.check": { en: "Check for updates", "zh-CN": "检查更新", "zh-TW": "檢查更新", ja: "更新を確認" },
  "upd.install": { en: "Restart & update", "zh-CN": "重启并更新", "zh-TW": "重新啟動並更新", ja: "再起動して更新" },
  "upd.later": { en: "Later", "zh-CN": "稍后", "zh-TW": "稍後", ja: "後で" },
};
/* eslint-enable quote-props */

/** Localized string for `key`; `{name}` placeholders are filled from `vars`. */
function t(key, vars) {
  const entry = STRINGS[key];
  const text = entry ? entry[locale()] || entry.en : key;
  return vars ? text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all)) : text;
}

const TIER_NAMES = { free: "Free", go: "Go", pro: "Pro" };
const tierName = (tier) => (tier === "dedicated" ? t("tier.dedicated") : TIER_NAMES[tier] || "");

// new-api web console default preset "lavender-dream" (web/src/styles/theme.css base + theme-presets.css):
//   light --primary oklch(0.5709 0.1808 306.89) ≈ #9453c9; dark --primary oklch(0.6359 0.1699 307.95) ≈ #a76ad9
// mapped onto ompweb's theme variables for its "system" preference (resolves to data-theme="light" / "dark").
const THEME_CSS = `
html[data-theme="light"]:root:root {
  --bg: oklch(1 0 0);
  --bg-panel: oklch(0.97 0 0);
  --bg-hover: oklch(0.95 0 0);
  --bg-selected: color-mix(in oklch, oklch(0.5709 0.1808 306.89) 12%, oklch(1 0 0));
  --border: oklch(0.93 0 0);
  --text: oklch(0.145 0 0);
  --text-muted: oklch(0.49 0 0);
  --text-dim: oklch(0.5 0 0);
  --accent: oklch(0.5709 0.1808 306.89);
  --accent-strong: oklch(0.5709 0.1808 306.89);
  --accent-hover: oklch(0.5 0.1808 306.89);
  --user-bg: color-mix(in oklch, oklch(0.5709 0.1808 306.89) 8%, oklch(1 0 0));
  --tool-bg: oklch(0.975 0 0);
  --bg-subtle: oklch(0.97 0 0);
  --on-accent: oklch(1 0 0);
}
html[data-theme="dark"]:root:root {
  color-scheme: dark;
  --bg: oklch(0.235 0 0);
  --bg-panel: oklch(0.225 0 0);
  --bg-hover: oklch(0.305 0 0);
  --bg-selected: color-mix(in oklch, oklch(0.6359 0.1699 307.95) 20%, oklch(0.235 0 0));
  --border: oklch(1 0 0 / 10%);
  --text: oklch(0.965 0 0);
  --text-muted: oklch(0.78 0 0);
  --text-dim: oklch(0.7 0 0);
  --accent: oklch(0.6359 0.1699 307.95);
  --accent-strong: oklch(0.54 0.1699 307.95);
  --accent-hover: oklch(0.72 0.15 307.95);
  --user-bg: oklch(0.285 0 0);
  --tool-bg: oklch(0.26 0 0);
  --bg-subtle: oklch(1 0 0 / 5%);
  --on-accent: oklch(1 0 0);
}
`;

function storedTheme() {
  try {
    return window.localStorage.getItem("omp-theme");
  } catch {
    return null;
  }
}

const bridge = {
  getState: () => ipcRenderer.invoke("cgs:get-state"),
  openLogin: () => ipcRenderer.invoke("cgs:open-login"),
  getUsage: () => ipcRenderer.invoke("cgs:get-usage"),
  refreshUsage: () => ipcRenderer.invoke("cgs:refresh-usage"),
  refreshAccount: () => ipcRenderer.invoke("cgs:refresh-account"),
  openConsole: (page) => ipcRenderer.invoke("cgs:open-console", page),
  logout: () => ipcRenderer.invoke("cgs:logout"),
  onUsage: (callback) => {
    const listener = (_event, snap) => callback(snap);
    ipcRenderer.on("cgs:usage", listener);
    return () => ipcRenderer.removeListener("cgs:usage", listener);
  },
  /** `{ mode: "direct" | "relay", endpoint?, tunnel_configured, version }` of the CGS agent, or null before it reports. */
  getNetwork: () => ipcRenderer.invoke("cgs:get-network"),
  onNetwork: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("cgs:network", listener);
    return () => ipcRenderer.removeListener("cgs:network", listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("cgs:state", listener);
    return () => ipcRenderer.removeListener("cgs:state", listener);
  },
};

// Used only by the UI injected here (not exposed to ompweb's page scripts).
const desktop = {
  getOrchestration: () => ipcRenderer.invoke("cgs:orchestration-get"),
  saveOrchestration: (orchestration) => ipcRenderer.invoke("cgs:orchestration-save", orchestration),
  getDefaultLayout: () => ipcRenderer.invoke("cgs:orchestration-defaults"),
  getUpdate: () => ipcRenderer.invoke("cgs:update-get"),
  checkUpdate: () => ipcRenderer.invoke("cgs:update-check"),
  installUpdate: () => ipcRenderer.invoke("cgs:update-install"),
};

try {
  contextBridge.exposeInMainWorld("cgsDesktop", bridge);
} catch {
  // contextIsolation disabled in a test harness: ignore
}

// ---- ompweb prefs mirror --------------------------------------------------------------------------------------------
// ompweb keeps its preferences in localStorage `omp-*` keys, scoped to the page origin. The main process mirrors them in
// a JSON file: the file is authoritative once it exists (restored here, before ompweb's scripts read localStorage);
// before that, this origin's own keys seed it. Page scripts run in another world, so Storage cannot be wrapped from
// here: changes are found by diffing every second (and on unload/hide) and sent as deltas.
// Keep in sync with PREF_KEY_PATTERN in prefs.js (a test compares the two). Drafts are bulky and per session.
const PREF_KEY_PATTERN = /^omp-(?!draft-|uploads-draft-)/;
const PREFS_FLUSH_MS = 1000;
let prefsMirror = {};

function readLocalPrefs() {
  const out = {};
  const storage = window.localStorage;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    const value = key !== null && PREF_KEY_PATTERN.test(key) ? storage.getItem(key) : null;
    if (value !== null) out[key] = value;
  }
  return out;
}

function restorePrefs() {
  const saved = ipcRenderer.sendSync("cgs:prefs-load");
  if (!saved || typeof saved !== "object") return;
  const storage = window.localStorage;
  for (const key of Object.keys(readLocalPrefs())) if (!(key in saved)) storage.removeItem(key);
  for (const [key, value] of Object.entries(saved)) {
    if (PREF_KEY_PATTERN.test(key) && typeof value === "string" && storage.getItem(key) !== value) storage.setItem(key, value);
  }
  prefsMirror = { ...saved };
}

function flushPrefs() {
  try {
    const now = readLocalPrefs();
    const set = {};
    const remove = [];
    for (const [key, value] of Object.entries(now)) if (prefsMirror[key] !== value) set[key] = value;
    for (const key of Object.keys(prefsMirror)) if (!(key in now)) remove.push(key);
    if (remove.length === 0 && Object.keys(set).length === 0) return;
    prefsMirror = now;
    ipcRenderer.send("cgs:prefs-save", { set, remove });
  } catch {
    // storage unavailable: nothing to mirror
  }
}

const isAppPage = window.location.protocol.startsWith("http");
try {
  if (isAppPage) restorePrefs();
} catch {
  // storage unavailable: ompweb falls back to its own defaults
}

// Default to following the OS theme until the user picks one (ompweb stores the choice in localStorage "omp-theme").
try {
  if (isAppPage && window.localStorage.getItem("omp-theme") === null) {
    window.localStorage.setItem("omp-theme", "system");
  }
} catch {
  // storage unavailable: ompweb falls back to its own default
}

if (isAppPage) {
  flushPrefs();
  setInterval(flushPrefs, PREFS_FLUSH_MS);
  window.addEventListener("pagehide", flushPrefs);
  window.addEventListener("beforeunload", flushPrefs);
  document.addEventListener("visibilitychange", flushPrefs);
}

const ICONS = {
  minimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  maximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" fill="none"/><rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  refresh:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
};

// Colours come from ompweb's theme variables (so light/dark/custom themes all work); the fallbacks follow the OS scheme.
const CSS = `
.shell-topbar { -webkit-app-region: drag; }
.shell-topbar button, .shell-topbar input, .shell-topbar textarea, .shell-topbar select, .shell-topbar a,
.shell-topbar [role="button"], .shell-topbar [role="menu"], .shell-topbar [role="menuitem"], .shell-topbar [role="combobox"],
.shell-topbar [role="tab"], .shell-topbar [contenteditable="true"], .shell-topbar [data-no-drag],
[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper] { -webkit-app-region: no-drag; }
#${ROOT_ID} { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-left: 4px; -webkit-app-region: no-drag; }
#${ROOT_ID}.cgs-floating { position: fixed; top: 0; right: 0; z-index: 2147483647; margin: 0; padding-left: 4px; background: color-mix(in srgb, var(--bg-panel, Canvas) 88%, transparent); border-bottom-left-radius: 6px; }
body:has(#${ROOT_ID}.cgs-floating) .settings-header { padding-right: 148px; }
#${ROOT_ID} button.cgs-win-btn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 32px; cursor: default; color: inherit; border-radius: 6px; -webkit-app-region: no-drag; }
#${ROOT_ID}.cgs-floating button.cgs-win-btn { border-radius: 0; height: 30px; color: var(--text, CanvasText); }
#${ROOT_ID} button.cgs-win-btn:hover { background: rgba(127, 127, 127, 0.22); }
#${ROOT_ID} button.cgs-win-btn:active { background: rgba(127, 127, 127, 0.34); }
#${ROOT_ID} button.cgs-win-btn[data-action="close"]:hover { background: #e81123; color: #fff; }
#${ROOT_ID} button.cgs-win-btn[data-action="close"]:active { background: #f1707a; color: #fff; }
#${ROOT_ID} button.cgs-win-btn:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: -2px; }

img.cgs-brand-logo { display: block; flex-shrink: 0; }
[data-cgs-replaced="1"] { display: none !important; }

#${OVERLAY_ID} {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif;
  color: var(--text, CanvasText);
  -webkit-app-region: no-drag;
}

/* CGS sign-in button (reuses ompweb's settings rows) */
.cgs-login-btn {
  all: unset;
  box-sizing: border-box;
  padding: 5px 12px;
  border-radius: 8px;
  background: var(--accent-strong, var(--accent, #9453c9));
  color: var(--on-accent, #fff);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}
.cgs-login-btn:hover { filter: brightness(1.08); }
.cgs-login-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 2px; }


#cgs-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483646;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-panel, Canvas);
  border: 1px solid var(--accent, #9453c9);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  color: var(--text, CanvasText);
  font-size: 12px;
}
#cgs-toast[hidden] { display: none !important; }

/* CGS balance / subscription row: sidebar, right above the Settings footer (and ompweb's own usage widget above it) */
#cgs-usage-row {
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 7px 12px 8px;
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  background: var(--bg-panel, transparent);
  color: var(--text-muted, GrayText);
  font-size: 11px;
  line-height: 1.35;
  -webkit-app-region: no-drag;
}
.cgs-ur-relay {
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(214, 140, 40, 0.18);
  color: #d68c28;
  font-weight: 600;
  white-space: nowrap;
}
.cgs-ur-head, .cgs-ur-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cgs-ur-line { justify-content: space-between; gap: 8px; }
.cgs-ur-badge {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  background: var(--bg, transparent);
  color: var(--accent, #9453c9);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.7;
}
.cgs-ur-plan { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text, CanvasText); font-weight: 600; }
.cgs-ur-balance { color: var(--text, CanvasText); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cgs-ur-pct { flex-shrink: 0; font-family: var(--font-mono, ui-monospace, monospace); font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cgs-ur-meta { display: flex; justify-content: space-between; gap: 8px; min-width: 0; color: var(--text-dim, GrayText); font-size: 10px; }
.cgs-ur-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cgs-ur-meta > span:last-child { flex-shrink: 0; }
.cgs-ur-limits { color: var(--text-dim, GrayText); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cgs-bar { height: 3px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--text-dim, gray) 28%, transparent); }
.cgs-bar > i { display: block; height: 100%; border-radius: 2px; background: var(--accent, #9453c9); }
/* ompweb's ProviderUsageBar (the <section> right above the Settings footer) is hidden while signed in: the CGS row replaces it */
[data-cgs-hidden-usage="1"] { display: none !important; }
.cgs-stale-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--status-warning, #c18401); }
.cgs-icon-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--text-dim, GrayText);
  cursor: pointer;
}
.cgs-icon-btn:hover:not(:disabled) { background: var(--bg-hover, rgba(127, 127, 127, 0.18)); color: var(--text, CanvasText); }
.cgs-icon-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 1px; }
.cgs-icon-btn[aria-busy="true"] { cursor: default; }
.cgs-icon-btn[aria-busy="true"] svg { animation: cgs-spin 0.9s linear infinite; }
@keyframes cgs-spin { to { transform: rotate(360deg); } }

/* CGS account card: top of Settings → 用量与分析 */
#cgs-usage-card {
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: var(--radius-control, 10px);
  background: var(--bg-subtle, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.45;
}
.cgs-uc-head { display: flex; align-items: center; gap: 8px; }
.cgs-uc-title { font-size: 14px; font-weight: 600; }
.cgs-uc-spacer { flex: 1; }
.cgs-uc-muted { color: var(--text-muted, GrayText); font-size: 12px; }
.cgs-uc-account { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.cgs-uc-account strong { font-weight: 600; }
.cgs-uc-pill {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent, #9453c9) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, #9453c9) 42%, transparent);
  color: var(--accent, #9453c9);
  font-size: 11px;
  font-weight: 500;
}
.cgs-uc-balance { display: inline-flex; align-items: baseline; gap: 6px; }
.cgs-uc-balance b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cgs-uc-sub { display: flex; flex-direction: column; gap: 6px; padding-top: 12px; border-top: 1px solid var(--border, rgba(127, 127, 127, 0.3)); }
.cgs-uc-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
.cgs-uc-row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.cgs-uc-row b { font-weight: 600; font-variant-numeric: tabular-nums; }
.cgs-uc-sub .cgs-bar { height: 6px; border-radius: 3px; }
.cgs-uc-sub .cgs-bar > i { border-radius: 3px; }
.cgs-uc-facts { display: flex; flex-wrap: wrap; gap: 2px 16px; color: var(--text-muted, GrayText); font-size: 12px; }
.cgs-uc-limits { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.cgs-uc-limit { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; align-items: baseline; font-size: 12px; }
.cgs-uc-limit .cgs-bar { grid-column: 1 / -1; }
.cgs-uc-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); }
.cgs-uc-num { color: var(--text-muted, GrayText); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* CGS integration card: top of Settings → API Keys & Providers */
#cgs-providers-card {
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: var(--radius-control, 10px);
  background: var(--bg-subtle, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.45;
}
.cgs-pc-head { display: flex; align-items: center; gap: 10px; }
.cgs-pc-logo { width: 35px; height: 35px; border-radius: 6px; flex-shrink: 0; object-fit: contain; }
.cgs-pc-heading { display: flex; flex-direction: column; min-width: 0; }
.cgs-pc-title { font-size: 14px; font-weight: 600; }
.cgs-pc-status { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted, GrayText); font-size: 12px; }
.cgs-pc-status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--status-success, #2e9d57); }
.cgs-pc-status[data-tone="warning"]::before { background: var(--status-warning, #c18401); }
.cgs-pc-status[data-tone="error"]::before { background: var(--status-error, #d63a3a); }
.cgs-pc-status[data-tone="error"] { color: var(--status-error, #d63a3a); }
.cgs-pc-providers { display: flex; flex-wrap: wrap; gap: 6px; }
.cgs-pc-chip {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  background: var(--bg, transparent);
  color: var(--text-muted, GrayText);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
}
.cgs-pc-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.cgs-pc-btn {
  all: unset;
  box-sizing: border-box;
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
  background: var(--bg, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.cgs-pc-btn:hover:not([aria-disabled="true"]) { border-color: var(--accent, #9453c9); }
.cgs-pc-btn:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 2px; }
.cgs-pc-btn[aria-disabled="true"] { opacity: 0.5; cursor: default; }
.cgs-pc-btn[data-variant="primary"] { border-color: transparent; background: var(--accent-strong, var(--accent, #9453c9)); color: var(--on-accent, #fff); }
.cgs-pc-btn[data-variant="danger"] { margin-left: auto; color: var(--status-error, #d63a3a); border-color: color-mix(in srgb, var(--status-error, #d63a3a) 45%, transparent); }
.cgs-pc-btn[data-variant="danger"]:hover:not([aria-disabled="true"]) { background: color-mix(in srgb, var(--status-error, #d63a3a) 12%, transparent); border-color: var(--status-error, #d63a3a); }
#cgs-confirm {
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  -webkit-app-region: no-drag;
}
.cgs-confirm-box {
  box-sizing: border-box;
  width: min(420px, calc(100vw - 32px));
  padding: 18px 20px;
  border-radius: 12px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  background: var(--bg-panel, Canvas);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.55;
}
.cgs-confirm-box h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.cgs-confirm-box p { margin: 0 0 6px; color: var(--text-muted, GrayText); }
.cgs-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.cgs-confirm-actions .cgs-pc-btn[data-variant="danger"] { margin-left: 0; background: var(--status-error, #d63a3a); border-color: transparent; color: #fff; }

/* Settings → Agents orchestrator and Settings → System update card: same card look as the usage card */
#cgs-orchestrator-card, #cgs-update-card {
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
  border-radius: var(--radius-control, 10px);
  background: var(--bg-subtle, transparent);
  color: var(--text, CanvasText);
  font-size: 13px;
  line-height: 1.45;
}
#cgs-update-card .cgs-bar { height: 6px; border-radius: 3px; }
#cgs-usd-note { margin-top: 2px; color: var(--text-muted, GrayText); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.cgs-orc-tree { display: flex; flex-direction: column; }
.cgs-orc-node {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
  border-radius: var(--radius-control, 10px);
  background: var(--bg-panel, Canvas);
}
.cgs-orc-root { border-color: color-mix(in srgb, var(--accent, #9453c9) 60%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #9453c9) 25%, transparent); }
.cgs-orc-node-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cgs-orc-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-dim, gray); }
.cgs-orc-root .cgs-orc-dot { background: var(--accent, #9453c9); }
.cgs-orc-name { font-weight: 600; font-family: var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.cgs-orc-badge { padding: 0 6px; border-radius: 999px; border: 1px solid var(--border, rgba(127, 127, 127, 0.35)); color: var(--text-muted, GrayText); font-size: 11px; }
.cgs-orc-remove { margin-left: auto; }
.cgs-orc-remove svg { width: 9px; height: 9px; }
.cgs-orc-fields { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.cgs-orc-field { display: flex; flex-direction: column; gap: 3px; flex: 1 1 260px; min-width: 0; }
.cgs-orc-field-narrow { flex: 0 1 140px; }
.cgs-orc-select, .cgs-orc-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-control, 8px);
  border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
  background: var(--bg, Canvas);
  color: var(--text, CanvasText);
  font: inherit;
  font-size: 12px;
}
.cgs-orc-select:focus-visible, .cgs-orc-input:focus-visible { outline: 2px solid var(--accent, #9453c9); outline-offset: 1px; }
.cgs-orc-select:disabled { opacity: 0.55; }
/* tree: a spine from the orchestrator down the left, one elbow per subagent */
.cgs-orc-branches { display: flex; flex-direction: column; margin-left: 18px; padding-top: 6px; }
.cgs-orc-branch { position: relative; padding: 6px 0 6px 26px; }
.cgs-orc-branch::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; border-left: 2px solid var(--border, rgba(127, 127, 127, 0.45)); }
.cgs-orc-branch:last-child::before { bottom: auto; height: 50%; }
.cgs-orc-branch::after { content: ""; position: absolute; left: 0; top: 50%; width: 24px; border-top: 2px solid var(--border, rgba(127, 127, 127, 0.45)); }
.cgs-orc-add { border-style: dashed; background: transparent; }
.cgs-orc-add-row { display: flex; align-items: center; gap: 8px; }
.cgs-orc-add-row .cgs-orc-input { flex: 1; }
.cgs-orc-error { color: var(--status-error, #d63a3a); font-size: 12px; }
#cgs-update-banner {
  position: fixed;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--accent, #9453c9);
  background: var(--bg-panel, Canvas);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  color: var(--text, CanvasText);
  font-size: 13px;
  -webkit-app-region: no-drag;
}
`;

let maximized = false;
let scheduled = false;
let cgsState = null;
let cgsLogoUrl = null;
let usageState = null; // { usage, stale, fetchedAt } from the main process; usage is null until the first success
let usageRefreshing = false;
let accountBusy = null; // "refresh" | "logout" while an account action from the providers card is running
let toastTimer = null;

function isLoadingScreen() {
  return window.location.protocol === "file:";
}

function makeWinButton(action, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cgs-win-btn";
  button.dataset.action = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function buildControls() {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.append(
    makeWinButton("minimize", t("win.minimize"), () => ipcRenderer.send("cgs:window-minimize")),
    makeWinButton("maximize", t("win.maximize"), () => ipcRenderer.send("cgs:window-toggle-maximize")),
    makeWinButton("close", t("win.close"), () => ipcRenderer.send("cgs:window-close")),
  );
  root.addEventListener("dblclick", (event) => event.stopPropagation());
  return root;
}

function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const toast = document.createElement("div");
  toast.id = "cgs-toast";
  toast.setAttribute("role", "status");
  toast.hidden = true;

  overlay.append(toast);
  return overlay;
}

function renderIcons(root) {
  const minimize = root.querySelector('[data-action="minimize"]');
  minimize.innerHTML = ICONS.minimize;
  const max = root.querySelector('[data-action="maximize"]');
  max.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
  const close = root.querySelector('[data-action="close"]');
  close.innerHTML = ICONS.close;
  for (const [button, label] of [[minimize, t("win.minimize")], [max, t(maximized ? "win.restore" : "win.maximize")], [close, t("win.close")]]) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  root.dataset.cgsLocale = locale();
}

function showToast(text, ms = 3200) {
  const toast = document.getElementById("cgs-toast");
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, ms);
}

/**
 * ompweb loads its provider/model lists when Settings → API Keys & Providers mounts. After the CGS providers appeared or
 * vanished, ask /api/models (which makes ompweb reload its models when models.yml changed) and then re-mount the panel by
 * visiting another settings tab and coming back.
 */
function refreshOmpwebProviders() {
  if (!document.querySelector(PROVIDERS_PANEL_SELECTOR)) return;
  const remount = () => {
    const other = document.getElementById("settings-tab-models");
    if (!other || !document.querySelector(PROVIDERS_PANEL_SELECTOR)) return;
    other.click();
    setTimeout(() => document.getElementById("settings-tab-providers")?.click(), 50);
  };
  fetch("/api/models").catch(() => {}).finally(remount);
}

async function handleOpenLogin() {
  const wasSignedIn = Boolean(cgsState && cgsState.signedIn);
  const next = await bridge.openLogin();
  if (next) cgsState = next;
  renderCgsUi();
  if (next && Boolean(next.signedIn) !== wasSignedIn) refreshOmpwebProviders();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Re-render `node` only when `sig` changed (keeps the MutationObserver from looping on our own mutations). */
function sync(node, sig, build) {
  if (node.dataset.cgsSig === sig) return;
  node.dataset.cgsSig = sig;
  build(node);
}

function renderBranding() {
  // Lavender palette only while ompweb's theme preference is "system" (an explicit user choice is never overridden).
  const wantTheme = !isLoadingScreen() && storedTheme() === "system";
  const themeStyle = document.getElementById(THEME_STYLE_ID);
  if (wantTheme && !themeStyle) {
    const style = document.createElement("style");
    style.id = THEME_STYLE_ID;
    style.textContent = THEME_CSS;
    (document.head || document.documentElement).append(style);
  } else if (!wantTheme && themeStyle) {
    themeStyle.remove();
  }

  // Brand: ompweb's mark is hidden and the CGS logo put next to it, and ompweb's name becomes "CGS Desktop", always (the
  // loading screen is ours already).
  if (isLoadingScreen()) return;
  for (const logo of document.querySelectorAll(OMP_LOGO_SELECTOR)) {
    const next = logo.nextElementSibling;
    if (!cgsLogoUrl) continue;
    if (!(next && next.classList.contains("cgs-brand-logo"))) {
      const img = document.createElement("img");
      img.className = "cgs-brand-logo";
      img.alt = "CGS";
      img.src = cgsLogoUrl;
      // 25% larger than ompweb's own mark (20 px in the sidebar header, 26 px on the welcome screen).
      const size = Number(logo.getAttribute("width") || "20") * LOGO_SCALE;
      img.width = size;
      img.height = size;
      logo.after(img);
    }
    logo.dataset.cgsReplaced = "1";
  }
  for (const word of document.querySelectorAll(".omp-wordmark")) {
    if (word.textContent !== BRAND_NAME) word.textContent = BRAND_NAME;
  }
  brandHeaderLabel();
}

/**
 * Sidebar header: <button title="Show ompweb version"> holding the mark and <span><span>omp</span><span>web</span></span>.
 * Clicking it swaps that span for the version text and back, and the way back scrambles the name into view one frame at a
 * time, so React recreates the "omp"/"web" spans while it keeps the title we already rewrote. The button is found by the
 * logo we put in it, never by its title, and this also runs synchronously from its own MutationObserver: a rewrite
 * deferred to the next animation frame would flash "omp web". Idempotent: it writes only what differs.
 */
function brandHeaderLabel() {
  for (const logo of document.querySelectorAll("img.cgs-brand-logo")) {
    const button = logo.closest("button");
    if (!button) continue;
    if (button.title.includes("ompweb")) button.title = button.title.replace("ompweb", BRAND_NAME);
    const label = button.querySelector(":scope > span");
    const parts = button.querySelectorAll(":scope > span > span");
    if (parts.length === 2) {
      // The narrow sidebar header fits "CGS" on one line (the full name is the window title).
      if (parts[0].textContent !== "CGS") parts[0].textContent = "CGS";
      if (parts[1].textContent !== "") parts[1].textContent = "";
    } else if (label && label.children.length === 0 && !/^v\d/.test(label.textContent) && label.textContent !== "CGS") {
      // The scrambling name is one plain text node: everything that is not the version string stays "CGS".
      label.textContent = "CGS";
    }
  }
}

// ---- CGS usage (sidebar row + Settings → Usage card) -------------------------------------------------------------------

const resetLabel = (period) => t(`reset.${period}`);

const pad2 = (n) => String(n).padStart(2, "0");
const fmtDate = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const fmtTime = (sec) => {
  const d = new Date(sec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDateTime = (sec) => `${fmtDate(sec)} ${fmtTime(sec)}`;

/** "in 3 days" / "5 小时后" / ... for a unix-seconds instant. */
function fmtIn(sec) {
  const minutes = Math.round((sec * 1000 - Date.now()) / 60000);
  if (minutes <= 0) return t("time.soon");
  if (minutes < 60) return t("time.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t("time.hours", { n: hours }) : t("time.days", { n: Math.round(hours / 24) });
}

/** Token counts: 1234 → "1.2K", 100000000 → "100M". */
function fmtCount(n) {
  const value = Number(n) || 0;
  const scaled = (divisor, unit) => `${Math.round((value / divisor) * 10) / 10}${unit}`;
  if (value >= 1e9) return scaled(1e9, "B");
  if (value >= 1e6) return scaled(1e6, "M");
  if (value >= 1e3) return scaled(1e3, "K");
  return String(Math.round(value));
}

const percentOf = (used, total) => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0);
const percentText = (p) => (p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`);
const toneOf = (p) => (p >= 80 ? "var(--status-error)" : p >= 50 ? "var(--status-warning)" : "var(--accent)");
const minuteBucket = () => Math.floor(Date.now() / 60000);

const usedText = (sub) => sub.usedDisplay || String(sub.amountUsed);
const totalText = (sub) => sub.totalDisplay || String(sub.amountTotal);

function makeBar(percent) {
  const bar = el("div", "cgs-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(Math.round(percent)));
  const fill = document.createElement("i");
  fill.style.width = `${percent}%`;
  fill.style.background = toneOf(percent);
  bar.append(fill);
  return bar;
}

function limitsOf(sub) {
  return sub.dailyTokenLimits.map((l) => ({ ...l, percent: percentOf(l.used, l.limit) }));
}

function staleHint() {
  return usageState && usageState.fetchedAt ? t("usage.staleAt", { time: fmtTime(usageState.fetchedAt / 1000) }) : t("usage.stale");
}

function buildRefreshButton() {
  const button = el("button", "cgs-icon-btn");
  button.type = "button";
  button.dataset.action = "cgs-usage-refresh";
  button.title = t("usage.refresh");
  button.setAttribute("aria-label", t("usage.refresh"));
  button.innerHTML = ICONS.refresh;
  if (usageRefreshing) {
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
  }
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void handleRefreshUsage();
  });
  return button;
}

async function handleRefreshUsage() {
  if (usageRefreshing) return;
  usageRefreshing = true;
  renderUsageUi();
  try {
    const snap = await bridge.refreshUsage();
    if (snap) usageState = snap;
  } catch {
    // the main process keeps the last value; nothing to show
  } finally {
    usageRefreshing = false;
    renderUsageUi();
  }
}

/**
 * The plan title (+ tier) of the primary subscription. Without a subscription the account is billed pay-as-you-go
 * from the balance, whatever its tier: "PAYG · No subscription".
 */
function planText(usage) {
  const sub = usage.subscriptions[0];
  if (!sub) return `PAYG · ${t("plan.noSubscription")}`;
  const tier = tierName(usage.tier);
  const title = sub.planTitle || t("plan.subscription");
  const text = tier && !title.toLowerCase().includes(tier.toLowerCase()) ? `${title} · ${tier}` : title;
  return usage.subscriptions.length > 1 ? `${text} +${usage.subscriptions.length - 1}` : text;
}

/** The account pill: the tier while a subscription is active, "PAYG" without one. */
function accountPill(usage, tier) {
  if (usage && usage.subscriptions.length === 0) return "PAYG";
  return tierName((usage && usage.tier) || tier);
}

function buildUsageRow() {
  const row = el("div");
  row.id = USAGE_ROW_ID;
  row.dataset.cgsUsage = "row";
  return row;
}

function renderUsageRow(row) {
  const snap = usageState;
  const usage = snap.usage;
  const sig = JSON.stringify([usage, snap.stale, usageRefreshing, minuteBucket(), locale()]);
  sync(row, sig + (networkRelay ? "|relay" : ""), () => {
    const sub = usage.subscriptions[0] || null;
    const percent = sub && !sub.unlimited ? percentOf(sub.amountUsed, sub.amountTotal) : 0;
    const limits = sub ? limitsOf(sub).filter((l) => l.limit > 0) : [];
    const worstLimit = limits.reduce((worst, l) => (!worst || l.percent > worst.percent ? l : worst), null);

    const head = el("div", "cgs-ur-head");
    head.append(el("span", "cgs-ur-badge", "CGS"), el("span", "cgs-ur-plan", planText(usage)));
    if (snap.stale) {
      const dot = el("span", "cgs-stale-dot");
      dot.title = staleHint();
      head.append(dot);
    }
    if (networkRelay) {
      const relay = el("span", "cgs-ur-relay", "Relay enabled");
      relay.title = networkRelay;
      head.append(relay);
    }
    head.append(buildRefreshButton());
    const children = [head];

    const line = el("div", "cgs-ur-line");
    line.append(el("span", "cgs-ur-balance", `${t("usage.balance")} ${usage.balance.display || "—"}`));
    if (sub) {
      const tag = el("span", "cgs-ur-pct", sub.unlimited ? t("usage.unlimited") : percentText(percent));
      if (!sub.unlimited) tag.style.color = toneOf(percent);
      line.append(tag);
    }
    children.push(line);

    if (sub) {
      if (!sub.unlimited) children.push(makeBar(percent));
      const meta = el("div", "cgs-ur-meta");
      const usedLabel = sub.unlimited ? t("usage.used", { used: usedText(sub) }) : `${usedText(sub)} / ${totalText(sub)}`;
      let when = "";
      if (sub.resetPeriod !== "never" && sub.nextResetAt > 0) when = t("usage.resetsIn", { when: fmtIn(sub.nextResetAt) });
      else if (sub.endTime > 0) when = t("usage.expiresOn", { date: fmtDate(sub.endTime) });
      meta.append(el("span", "", usedLabel));
      if (when) meta.append(el("span", "", when));
      children.push(meta);
      if (worstLimit) {
        children.push(el("div", "cgs-ur-limits", t("usage.dailyLimitsSummary", { count: limits.length, pct: percentText(worstLimit.percent) })));
      }
    }
    row.title = [
      `${planText(usage)} · ${t("usage.balance")} ${usage.balance.display || "—"}`,
      ...(sub ? [sub.unlimited ? t("usage.usedUnlimited", { used: usedText(sub) }) : `${usedText(sub)} / ${totalText(sub)} (${percentText(percent)})`] : []),
      ...(snap.stale ? [staleHint()] : []),
    ].join("\n");
    row.classList.toggle("cgs-stale", Boolean(snap.stale));
    row.replaceChildren(...children);
  });
}

/** The row sits directly above ompweb's pinned Settings footer, i.e. below its provider-usage widget (if shown). */
function ensureUsageRow() {
  const show = !isLoadingScreen() && cgsState && cgsState.signedIn && usageState && usageState.usage;
  const settingsButton = show ? document.querySelector(SETTINGS_ROW_SELECTOR) : null;
  const footer = settingsButton && settingsButton.parentElement;
  const existing = document.getElementById(USAGE_ROW_ID);
  if (!footer || !footer.parentElement) {
    existing?.remove();
    return;
  }
  const row = existing || buildUsageRow();
  if (row.nextElementSibling !== footer || row.parentElement !== footer.parentElement) footer.before(row);
  renderUsageRow(row);
}

function buildSubscriptionBlock(sub) {
  const block = el("div", "cgs-uc-sub");
  const percent = sub.unlimited ? 0 : percentOf(sub.amountUsed, sub.amountTotal);

  const title = el("div", "cgs-uc-row");
  title.append(el("b", "", sub.planTitle || t("plan.subscriptionN", { id: sub.id })), el("span", "cgs-uc-muted", resetLabel(sub.resetPeriod)));
  const used = el("div", "cgs-uc-row");
  used.append(
    el("span", "", sub.unlimited ? t("usage.usedUnlimitedShort", { used: usedText(sub) }) : t("usage.usedOf", { used: usedText(sub), total: totalText(sub) })),
    sub.unlimited ? el("span") : Object.assign(el("b", "", percentText(percent)), { style: `color:${toneOf(percent)}` }),
  );
  block.append(title, used);
  if (!sub.unlimited) block.append(makeBar(percent));

  const facts = el("div", "cgs-uc-facts");
  if (sub.resetPeriod !== "never" && sub.nextResetAt > 0) facts.append(el("span", "", t("usage.nextReset", { at: fmtDateTime(sub.nextResetAt), when: fmtIn(sub.nextResetAt) })));
  facts.append(el("span", "", sub.endTime > 0 ? t("usage.expires", { date: fmtDate(sub.endTime) }) : t("usage.noExpiry")));
  block.append(facts);

  const limits = limitsOf(sub);
  if (limits.length > 0) {
    const list = el("div", "cgs-uc-limits");
    list.append(el("div", "cgs-uc-muted", t("usage.dailyTokenLimits")));
    for (const l of limits) {
      const item = el("div", "cgs-uc-limit");
      const model = el("span", "cgs-uc-model", l.model);
      model.title = l.model;
      const num = el("span", "cgs-uc-num", l.limit > 0 ? `${fmtCount(l.used)} / ${fmtCount(l.limit)}` : t("usage.limitUnlimited", { used: fmtCount(l.used) }));
      if (l.resetAt > 0) num.title = t("usage.resetsAt", { at: fmtDateTime(l.resetAt) });
      item.append(model, num);
      if (l.limit > 0) item.append(makeBar(l.percent));
      list.append(item);
    }
    block.append(list);
  }
  return block;
}

function renderUsageCard(card) {
  const snap = usageState;
  const usage = snap && snap.usage;
  const sig = JSON.stringify([cgsState.username, cgsState.tier, snap, usageRefreshing, minuteBucket(), locale()]);
  sync(card, sig, () => {
    const head = el("div", "cgs-uc-head");
    head.append(el("span", "cgs-uc-title", t("usage.cardTitle")), el("span", "cgs-uc-spacer"));
    if (usage && snap.stale) {
      const stale = el("span", "cgs-uc-muted", t("usage.stale"));
      stale.title = staleHint();
      head.append(stale);
    } else if (usage && snap.fetchedAt) {
      head.append(el("span", "cgs-uc-muted", t("usage.updatedAt", { time: fmtTime(snap.fetchedAt / 1000) })));
    }
    head.append(buildRefreshButton());

    const account = el("div", "cgs-uc-account");
    const pill = accountPill(usage, cgsState.tier);
    const nameWrap = el("span");
    nameWrap.append(el("strong", "", (usage && usage.username) || cgsState.username || "CGS"));
    account.append(nameWrap);
    if (pill) account.append(el("span", "cgs-uc-pill", pill));
    const children = [head, account];

    if (!usage) {
      children.push(el("div", "cgs-uc-muted", usageRefreshing ? t("usage.loading") : t("usage.unavailable")));
    } else {
      const balance = el("div", "cgs-uc-balance");
      balance.append(el("span", "cgs-uc-muted", t("usage.balance")), el("b", "", usage.balance.display || "—"));
      account.append(balance);
      if (usage.subscriptions.length === 0) {
        children.push(el("div", "cgs-uc-muted", t("usage.payg")));
      } else {
        for (const sub of usage.subscriptions) children.push(buildSubscriptionBlock(sub));
      }
    }
    card.replaceChildren(...children);
  });
}

function ensureUsageCard() {
  const panel = !isLoadingScreen() && cgsState && cgsState.signedIn ? document.querySelector(USAGE_PANEL_SELECTOR) : null;
  const existing = document.getElementById(USAGE_CARD_ID);
  if (!panel) {
    existing?.remove();
    return;
  }
  const card = existing || el("section");
  card.id = USAGE_CARD_ID;
  if (panel.firstElementChild !== card) panel.prepend(card);
  renderUsageCard(card);
}

// ---- Settings → API Keys & Providers: CGS integration card ----------------------------------------------------------
const PROVIDERS_PANEL_SELECTOR = "#settings-panel-providers";
const PROVIDERS_CARD_ID = "cgs-providers-card";
const CONFIRM_ID = "cgs-confirm";

/** In-page confirmation for signing out. Resolves true when confirmed. */
function confirmLogout() {
  return new Promise((resolve) => {
    document.getElementById(CONFIRM_ID)?.remove();
    const overlay = el("div");
    overlay.id = CONFIRM_ID;
    const box = el("div", "cgs-confirm-box");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", t("pc.logoutLabel"));
    box.append(el("h3", "", t("pc.logoutTitle")), el("p", "", t("pc.logoutP1")), el("p", "", t("pc.logoutP2")), el("p", "", t("pc.logoutP3")));
    const actions = el("div", "cgs-confirm-actions");
    const cancel = el("button", "cgs-pc-btn", t("pc.cancel"));
    cancel.type = "button";
    cancel.dataset.action = "cgs-logout-cancel";
    const confirm = el("button", "cgs-pc-btn", t("pc.logout"));
    confirm.type = "button";
    confirm.dataset.action = "cgs-logout-confirm";
    confirm.dataset.variant = "danger";
    actions.append(cancel, confirm);
    box.append(actions);
    overlay.append(box);
    const done = (value) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        done(false);
      }
    };
    cancel.addEventListener("click", () => done(false));
    confirm.addEventListener("click", () => done(true));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    cancel.focus();
  });
}

async function handleRefreshAccount() {
  if (accountBusy) return;
  accountBusy = "refresh";
  renderUsageUi();
  try {
    const next = await bridge.refreshAccount();
    if (next) {
      if (next.state) cgsState = next.state;
      if (next.usage) usageState = next.usage;
    }
  } catch {
    // the main process keeps the last values
  } finally {
    accountBusy = null;
    renderCgsUi();
  }
}

async function handleLogout() {
  if (accountBusy) return;
  if (!(await confirmLogout())) return;
  accountBusy = "logout";
  renderUsageUi();
  let result;
  try {
    result = await bridge.logout();
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  accountBusy = null;
  if (!result || !result.ok) {
    renderCgsUi();
    showToast(t("pc.logoutFailed", { error: (result && result.error) || t("pc.unknownError") }), 6000);
    return;
  }
  cgsState = result.state;
  const usage = await bridge.getUsage().catch(() => null);
  usageState = usage || null;
  renderCgsUi();
  const problems = [];
  if (!result.serverRevoked) problems.push(t("pc.notRevoked"));
  if (result.cleanupErrors && result.cleanupErrors.length > 0) problems.push(t("pc.cleanupFailed", { errors: result.cleanupErrors.join("; ") }));
  showToast(problems.length > 0 ? problems.join(". ") : t("pc.loggedOut"), problems.length > 0 ? 9000 : 4000);
  refreshOmpwebProviders();
}

function pcButton(label, action, onClick, variant) {
  const button = el("button", "cgs-pc-btn", label);
  button.type = "button";
  button.dataset.action = action;
  if (variant) button.dataset.variant = variant;
  if (accountBusy) button.setAttribute("aria-disabled", "true");
  button.addEventListener("click", () => {
    if (!accountBusy) onClick();
  });
  return button;
}

function buildProvidersHead(state) {
  const head = el("div", "cgs-pc-head");
  if (cgsLogoUrl) {
    const img = el("img", "cgs-pc-logo");
    img.alt = "CGS";
    img.src = cgsLogoUrl;
    head.append(img);
  }
  const heading = el("div", "cgs-pc-heading");
  const title = el("div");
  title.style.cssText = "display:flex;align-items:center;gap:8px";
  title.append(el("span", "cgs-pc-title", "Cicori Good Service"));
  const pill = state.signedIn ? accountPill(usageState && usageState.usage, state.tier) : "";
  if (pill) title.append(el("span", "cgs-uc-pill", pill));
  heading.append(title);
  head.append(heading);
  return { head, heading };
}

function renderProvidersCard(card) {
  const state = cgsState;
  const usage = usageState && usageState.usage;
  const sig = JSON.stringify([state, usageState, accountBusy, Boolean(cgsLogoUrl), minuteBucket(), locale()]);
  sync(card, sig, () => {
    const { head, heading } = buildProvidersHead(state);
    const children = [head];
    const actions = el("div", "cgs-pc-actions");
    if (state.signedIn) {
      const stale = Boolean(usageState && usageState.stale);
      const status = el("span", "cgs-pc-status", stale ? t("usage.stale") : t("pc.connected"));
      status.dataset.tone = stale ? "warning" : "ok";
      if (stale) status.title = staleHint();
      heading.append(status);

      const account = el("div", "cgs-uc-account");
      account.append(el("strong", "", state.username || "CGS"));
      const balance = el("span", "cgs-uc-balance");
      balance.append(el("span", "cgs-uc-muted", t("usage.balance")), el("b", "", usage ? usage.balance.display || "—" : "—"));
      account.append(balance);
      account.append(el("span", "cgs-uc-muted", usage ? planText(usage) : t("pc.noUsage")));
      children.push(account);

      if (Array.isArray(state.providers) && state.providers.length > 0) {
        const list = el("div", "cgs-pc-providers");
        for (const provider of state.providers) list.append(el("span", "cgs-pc-chip", t("pc.models", { id: provider.id, n: provider.models })));
        children.push(list);
      }
      actions.append(
        pcButton(t("pc.openConsole"), "cgs-open-console", () => void bridge.openConsole()),
        pcButton(t("pc.clients"), "cgs-manage-clients", () => void bridge.openConsole("clients")),
        pcButton(accountBusy === "refresh" ? t("pc.refreshing") : t("pc.refresh"), "cgs-refresh-account", () => void handleRefreshAccount()),
        pcButton(accountBusy === "logout" ? t("pc.loggingOut") : t("pc.logout"), "cgs-logout", () => void handleLogout(), "danger"),
      );
    } else if (state.keyRejected) {
      const status = el("span", "cgs-pc-status", t("pc.keyRejected"));
      status.dataset.tone = "error";
      heading.append(status);
      children.push(el("div", "cgs-uc-muted", t("pc.keyRejectedHint", { account: state.username ? t("pc.keyRejectedAccount", { name: state.username }) : "" })));
      actions.append(
        pcButton(t("pc.signInAgain"), "cgs-login", () => void handleOpenLogin(), "primary"),
        pcButton(t("pc.openConsole"), "cgs-open-console", () => void bridge.openConsole()),
        pcButton(accountBusy === "logout" ? t("pc.loggingOut") : t("pc.logout"), "cgs-logout", () => void handleLogout(), "danger"),
      );
    } else {
      heading.append(el("span", "cgs-pc-status", t("pc.signedOut")));
      children.push(el("div", "cgs-uc-muted", t("pc.signedOutHint")));
      actions.append(pcButton(t("pc.signIn"), "cgs-login", () => void handleOpenLogin(), "primary"));
      heading.lastChild.dataset.tone = "warning";
    }
    children.push(actions);
    card.replaceChildren(...children);
  });
}

function ensureProvidersCard() {
  const panel = !isLoadingScreen() && cgsState ? document.querySelector(PROVIDERS_PANEL_SELECTOR) : null;
  const existing = document.getElementById(PROVIDERS_CARD_ID);
  if (!panel) {
    existing?.remove();
    return;
  }
  const card = existing || el("section");
  card.id = PROVIDERS_CARD_ID;
  // Directly below ompweb's heading block (the panel's first child), above its own cards.
  const first = panel.firstElementChild === card ? card.nextElementSibling : panel.firstElementChild;
  if (first && card.previousElementSibling !== first) first.after(card);
  else if (!first && card.parentElement !== panel) panel.append(card);
  renderProvidersCard(card);
}

// Provider reports ompweb shows in its usage widget (same `/api/provider-usage` it polls), fetched to decide from data
// (report.provider), not text, whether anything other than CGS is in there.
let providerReports = null;
let providerReportsAt = 0;
let providerReportsInflight = false;
const PROVIDER_REPORTS_MIN_AGE_MS = 30_000;
const isCgsProvider = (report) => String((report && report.provider) || "").startsWith("cgs");

function refreshProviderReports() {
  if (providerReportsInflight || Date.now() - providerReportsAt < PROVIDER_REPORTS_MIN_AGE_MS) return;
  providerReportsInflight = true;
  providerReportsAt = Date.now();
  fetch("/api/provider-usage")
    .then((response) => (response.ok ? response.json() : null))
    .then((snapshot) => {
      providerReports = snapshot && Array.isArray(snapshot.reports) ? snapshot.reports : [];
    })
    .catch(() => {})
    .finally(() => {
      providerReportsInflight = false;
      renderUsageUi();
    });
}

/**
 * ompweb's ProviderUsageBar renders a <section> directly above the Settings footer (SessionSidebar.tsx); its aria-label is
 * localized, so it is matched structurally. While signed in it is hidden unless a non-CGS provider has a report; then only
 * the cgs-* rows are hidden (rows map 1:1, in order, to report.provider). Signed out → everything restored untouched.
 */
function syncProviderUsageVisibility() {
  const signedIn = !isLoadingScreen() && Boolean(cgsState && cgsState.signedIn);
  const settingsButton = document.querySelector(SETTINGS_ROW_SELECTOR);
  const footer = settingsButton && settingsButton.parentElement;
  let widget = footer ? footer.previousElementSibling : null;
  if (widget && widget.id === USAGE_ROW_ID) widget = widget.previousElementSibling;
  if (widget && !(widget.tagName === "SECTION" && widget.hasAttribute("aria-label"))) widget = null;
  const hide = new Set();
  if (signedIn && widget) {
    refreshProviderReports();
    const thirdParty = providerReports !== null && providerReports.some((report) => !isCgsProvider(report));
    if (!thirdParty) {
      hide.add(widget);
    } else {
      const rows = widget.querySelectorAll("button.provider-usage-row");
      if (rows.length === providerReports.length) {
        rows.forEach((row, i) => {
          if (isCgsProvider(providerReports[i]) && row.parentElement) hide.add(row.parentElement);
        });
      }
    }
  }
  for (const node of document.querySelectorAll('[data-cgs-hidden-usage="1"]')) {
    if (!hide.has(node)) delete node.dataset.cgsHiddenUsage;
  }
  for (const node of hide) if (node.dataset.cgsHiddenUsage !== "1") node.dataset.cgsHiddenUsage = "1";
}

// ---- Settings → Usage: ompweb's cost figures in CGS terms (CNY) --------------------------------------------------------
// The CGS models are priced in yuan (plugin/omp-cgs: the site's real CNY prices become omp's `cost`), but ompweb's
// UsageConfig prints every cost with "$" under a "Raw Token Cost" heading. Its text nodes are rewritten in place: the
// heading/footnote (matched against ompweb's own strings in all four locales) and the currency glyph. Other providers'
// costs are real dollars: their provider rows and model rows keep "$", and the headline total shows the CGS part in ¥
// with the other providers' dollars as a smaller subtitle. Which provider is which comes from the same /api/usage
// report ompweb rendered (its request is seen through the resource timeline and repeated with a `cgs=1` marker).
const COST_LABELS = new Map([
  ...["Raw Token Cost", "原始 TOKEN 费用", "原始權杖費用", "RAW TOKEN COST"].map((text) => [text, "cost.title"]),
  ...["* if billed at full API rate", "* 按完整 API 费率估算", "* 若依全額 API 費率計費", "* フル API レートで請求された場合"].map((text) => [text, "cost.note"]),
]);
const DOLLAR_AMOUNT = /\$(?=-?[\d.,])/g;
const YUAN_AMOUNT = /¥(?=-?[\d.,])/g;
const USD_NOTE_ID = "cgs-usd-note";
let usageReport = null; // the /api/usage report ompweb shows
let usageReportRequest = null;

/** ompweb's formatCurrency with another glyph. */
function fmtMoney(glyph, amount) {
  if (!amount || Number.isNaN(amount)) return `${glyph}0.00`;
  if (amount > 0 && amount < 0.01) return `${glyph}${amount.toFixed(3)}`;
  return `${glyph}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fetchUsageReport(request) {
  usageReportRequest = request;
  fetch(`${request}${request.includes("?") ? "&" : "?"}cgs=1`)
    .then((response) => (response.ok ? response.json() : null))
    .then((report) => {
      if (report && usageReportRequest === request) {
        usageReport = report;
        schedule();
      }
    })
    .catch(() => {});
}

function watchUsageRequests() {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const url = new URL(entry.name, window.location.href);
        if (url.origin !== window.location.origin || url.pathname !== "/api/usage" || url.searchParams.has("cgs")) continue;
        url.searchParams.delete("refresh");
        fetchUsageReport(`${url.pathname}${url.search}`);
      }
    }).observe({ type: "resource", buffered: true });
  } catch {
    // no resource timing: every figure stays in ¥
  }
}

/** Marks ompweb's rows that belong to non-CGS providers (data-cgs-usd) so their costs keep "$". */
function markUsdRows(panel, ours, report) {
  const providers = Array.isArray(report.providers) ? report.providers : [];
  const usdProviders = new Set(providers.filter((p) => !isCgsProvider(p)).map((p) => p.name));
  const cgsProviderNames = new Set(providers.filter(isCgsProvider).map((p) => p.name));
  const models = Array.isArray(report.modelBreakdown) ? report.modelBreakdown : [];
  // A model name served by both sides is ambiguous: its row keeps ¥.
  const usdModels = new Set(models.filter((m) => !isCgsProvider(m)).map((m) => m.model));
  for (const m of models) if (isCgsProvider(m)) usdModels.delete(m.model);
  for (const span of panel.querySelectorAll("span")) {
    if (ours && ours.contains(span)) continue;
    const text = span.textContent;
    let row = null;
    if (usdProviders.has(text) && !cgsProviderNames.has(text)) row = span.closest('div[style*="space-between"]');
    else if (usdModels.has(text)) row = span.closest("tr");
    // Only rows that print a cost (a chart legend naming the provider is not one).
    if (row && row.dataset.cgsUsd !== "1" && /[$¥]-?[\d.,]/.test(row.textContent)) row.dataset.cgsUsd = "1";
  }
  return {
    cgs: providers.filter(isCgsProvider).reduce((sum, p) => sum + (Number(p.cost) || 0), 0),
    other: providers.filter((p) => !isCgsProvider(p)).reduce((sum, p) => sum + (Number(p.cost) || 0), 0),
    usdNames: usdProviders,
  };
}

function localizeUsageCosts() {
  const panel = !isLoadingScreen() ? document.querySelector(USAGE_PANEL_SELECTOR) : null;
  if (!panel) return;
  const ours = document.getElementById(USAGE_CARD_ID);
  const split = usageReport ? markUsdRows(panel, ours, usageReport) : null;
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (ours && ours.contains(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let titleLabel = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue;
    const label = COST_LABELS.get(value.trim()) || (value === t("cost.title") ? "cost.title" : null);
    let next = value;
    if (label) next = t(label);
    else if (node.parentElement && node.parentElement.closest('[data-cgs-usd="1"]')) next = value.replace(YUAN_AMOUNT, "$");
    else if (value.includes("$")) next = value.replace(DOLLAR_AMOUNT, "¥");
    if (next !== value) node.nodeValue = next;
    if (label === "cost.title") titleLabel = node.parentElement;
  }
  for (const node of panel.querySelectorAll("[title*='$']")) {
    if (ours && ours.contains(node)) continue;
    if (split && [...split.usdNames].some((name) => node.title.startsWith(`${name}:`))) continue;
    node.title = node.title.replace(DOLLAR_AMOUNT, "¥");
  }

  // Headline total: CGS part in ¥, other providers in $ as a subtitle.
  const figure = titleLabel && titleLabel.nextElementSibling;
  const amountRow = figure && figure.firstElementChild;
  const amount = amountRow && amountRow.querySelector("span");
  let note = document.getElementById(USD_NOTE_ID);
  if (!amount || !split || split.other <= 0) {
    note?.remove();
    return;
  }
  // React owns this text node: rewrite its value, never replace the node.
  const cgsText = fmtMoney("¥", split.cgs);
  const textNode = amount.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE && textNode.nodeValue !== cgsText) textNode.nodeValue = cgsText;
  if (!note) {
    note = el("div");
    note.id = USD_NOTE_ID;
  }
  if (note.previousElementSibling !== amountRow) amountRow.after(note);
  const noteText = t("cost.otherUsd", { amount: fmtMoney("$", split.other) });
  if (note.textContent !== noteText) note.textContent = noteText;
}

// ---- Settings → Agents: orchestrator --------------------------------------------------------------------------------
// A visual editor for config.yml's `modelRoles.default` (the orchestrator, i.e. the main model) and
// `task.agentModelOverrides` (one model per subagent). The default layout comes from the CGS server
// (GET /api/device/layout); its agents are always listed. Models are ompweb's own list (/api/models).
const AGENTS_PANEL_SELECTOR = "#settings-panel-agents";
const ORC_CARD_ID = "cgs-orchestrator-card";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const orc = {
  status: "idle", // idle | loading | ready | error
  error: null,
  saved: null, // { orchestrator, agents } as on disk (core agents merged in)
  draft: null,
  models: [], // ompweb modelList entries
  defaults: null, // server layout, or null when unavailable
  agentNames: [],
  busy: null, // "save" | "restore"
  message: null, // { tone, text }
  newName: "",
  newNameError: "",
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const coreAgents = () => (orc.defaults ? orc.defaults.agents.map((agent) => agent.name) : []);
const modelRef = (model) => `${model.provider}/${model.id}`;

/** The on-disk orchestration plus every core agent (an unset one shows as "agent default"). */
function withCoreAgents(orchestration) {
  const agents = orchestration.agents.map((agent) => ({ name: agent.name, model: agent.model, thinking: agent.thinking }));
  for (const name of coreAgents()) if (!agents.some((agent) => agent.name === name)) agents.push({ name, model: "", thinking: "" });
  const order = coreAgents();
  const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  agents.sort((a, b) => rank(a.name) - rank(b.name));
  return { orchestrator: { model: orchestration.orchestrator.model, thinking: orchestration.orchestrator.thinking }, agents };
}

async function loadOrchestration() {
  orc.status = "loading";
  orc.message = null;
  renderOrchestrator();
  const [current, models, defaults, agents] = await Promise.allSettled([
    desktop.getOrchestration(),
    fetch("/api/models").then((r) => (r.ok ? r.json() : null)),
    desktop.getDefaultLayout(),
    fetch("/api/agents").then((r) => (r.ok ? r.json() : null)),
  ]);
  orc.models = models.status === "fulfilled" && models.value && Array.isArray(models.value.modelList) ? models.value.modelList : [];
  orc.defaults = defaults.status === "fulfilled" && defaults.value && defaults.value.ok ? defaults.value.layout : null;
  orc.agentNames = agents.status === "fulfilled" && agents.value && Array.isArray(agents.value.agents)
    ? [...new Set(agents.value.agents.map((agent) => agent && agent.name).filter((name) => typeof name === "string"))].sort()
    : [];
  const result = current.status === "fulfilled" ? current.value : { ok: false, error: String(current.reason) };
  if (!result || !result.ok) {
    orc.status = "error";
    orc.error = (result && result.error) || t("pc.unknownError");
  } else {
    orc.status = "ready";
    orc.saved = withCoreAgents(result.orchestration);
    orc.draft = clone(orc.saved);
  }
  renderOrchestrator();
}

const isDirty = () => orc.saved !== null && JSON.stringify(orc.saved) !== JSON.stringify(orc.draft);

async function saveOrchestration() {
  if (orc.busy || !orc.draft.orchestrator.model) return;
  orc.busy = "save";
  orc.message = null;
  renderOrchestrator();
  let result;
  try {
    result = await desktop.saveOrchestration(orc.draft);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  orc.busy = null;
  if (result && result.ok) {
    orc.saved = withCoreAgents(result.orchestration);
    orc.draft = clone(orc.saved);
    orc.message = { tone: "ok", text: t("orc.saved") };
  } else {
    orc.message = { tone: "error", text: t("orc.saveFailed", { error: (result && result.error) || t("pc.unknownError") }) };
  }
  renderOrchestrator();
}

async function restoreDefaultLayout() {
  if (orc.busy) return;
  orc.busy = "restore";
  orc.message = null;
  renderOrchestrator();
  let result = null;
  try {
    result = await desktop.getDefaultLayout();
  } catch {
    // reported below
  }
  orc.busy = null;
  if (result && result.ok) {
    orc.defaults = result.layout;
    orc.draft = clone({ orchestrator: result.layout.orchestrator, agents: result.layout.agents });
    orc.message = { tone: "ok", text: t("orc.restored") };
  } else {
    orc.message = { tone: "error", text: t("orc.restoreUnavailable") };
  }
  renderOrchestrator();
}

function addRole() {
  const name = orc.newName.trim();
  if (!AGENT_NAME_RE.test(name)) orc.newNameError = t("orc.badName");
  else if (orc.draft.agents.some((agent) => agent.name === name)) orc.newNameError = t("orc.duplicate", { name });
  else {
    orc.draft.agents.push({ name, model: "", thinking: "" });
    orc.newName = "";
    orc.newNameError = "";
  }
  renderOrchestrator();
}

function thinkingOptions(model) {
  const known = orc.models.find((m) => modelRef(m) === model);
  if (!known || !Array.isArray(known.thinkingLevels)) return THINKING_LEVELS;
  return THINKING_LEVELS.filter((level) => level === "auto" || known.thinkingLevels.includes(level));
}

function buildModelSelect(entry, allowInherit, label) {
  const select = el("select", "cgs-orc-select");
  select.setAttribute("aria-label", label);
  if (allowInherit) select.append(new Option(t("orc.inherit"), ""));
  else if (!entry.model) select.append(new Option("—", ""));
  const groups = new Map();
  for (const model of orc.models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push(model);
  }
  if (entry.model && !orc.models.some((m) => modelRef(m) === entry.model)) select.append(new Option(t("orc.notListed", { model: entry.model }), entry.model));
  for (const [provider, models] of groups) {
    const group = document.createElement("optgroup");
    group.label = provider;
    for (const model of models) group.append(new Option(model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id, modelRef(model)));
    select.append(group);
  }
  select.value = entry.model;
  select.disabled = Boolean(orc.busy);
  select.addEventListener("change", () => {
    entry.model = select.value;
    if (!entry.model) entry.thinking = "";
    else if (entry.thinking && !thinkingOptions(entry.model).includes(entry.thinking)) entry.thinking = "";
    orc.message = null;
    renderOrchestrator();
  });
  return select;
}

function buildThinkingSelect(entry, label) {
  const select = el("select", "cgs-orc-select cgs-orc-thinking");
  select.setAttribute("aria-label", label);
  select.append(new Option(t("orc.thinkingDefault"), ""));
  const levels = thinkingOptions(entry.model);
  for (const level of entry.thinking && !levels.includes(entry.thinking) ? [...levels, entry.thinking] : levels) select.append(new Option(t(`think.${level}`), level));
  select.value = entry.thinking;
  select.disabled = Boolean(orc.busy) || !entry.model;
  select.addEventListener("change", () => {
    entry.thinking = select.value;
    orc.message = null;
    renderOrchestrator();
  });
  return select;
}

function buildRoleNode(entry, { root, removable }) {
  const node = el("div", `cgs-orc-node${root ? " cgs-orc-root" : ""}`);
  const head = el("div", "cgs-orc-node-head");
  head.append(el("span", "cgs-orc-dot"), el("span", "cgs-orc-name", root ? "Orchestrator" : entry.name), el("span", "cgs-orc-badge", root ? t("orc.orchestrator") : t("orc.subagent")));
  if (removable) {
    const remove = el("button", "cgs-icon-btn cgs-orc-remove");
    remove.type = "button";
    remove.title = t("orc.remove");
    remove.setAttribute("aria-label", `${t("orc.remove")}: ${entry.name}`);
    remove.innerHTML = ICONS.close;
    remove.disabled = Boolean(orc.busy);
    remove.addEventListener("click", () => {
      orc.draft.agents = orc.draft.agents.filter((agent) => agent !== entry);
      renderOrchestrator();
    });
    head.append(remove);
  }
  const fields = el("div", "cgs-orc-fields");
  const name = root ? "Orchestrator" : entry.name;
  const modelField = el("label", "cgs-orc-field");
  modelField.append(el("span", "cgs-uc-muted", t("orc.model")), buildModelSelect(entry, !root, `${name} · ${t("orc.model")}`));
  const thinkingField = el("label", "cgs-orc-field cgs-orc-field-narrow");
  thinkingField.append(el("span", "cgs-uc-muted", t("orc.thinking")), buildThinkingSelect(entry, `${name} · ${t("orc.thinking")}`));
  fields.append(modelField, thinkingField);
  node.append(head, fields);
  return node;
}

function buildAddRole() {
  const wrap = el("div", "cgs-orc-node cgs-orc-add");
  const input = el("input", "cgs-orc-input");
  input.type = "text";
  input.placeholder = t("orc.addPlaceholder");
  input.value = orc.newName;
  input.setAttribute("aria-label", t("orc.addRole"));
  input.setAttribute("list", "cgs-orc-agent-names");
  input.disabled = Boolean(orc.busy);
  input.addEventListener("input", () => {
    orc.newName = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addRole();
    }
  });
  const names = el("datalist");
  names.id = "cgs-orc-agent-names";
  for (const name of orc.agentNames) if (!orc.draft.agents.some((agent) => agent.name === name)) names.append(new Option(name, name));
  const button = el("button", "cgs-pc-btn", `+ ${t("orc.add")}`);
  button.type = "button";
  button.dataset.action = "cgs-orc-add";
  if (orc.busy) button.setAttribute("aria-disabled", "true");
  button.addEventListener("click", () => {
    if (!orc.busy) addRole();
  });
  const row = el("div", "cgs-orc-add-row");
  row.append(el("span", "cgs-orc-name", t("orc.addRole")), input, button);
  wrap.append(row, names);
  if (orc.newNameError) wrap.append(el("div", "cgs-orc-error", orc.newNameError));
  return wrap;
}

function renderOrchestrator() {
  const card = document.getElementById(ORC_CARD_ID);
  if (!card) return;
  const sig = JSON.stringify([orc.status, orc.error, orc.draft, orc.saved, orc.models.length, orc.defaults, orc.agentNames, orc.busy, orc.message, orc.newNameError, locale()]);
  sync(card, sig, () => {
    const head = el("div", "cgs-uc-head");
    head.append(el("span", "cgs-uc-title", t("orc.title")), el("span", "cgs-uc-spacer"));
    const children = [head, el("div", "cgs-uc-muted", t("orc.desc"))];
    if (orc.status === "loading" || orc.status === "idle") {
      children.push(el("div", "cgs-uc-muted", t("orc.loading")));
    } else if (orc.status === "error") {
      children.push(el("div", "cgs-orc-error", t("orc.loadFailed", { error: orc.error })));
    } else {
      const tree = el("div", "cgs-orc-tree");
      tree.append(buildRoleNode(orc.draft.orchestrator, { root: true, removable: false }));
      const branches = el("div", "cgs-orc-branches");
      const core = coreAgents();
      for (const agent of orc.draft.agents) {
        const branch = el("div", "cgs-orc-branch");
        branch.append(buildRoleNode(agent, { root: false, removable: !core.includes(agent.name) }));
        branches.append(branch);
      }
      const addBranch = el("div", "cgs-orc-branch");
      addBranch.append(buildAddRole());
      branches.append(addBranch);
      tree.append(branches);
      children.push(tree);

      const actions = el("div", "cgs-pc-actions");
      const dirty = isDirty();
      const status = orc.message
        ? el("span", orc.message.tone === "error" ? "cgs-orc-error" : "cgs-uc-muted", orc.message.text)
        : !orc.draft.orchestrator.model ? el("span", "cgs-orc-error", t("orc.needModel"))
        : dirty ? el("span", "cgs-uc-muted", t("orc.unsaved")) : null;
      const restore = el("button", "cgs-pc-btn", orc.busy === "restore" ? t("orc.loading") : t("orc.restore"));
      restore.type = "button";
      restore.dataset.action = "cgs-orc-restore";
      const revert = el("button", "cgs-pc-btn", t("orc.revert"));
      revert.type = "button";
      revert.dataset.action = "cgs-orc-revert";
      const save = el("button", "cgs-pc-btn", orc.busy === "save" ? t("orc.saving") : t("orc.save"));
      save.type = "button";
      save.dataset.action = "cgs-orc-save";
      save.dataset.variant = "primary";
      if (orc.busy) restore.setAttribute("aria-disabled", "true");
      if (orc.busy || !dirty) revert.setAttribute("aria-disabled", "true");
      if (orc.busy || !dirty || !orc.draft.orchestrator.model) save.setAttribute("aria-disabled", "true");
      restore.addEventListener("click", () => void restoreDefaultLayout());
      revert.addEventListener("click", () => {
        if (orc.busy || !isDirty()) return;
        orc.draft = clone(orc.saved);
        orc.message = null;
        renderOrchestrator();
      });
      save.addEventListener("click", () => {
        if (save.getAttribute("aria-disabled") !== "true") void saveOrchestration();
      });
      const spacer = el("span", "cgs-uc-spacer");
      actions.append(restore, spacer);
      if (status) actions.append(status);
      actions.append(revert, save);
      children.push(actions);
    }
    card.replaceChildren(...children);
  });
}

function ensureOrchestratorCard() {
  const panel = !isLoadingScreen() && cgsState && cgsState.signedIn ? document.querySelector(AGENTS_PANEL_SELECTOR) : null;
  const existing = document.getElementById(ORC_CARD_ID);
  if (!panel) {
    existing?.remove();
    // Re-read config.yml the next time the panel opens (ompweb's own model settings may have changed it meanwhile).
    if (!orc.busy) orc.status = "idle";
    return;
  }
  const card = existing || el("section");
  card.id = ORC_CARD_ID;
  const first = panel.firstElementChild === card ? card.nextElementSibling : panel.firstElementChild;
  if (first && card.previousElementSibling !== first) first.after(card);
  else if (!first && card.parentElement !== panel) panel.append(card);
  if (orc.status === "idle") void loadOrchestration();
  renderOrchestrator();
}

// ---- self-update (Settings → System card + "ready" banner) ------------------------------------------------------------
const SYSTEM_PANEL_SELECTOR = "#settings-panel-system";
const UPDATE_CARD_ID = "cgs-update-card";
const UPDATE_BANNER_ID = "cgs-update-banner";
let updateState = null; // see updater.js UpdateState
let updateBannerDismissed = null; // the version whose banner was dismissed

function updateStatusText(state) {
  switch (state.status) {
    case "disabled": return t("upd.disabled");
    case "checking": return t("upd.checking");
    case "latest": return t("upd.latest");
    case "available":
    case "downloading": return t("upd.downloading", { version: state.version || "", percent: state.percent || 0 });
    case "downloaded": return t("upd.downloaded", { version: state.version || "" });
    case "error": return t("upd.error", { error: state.error || t("pc.unknownError") });
    default: return t("upd.idle");
  }
}

function updateButtons(state) {
  const buttons = [];
  if (state.status === "downloaded") {
    const install = el("button", "cgs-pc-btn", t("upd.install"));
    install.type = "button";
    install.dataset.action = "cgs-update-install";
    install.dataset.variant = "primary";
    install.addEventListener("click", () => void desktop.installUpdate());
    buttons.push(install);
  } else if (state.status !== "disabled") {
    const check = el("button", "cgs-pc-btn", t("upd.check"));
    check.type = "button";
    check.dataset.action = "cgs-update-check";
    const busy = state.status === "checking" || state.status === "available" || state.status === "downloading";
    if (busy) check.setAttribute("aria-disabled", "true");
    check.addEventListener("click", () => {
      if (!busy) void desktop.checkUpdate().then((next) => next && setUpdateState(next));
    });
    buttons.push(check);
  }
  return buttons;
}

function ensureUpdateCard() {
  const panel = !isLoadingScreen() && updateState ? document.querySelector(SYSTEM_PANEL_SELECTOR) : null;
  const existing = document.getElementById(UPDATE_CARD_ID);
  if (!panel) {
    existing?.remove();
    return;
  }
  const card = existing || el("section");
  card.id = UPDATE_CARD_ID;
  const first = panel.firstElementChild === card ? card.nextElementSibling : panel.firstElementChild;
  if (first && card.previousElementSibling !== first) first.after(card);
  else if (!first && card.parentElement !== panel) panel.append(card);
  sync(card, JSON.stringify([updateState, locale()]), () => {
    const head = el("div", "cgs-uc-head");
    head.append(el("span", "cgs-uc-title", t("upd.title")), el("span", "cgs-uc-spacer"), el("span", "cgs-uc-pill", `v${updateState.current}`));
    const actions = el("div", "cgs-pc-actions");
    actions.append(el("span", updateState.status === "error" ? "cgs-orc-error" : "cgs-uc-muted", updateStatusText(updateState)), el("span", "cgs-uc-spacer"), ...updateButtons(updateState));
    const children = [head, el("div", "cgs-uc-muted", t("upd.current", { version: updateState.current })), actions];
    if (updateState.status === "downloading" || updateState.status === "available") children.splice(2, 0, makeBar(updateState.percent || 0));
    card.replaceChildren(...children);
  });
}

function ensureUpdateBanner() {
  const show = !isLoadingScreen() && updateState && updateState.status === "downloaded" && updateBannerDismissed !== updateState.version;
  const existing = document.getElementById(UPDATE_BANNER_ID);
  if (!show || !document.body) {
    existing?.remove();
    return;
  }
  const banner = existing || el("div");
  banner.id = UPDATE_BANNER_ID;
  banner.setAttribute("role", "status");
  if (!existing) document.body.append(banner);
  sync(banner, JSON.stringify([updateState.version, locale()]), () => {
    const later = el("button", "cgs-pc-btn", t("upd.later"));
    later.type = "button";
    later.addEventListener("click", () => {
      updateBannerDismissed = updateState.version;
      ensureUpdateBanner();
    });
    banner.replaceChildren(el("span", "", updateStatusText(updateState)), later, ...updateButtons(updateState));
  });
}

function setUpdateState(state) {
  updateState = state;
  ensureUpdateCard();
  ensureUpdateBanner();
}

function renderDesktopUi() {
  localizeUsageCosts();
  ensureOrchestratorCard();
  ensureUpdateCard();
  ensureUpdateBanner();
  const root = document.getElementById(ROOT_ID);
  if (root && root.dataset.cgsLocale !== locale()) renderIcons(root);
}

function renderUsageUi() {
  syncProviderUsageVisibility();
  ensureUsageRow();
  ensureUsageCard();
  ensureProvidersCard();
}

function renderCgsUi() {
  renderBranding();
  renderUsageUi();
}

function ensure() {
  scheduled = false;
  if (!document.documentElement) return;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = buildControls();
    renderIcons(root);
  }
  const opener = document.querySelector(OPENER_SELECTOR);
  if (opener) {
    if (root.previousElementSibling !== opener || root.parentElement !== opener.parentElement) opener.after(root);
    root.classList.remove("cgs-floating");
  } else if (root.parentElement !== document.body || !root.classList.contains("cgs-floating")) {
    if (!document.body) return;
    root.classList.add("cgs-floating");
    document.body.append(root);
  }
  if (document.body && !document.getElementById(OVERLAY_ID)) {
    document.body.append(buildOverlay());
  }
  renderCgsUi();
  renderDesktopUi();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(ensure);
}

function setMaximized(value) {
  maximized = value;
  const root = document.getElementById(ROOT_ID);
  if (root) renderIcons(root);
}

ipcRenderer.on("cgs:window-state", (_event, state) => setMaximized(Boolean(state && state.maximized)));
bridge.onState((state) => {
  cgsState = state;
  renderCgsUi();
});
/** The relay endpoint in use ("label@ip"), or null while the agent reaches the server directly. */
let networkRelay = null;
function setNetwork(status) {
  networkRelay = status && status.mode === "relay" ? status.endpoint || "relay" : null;
  renderUsageUi();
}
bridge.onNetwork(setNetwork);
bridge.onUsage((snap) => {
  usageState = snap;
  renderUsageUi();
});
ipcRenderer.on("cgs:update", (_event, state) => setUpdateState(state));

window.addEventListener("DOMContentLoaded", () => {
  ensure();
  if (isAppPage) watchUsageRequests();
  // characterData: ompweb animates the header label by rewriting a text node in place. The header label is branded right
  // away (before the next paint); everything else is re-rendered on the next animation frame.
  const observer = new MutationObserver(() => {
    if (!isLoadingScreen()) brandHeaderLabel();
    schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  // ompweb flips data-theme / class on OS changes and on user picks: re-evaluate whether to override. `lang` follows its
  // language setting: the injected UI re-renders in the new language.
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "lang"] });
  desktop.getUpdate().then((state) => state && setUpdateState(state));
  ipcRenderer.invoke("cgs:window-get-state").then((state) => setMaximized(Boolean(state && state.maximized)));
  ipcRenderer.invoke("cgs:get-logo").then((url) => {
    if (url) {
      cgsLogoUrl = url;
      renderCgsUi();
    }
  });
  bridge.getNetwork().then(setNetwork);
  bridge.getUsage().then((snap) => {
    if (snap) {
      usageState = snap;
      renderUsageUi();
    }
  });
  // Relative times ("in 3 h") age while nothing else changes.
  setInterval(renderUsageUi, 60_000);
  bridge.getState().then((state) => {
    if (state) {
      cgsState = state;
      renderCgsUi();
    }
  });
});
