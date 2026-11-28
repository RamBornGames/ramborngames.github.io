(function () {
  "use strict";

  function normalizePhone(value) {
    const phone = value.trim().replace(/[\s()-]/g, "");
    return /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone : "";
  }

  async function createOAuthChallenge(webCrypto) {
    function base64url(bytes) {
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    const verifier = base64url(webCrypto.getRandomValues(new Uint8Array(32)));
    const digest = await webCrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: base64url(new Uint8Array(digest)) };
  }

  function oauthDestination(value, provider) {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.host) || url.username || url.password
      || url.pathname !== "/auth/v1/authorize" || url.searchParams.get("provider") !== provider) throw new Error("oauth_failed");
    return url.href;
  }

  function createPlayerSavesPanel({ entry, saves, request, isMenuVisible, canReachAccounts, assetUrl, modes }) {
    const errors = {
      invalid_credentials: "That username and password did not match.",
      invalid_username: "Choose a 3–24 character username using letters, numbers, underscores or hyphens.",
      invalid_password: "Choose a password with 15–128 characters.",
      username_unavailable: "That username is taken. Try another.",
      invalid_phone: "Enter your phone number with its country code, such as +1.",
      invalid_code: "That code is incorrect or expired. Check the code or request a new one.",
      captcha_required: "Complete the security check first.",
      captcha_failed: "The security check expired or failed. Please try again.",
      oauth_expired: "Sign-in expired. Please start again.",
      oauth_failed: "Sign-in could not finish. Please try again.",
      provider_disabled: "That sign-in option is currently unavailable.",
      rate_limited: "Too many attempts. Wait a minute and try again.",
      unavailable: "Account service is unavailable. You can keep playing with a local save."
    };

    const cookie = "asteroids_save_username";
    function usernameCookie() {
      try {
        return document.cookie.split("; ").find(value => value.startsWith(cookie + "="))?.slice(cookie.length + 1) ?? "";
      } catch {
        return "";
      }
    }
    function rememberUsername(username) {
      const age = username ? 31536000 : 0;
      try {
        document.cookie = cookie + "=" + username + "; Path=/asteroids/; Max-Age=" + age + "; SameSite=Strict; Secure";
      } catch {
        // Autosave does not depend on the username preference.
      }
    }

    let panel;
    let busy = false;
    let cloudAvailable = null;
    let passwordEnabled = true;
    let providers = {};
    let captchaSiteKey;
    let turnstileScript;
    let authFlow;
    let usePassword = false;
    let action = "login";
    let formMessage = "";
    const providerNames = { google: "Google", apple: "Apple", phone: "phone" };
    const find = id => panel.querySelector("#player-" + id);
    const canAuthenticate = () => isMenuVisible() && panel?.open;
    const flowActive = flow => flow && canAuthenticate() && authFlow === flow && !flow.controller.signal.aborted;
    const post = (path, body, flow) => request(path, { method: "POST", body, signal: flow?.controller.signal });

    function resetAuth() {
      const flow = authFlow;
      authFlow = undefined;
      usePassword = false;
      if (!flow) return;
      flow.controller.abort();
      clearTimeout(flow.poll);
      try { flow.popup?.close(); } catch { /* The other browser may own this tab. */ }
      if (flow.widget != null) window.turnstile.remove(flow.widget);
      if (flow.kind === "phone") {
        find("phone-form").reset();
        find("code-form").reset();
      }
    }

    function authError(error) {
      return Object.hasOwn(errors, error.message) ? errors[error.message] : errors.unavailable;
    }

    function finishProvider(flow, reply) {
      if (!flowActive(flow)) {
        saves.discardSession(reply.token);
        return;
      }
      formMessage = "";
      saves.acceptProviderSession(reply);
      resetAuth();
      refreshPanel();
      find("sync-status").focus();
    }

    async function pollOAuth(flow) {
      if (!flowActive(flow) || flow.checking) return;
      clearTimeout(flow.poll);
      flow.checking = true;
      let delay = 3500;
      try {
        const now = Date.now();
        if (now >= flow.expiresAt) throw new Error("oauth_expired");
        if (document.visibilityState === "visible" && now >= flow.nextCheckAt) {
          flow.nextCheckAt = now + delay;
          const reply = await post("/v1/auth/oauth/finish", { attempt: flow.attempt, verifier: flow.verifier }, flow);
          if (!reply.pending) {
            finishProvider(flow, reply);
            return;
          }
        }
      } catch (error) {
        if (!flowActive(flow)) return;
        if (["oauth_expired", "oauth_failed", "provider_disabled", "invalid_request", "unauthorized"].includes(error.message)) {
          resetAuth();
          formMessage = authError(error);
          refreshPanel();
          find("auth-title").focus();
          return;
        }
        delay = 10000;
        flow.nextCheckAt = Date.now() + delay;
      } finally {
        flow.checking = false;
      }
      if (flowActive(flow)) flow.poll = setTimeout(() => pollOAuth(flow), delay);
    }

    async function startOAuth(provider) {
      // Open a tab during the click so mobile browsers can keep the current game session.
      const flow = { kind: "oauth", provider, controller: new AbortController(), expiresAt: Date.now() + 300000, nextCheckAt: 0 };
      try {
        // On an installed web app, leaving for a blank tab can suspend the auth request mid-flight.
        const installed = navigator.standalone || ["standalone", "fullscreen", "minimal-ui"].some(mode =>
          window.matchMedia("(display-mode: " + mode + ")").matches);
        if (!installed) flow.popup = window.open("about:blank", "_blank");
        if (flow.popup) flow.popup.opener = null;
      } catch {
        try { flow.popup?.close(); } catch { /* The user can close their tab. */ }
        flow.popup = undefined;
      }
      authFlow = flow;
      formMessage = "";
      refreshPanel();
      find("oauth-title").focus();
      try {
        const { verifier, challenge } = await createOAuthChallenge(window.crypto);
        const reply = await post("/v1/auth/oauth/start", { provider, challenge }, flow);
        if (!flowActive(flow)) return;
        if (typeof reply.attempt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(reply.attempt)) throw new Error("oauth_failed");
        flow.attempt = reply.attempt;
        flow.verifier = verifier;
        flow.url = oauthDestination(reply.url, provider);
        try { flow.popup?.location.replace(flow.url); } catch { /* The link opens a new tab. */ }
        refreshPanel();
        pollOAuth(flow);
      } catch (error) {
        if (!flowActive(flow)) return;
        resetAuth();
        formMessage = authError(error);
        refreshPanel();
        find("auth-title").focus();
      }
    }

    function loadTurnstile() {
      if (window.turnstile) return Promise.resolve(window.turnstile);
      if (turnstileScript) return turnstileScript;
      turnstileScript = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        const fail = () => {
          clearTimeout(timer);
          script.remove();
          reject(new Error("captcha_failed"));
        };
        const timer = setTimeout(fail, 10000);
        script.onload = () => {
          clearTimeout(timer);
          if (window.turnstile) resolve(window.turnstile);
          else fail();
        };
        script.onerror = fail;
        document.head.appendChild(script);
      }).catch(error => {
        turnstileScript = undefined;
        throw error;
      });
      return turnstileScript;
    }

    async function startPhone() {
      const flow = authFlow = { kind: "phone", controller: new AbortController() };
      formMessage = "";
      refreshPanel();
      find("phone-form").elements.phone.focus();
      try {
        const turnstile = await loadTurnstile();
        if (!flowActive(flow)) return;
        const invalidate = () => {
          if (!flowActive(flow)) return;
          flow.captchaToken = undefined;
          refreshPanel();
        };
        const captcha = find("captcha");
        flow.widget = turnstile.render(captcha, {
          sitekey: captchaSiteKey,
          theme: "dark",
          size: captcha.clientWidth < 300 ? "compact" : "flexible",
          "response-field": false,
          callback(token) {
            if (!flowActive(flow)) return;
            flow.captchaToken = token;
            refreshPanel();
          },
          "expired-callback": invalidate,
          "error-callback": invalidate
        });
      } catch (error) {
        if (!flowActive(flow)) return;
        formMessage = authError(error);
        refreshPanel();
      }
    }

    function submitPhone(event) {
      event.preventDefault();
      const flow = authFlow;
      if (!flowActive(flow) || !flow.captchaToken) return;
      const input = event.currentTarget.elements.phone;
      const phone = normalizePhone(input.value);
      if (!phone) {
        input.setCustomValidity(errors.invalid_phone);
        input.reportValidity();
        return;
      }
      run(async () => {
        const captchaToken = flow.captchaToken;
        flow.captchaToken = undefined;
        try {
          await post("/v1/auth/phone/send", { phone, captchaToken }, flow);
          if (flowActive(flow)) {
            flow.phone = phone;
            input.value = "";
            refreshPanel();
            find("code-form").elements.code.focus();
          }
        } finally {
          if (flowActive(flow) && !flow.phone && flow.widget != null) window.turnstile.reset(flow.widget);
        }
      });
    }

    function submitCode(event) {
      event.preventDefault();
      const flow = authFlow;
      if (!flowActive(flow) || !flow.phone) return;
      const input = event.currentTarget.elements.code;
      const code = input.value.trim();
      input.value = "";
      run(async () => {
        try {
          const reply = await post("/v1/auth/phone/verify", { phone: flow.phone, code }, flow);
          finishProvider(flow, reply);
        } finally {
          if (flowActive(flow)) input.focus();
        }
      });
    }

    let lastAutosave;
    let autosaveTimer;

    function refreshAutosave() {
      const node = find("autosave");
      let message = "Progress saves automatically as you play.";
      if (lastAutosave) {
        const seconds = Math.max(0, Math.floor((Date.now() - lastAutosave.at) / 1000));
        const [age, unit] = seconds < 60 ? [seconds, "second"]
          : seconds < 3600 ? [Math.floor(seconds / 60), "minute"]
          : seconds < 86400 ? [Math.floor(seconds / 3600), "hour"]
          : [Math.floor(seconds / 86400), "day"];
        message = `Progress saved automatically (${age} ${unit}${age === 1 ? "" : "s"} ago) from ${modes[lastAutosave.mode]}.`;
      }
      if (node.textContent !== message) node.textContent = message;
    }

    function refreshPanel() {
      const view = saves.snapshot();
      lastAutosave = view.lastAutosave;
      refreshAutosave();
      find("profile").textContent = view.displayName || "Guest on this device";
      panel.querySelector("#player-checkpoint").textContent = view.save.puzzle.active
        ? "Puzzle Fishing saved at round " + view.save.puzzle.round + ". Open the mode to resume."
        : "Puzzle Fishing autosaves while you play.";
      for (const node of panel.querySelectorAll("[data-score]")) node.textContent = view.save.highScores[node.dataset.score].toLocaleString();
      panel.querySelector("#player-sync-status").textContent = formMessage || (!view.storageAvailable
        ? "Browser storage is unavailable. Keep this page open to retain unsynced progress." : view.status);
      const hasProviders = Object.values(providers).some(Boolean);
      const canSignIn = cloudAvailable === true && (hasProviders || passwordEnabled);
      find("auth").hidden = view.signedIn || !canSignIn;
      find("provider-choices").hidden = !hasProviders || usePassword || Boolean(authFlow);
      for (const button of panel.querySelectorAll("[data-auth-provider]")) {
        button.hidden = !providers[button.dataset.authProvider];
        const artwork = button.firstElementChild;
        if (!button.hidden && artwork?.dataset.src && !artwork.hasAttribute("src")) {
          artwork.src = assetUrl(artwork.dataset.src);
        }
      }
      find("password-option").hidden = !passwordEnabled;
      find("account-form").hidden = !passwordEnabled || Boolean(authFlow) || (hasProviders && !usePassword);
      find("back").hidden = !authFlow && !usePassword;
      find("back").textContent = authFlow?.kind === "oauth" ? "Cancel sign-in" : "Back to sign-in options";
      find("oauth").hidden = authFlow?.kind !== "oauth";
      find("oauth-link").hidden = !authFlow?.url;
      find("oauth-link").href = authFlow?.url ?? "#";
      find("oauth-link").textContent = authFlow?.url ? "Open " + providerNames[authFlow.provider] + " sign-in" : "";
      find("oauth-status").textContent = authFlow?.url
        ? "Finish in the new tab or browser, then return here. Keep this game open."
        : "Opening sign-in…";
      find("phone-form").hidden = authFlow?.kind !== "phone" || Boolean(authFlow.phone);
      find("code-form").hidden = authFlow?.kind !== "phone" || !authFlow.phone;
      find("captcha").hidden = Boolean(authFlow?.phone);
      panel.querySelector("#player-copy").hidden = !view.signedIn || !view.hasGuestProgress;
      panel.querySelector("#player-signout").hidden = !view.displayName;
      panel.querySelector("#player-install").hidden = typeof window.asteroidsShowInstall !== "function";
      const availability = panel.querySelector("#player-accounts-availability");
      availability.hidden = view.signedIn || canSignIn;
      availability.textContent = canReachAccounts && cloudAvailable === null ? "Checking cloud save availability…"
        : "Sign-in is unavailable right now. Progress can still save on this device.";
      for (const button of panel.querySelectorAll("button")) button.disabled = busy;
      find("send-code").disabled = busy || !authFlow?.captchaToken;
    }

    function openPanel() {
      if (!isMenuVisible()) return;
      if (!panel) {
        panel = document.createElement("dialog");
        panel.className = "player-saves-panel";
        panel.setAttribute("aria-labelledby", "player-saves-title");
        panel.innerHTML = `<header><div><h1 id="player-saves-title">Player saves</h1><p id="player-profile"></p></div>
          <button type="button" id="player-close" aria-label="Close player saves" autofocus>×</button></header>
          <section aria-label="Personal bests"><h2>Personal bests</h2><dl>${Object.entries(modes).map(([key, label]) =>
            `<div><dt>${label}</dt><dd data-score="${key}">0</dd></div>`).join("")}</dl><p id="player-checkpoint"></p></section>
          <section id="player-auth">
          <div id="player-provider-choices">
            <h2 id="player-auth-title" tabindex="-1">Sign in or create an account</h2>
            <div class="player-auth-providers">
              <button type="button" data-auth-provider="google" class="player-auth-brand"><img alt="Sign in with Google" data-src="sign-in-with-google.png"></button>
              <button type="button" data-auth-provider="apple" class="player-auth-brand"><img alt="Continue with Apple" data-src="continue-with-apple.png"></button>
              <button type="button" data-auth-provider="phone">Continue with phone</button>
            </div>
            <button type="button" id="player-password-option" class="player-secondary">Use username and password</button>
          </div>
          <div id="player-oauth" hidden>
            <h2 id="player-oauth-title" tabindex="-1">Complete sign-in</h2>
            <p id="player-oauth-status" role="status"></p>
            <a id="player-oauth-link" class="player-auth-link" target="_blank" rel="noopener noreferrer" hidden></a>
          </div>
          <form id="player-phone-form" hidden>
            <h2>Continue with phone</h2>
            <label>Phone number <input name="phone" type="tel" autocomplete="tel" placeholder="+1 415 555 0134" aria-describedby="player-phone-help" maxlength="32" required></label>
            <p id="player-phone-help">Include your country code. By tapping Send code you agree to receive a sign-in text. Message and data rates may apply.</p>
            <div id="player-captcha"></div>
            <button type="submit" id="player-send-code">Send code</button>
          </form>
          <form id="player-code-form" hidden>
            <h2>Enter the code</h2>
            <label>6-digit code <input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
            <button type="submit">Verify code</button>
            <button type="button" id="player-resend" class="player-secondary">Change number or resend</button>
          </form>
          <form id="player-account-form"><h2 id="player-form-title">Sign in to sync saves</h2>
            <label>Username<input name="username" autocomplete="username" minlength="3" maxlength="24" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{2,23}" autocapitalize="none" spellcheck="false" required></label>
            <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
            <label class="player-remember"><input type="checkbox" name="remember"> Remember my username</label>
            <p id="player-register-help" hidden>Use a password with at least 15 characters. Your guest progress will be copied to the new account.</p>
            <button type="submit" id="player-submit">Sign in</button>
            <button type="button" id="player-switch" class="player-secondary">Create an account</button>
          </form>
          <button type="button" id="player-back" class="player-secondary" hidden>Back to sign-in options</button>
          </section>
          <p id="player-accounts-availability" role="status" hidden></p>
          <p id="player-autosave"></p>
          <button type="button" id="player-copy" class="player-secondary">Copy guest progress</button>
          <button type="button" id="player-signout" class="player-secondary">Sign out</button>
          <button type="button" id="player-install" class="player-secondary">Add to Home Screen</button>
          <p id="player-sync-status" role="status" tabindex="-1"></p>`;
        document.body.appendChild(panel);
        const form = find("account-form");
        form.elements.username.value = usernameCookie();
        form.elements.remember.checked = Boolean(form.elements.username.value);
        panel.querySelector("#player-close").onclick = () => panel.close();
        panel.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
        panel.addEventListener("close", () => {
          if (!panel.open) clearInterval(autosaveTimer);
          resetAuth();
          form.elements.password.value = "";
          if (isMenuVisible()) entry.focus({ preventScroll: true });
        });
        for (const button of panel.querySelectorAll("[data-auth-provider]")) button.onclick = () => {
          const provider = button.dataset.authProvider;
          if (provider === "phone") startPhone();
          else startOAuth(provider);
        };
        find("password-option").onclick = () => {
          usePassword = true;
          formMessage = "";
          refreshPanel();
          form.elements.username.focus();
        };
        find("back").onclick = () => {
          resetAuth();
          form.elements.password.value = "";
          formMessage = "";
          refreshPanel();
          find("auth-title").focus();
        };
        find("phone-form").onsubmit = submitPhone;
        find("phone-form").elements.phone.oninput = event => event.currentTarget.setCustomValidity("");
        find("code-form").onsubmit = submitCode;
        find("resend").onclick = () => {
          const phone = authFlow?.phone;
          resetAuth();
          startPhone();
          find("phone-form").elements.phone.value = phone || "";
        };
        form.onsubmit = event => {
          event.preventDefault();
          const username = form.elements.username.value;
          const password = form.elements.password.value;
          run(async () => {
            try {
              const signedIn = await saves.authenticate(action, { username, password }, canAuthenticate);
              if (signedIn) rememberUsername(form.elements.remember.checked ? saves.snapshot().username : "");
            } finally {
              form.elements.password.value = "";
            }
          });
        };
        panel.querySelector("#player-switch").onclick = () => {
          action = action === "login" ? "register" : "login";
          const registering = action === "register";
          form.elements.password.value = "";
          form.elements.password.autocomplete = registering ? "new-password" : "current-password";
          panel.querySelector("#player-form-title").textContent = registering ? "Create an account" : "Sign in to sync saves";
          panel.querySelector("#player-register-help").hidden = !registering;
          panel.querySelector("#player-submit").textContent = registering ? "Create account" : "Sign in";
          panel.querySelector("#player-switch").textContent = registering ? "I already have an account" : "Create an account";
          formMessage = "";
          refreshPanel();
        };
        panel.querySelector("#player-copy").onclick = () => run(async () => { saves.copyGuest(); await saves.sync(); });
        panel.querySelector("#player-signout").onclick = () => run(() => saves.signOut());
        panel.querySelector("#player-install").onclick = () => {
          panel.close();
          window.asteroidsShowInstall?.();
        };
      }
      formMessage = "";
      refreshPanel();
      panel.showModal();
      clearInterval(autosaveTimer);
      autosaveTimer = setInterval(refreshAutosave, 1000);
      saves.sync({ pull: true });
      if (canReachAccounts && cloudAvailable !== true) {
        request("/v1/availability").then(result => {
          cloudAvailable = result.available === true;
          passwordEnabled = result.passwordEnabled !== false;
          captchaSiteKey = typeof result.captchaSiteKey === "string" ? result.captchaSiteKey : undefined;
          providers = {
            google: result.providers?.google === true && Boolean(window.crypto?.subtle),
            apple: result.providers?.apple === true && Boolean(window.crypto?.subtle),
            phone: result.providers?.phone === true && Boolean(captchaSiteKey)
          };
        }, () => {
          cloudAvailable = false;
        }).then(() => { if (panel.open) refreshPanel(); });
      }
    }

    async function run(operation) {
      if (busy) return;
      busy = true;
      formMessage = "Working…";
      refreshPanel();
      try {
        await operation();
        formMessage = "";
      } catch (error) {
        formMessage = authError(error);
      } finally {
        busy = false;
        refreshPanel();
      }
    }

    return {
      open: openPanel,
      close() { if (panel?.open) panel.close(); },
      refresh() { if (panel?.open) refreshPanel(); },
      resume() {
        if (authFlow?.kind === "oauth" && authFlow.attempt) pollOAuth(authFlow);
      }
    };
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { createOAuthChallenge, normalizePhone, oauthDestination };
    return;
  }

  window.asteroidsCreatePlayerSavesPanel = createPlayerSavesPanel;
})();
