"use strict";

(() => {
  const api = window.cgsLogin;
  const $ = id => document.getElementById(id);
  const STEPS = ["creating", "solving", "saving"];
  const STEP_TITLES = { creating: "正在创建登录会话", solving: "正在进行安全校验", saving: "正在保存配置" };
  const REGISTER_TITLES = { creating: "正在创建注册会话", solving: "正在进行安全校验", sending: "正在发送验证码", registering: "正在创建账号", saving: "正在保存配置" };
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

  function renderProgress(state) {
    // Registration passes its own step list; the login flow shows "saving" only once the approval arrived.
    const steps = state.steps || STEPS;
    const titles = state.steps ? REGISTER_TITLES : STEP_TITLES;
    $("progress-title").textContent = titles[state.step] || titles.creating;
    const current = steps.indexOf(state.step);
    document.querySelectorAll(".steps li").forEach(li => {
      const idx = steps.indexOf(li.dataset.step);
      li.classList.toggle("done", idx !== -1 && idx < current);
      li.classList.toggle("active", idx === current);
      li.hidden = idx === -1 || (!state.steps && li.dataset.step === "saving" && current < 2);
    });
  }

  function showFormError(id, text) {
    const el = $(id);
    el.textContent = text;
    el.hidden = !text;
  }

  // Code lifetime and the resend cooldown, both ticking while the verify screen is shown.
  function startVerifyTimers({ expiresAt, resendAt }) {
    const tick = () => {
      const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      $("verify-left").textContent = formatRemaining(expiresAt - Date.now());
      $("btn-resend").disabled = left > 0;
      $("btn-resend").textContent = left > 0 ? `重新发送（${left}s）` : "重新发送";
    };
    tick();
    countdownTimer = setInterval(tick, 500);
  }

  function render(state) {
    stopCountdown();
    $("toast").classList.remove("show");
    document.body.dataset.screen = state.screen;
    switch (state.screen) {
      case "progress":
        renderProgress(state);
        break;
      case "waiting":
        $("link-text").textContent = state.verificationUrl;
        startCountdown(state.expiresAt);
        break;
      case "register":
        $("reg-email").value = state.email || $("reg-email").value;
        $("reg-password").value = "";
        $("reg-password2").value = "";
        showFormError("reg-error", state.error || "");
        ($("reg-email").value ? $("reg-password") : $("reg-email")).focus();
        break;
      case "verify":
        $("verify-email").textContent = state.email;
        $("verify-code").value = "";
        showFormError("verify-error", state.error || "");
        startVerifyTimers(state);
        $("verify-code").focus();
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
  $("btn-close").addEventListener("click", () => api.close());
  $("btn-register").addEventListener("click", () => api.registerOpen());
  $("btn-register-close").addEventListener("click", () => api.registerClose());
  $("btn-verify-back").addEventListener("click", () => api.registerBack());
  $("btn-resend").addEventListener("click", () => api.registerResend());
  $("register-form").addEventListener("submit", e => {
    e.preventDefault();
    const email = $("reg-email").value.trim();
    const password = $("reg-password").value;
    if (password !== $("reg-password2").value) return showFormError("reg-error", "两次输入的密码不一致");
    showFormError("reg-error", "");
    return api.registerSubmit({ email, password });
  });
  $("verify-form").addEventListener("submit", e => {
    e.preventDefault();
    showFormError("verify-error", "");
    return api.registerVerify($("verify-code").value);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") api.close();
  });

  api.onState(render);
  api.ready().then(state => state && render(state));
})();
