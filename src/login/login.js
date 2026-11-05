"use strict";

(() => {
  const api = window.cgsLogin;
  const $ = id => document.getElementById(id);
  const STEPS = ["creating", "solving", "saving"];
  const STEP_TITLES = { creating: "正在创建登录会话", solving: "正在进行安全校验", saving: "正在保存配置" };
  const TIER_LABELS = { free: "免费版", go: "Go", pro: "Pro", dedicated: "专属版" };

  let countdownTimer = null;
  let toastTimer = null;

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function startCountdown(expiresAt) {
    stopCountdown();
    const tick = () => {
      $("countdown").textContent = formatRemaining(expiresAt - Date.now());
    };
    tick();
    countdownTimer = setInterval(tick, 500);
  }

  function renderProgress(step) {
    $("progress-title").textContent = STEP_TITLES[step] || STEP_TITLES.creating;
    const current = STEPS.indexOf(step);
    document.querySelectorAll(".steps li").forEach(li => {
      const idx = STEPS.indexOf(li.dataset.step);
      li.classList.toggle("done", idx < current);
      li.classList.toggle("active", idx === current);
      // "saving" only appears once the approval arrived; hide it before that.
      li.hidden = li.dataset.step === "saving" && current < 2;
    });
  }

  function render(state) {
    stopCountdown();
    $("toast").classList.remove("show");
    document.body.dataset.screen = state.screen;
    switch (state.screen) {
      case "progress":
        renderProgress(state.step);
        break;
      case "waiting":
        $("link-text").textContent = state.verificationUrl;
        startCountdown(state.expiresAt);
        break;
      case "success":
        $("acc-name").textContent = state.username || "已登录";
        $("acc-tier").textContent = TIER_LABELS[state.tier] || state.tier || "";
        $("acc-tier").hidden = !state.tier;
        break;
      case "error":
        $("error-text").textContent = state.message;
        break;
      default:
        break;
    }
  }

  $("btn-login").addEventListener("click", () => api.start());
  $("btn-retry").addEventListener("click", () => api.start());
  $("btn-cancel-progress").addEventListener("click", () => api.cancel());
  $("btn-cancel-wait").addEventListener("click", () => api.cancel());
  $("btn-open").addEventListener("click", () => api.openLink());
  $("btn-copy").addEventListener("click", async () => {
    await api.copyLink();
    toast("链接已复制");
  });
  $("btn-third").addEventListener("click", () => api.thirdParty());
  $("btn-third-2").addEventListener("click", () => api.thirdParty());
  $("btn-close").addEventListener("click", () => api.close());
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") api.close();
  });

  api.onState(render);
  api.ready().then(state => state && render(state));
})();
