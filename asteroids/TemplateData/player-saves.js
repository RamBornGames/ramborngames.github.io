(function () {
  "use strict";

  const prefix = "asteroids.player.v1.";
  const modes = { tap: "Tap Asteroids", launch: "Astronaut Launch", rhythm: "Rhythm Fishing", puzzle: "Puzzle Fishing" };
  const emptySave = {
    version: 1,
    highScores: { tap: 0, launch: 0, rhythm: 0, puzzle: 0 },
    puzzle: { active: false, updatedAt: 0, round: 0, health: 0, hits: 0, resources: 0, score: 0,
      duration: 0, remaining: 0, selectedPiece: 0, pieces: [] }
  };
  const emptyJson = JSON.stringify(emptySave);
  const maxScore = 2147483647;

  function integer(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
  }

  function parsePuzzle(source) {
    if (!integer(source?.updatedAt, 0, Number.MAX_SAFE_INTEGER)) return emptySave.puzzle;
    if (source.active === false) return { ...emptySave.puzzle, updatedAt: source.updatedAt };
    if (source.active !== true || !source.updatedAt || !integer(source.round, 1, maxScore)
      || !integer(source.health, 1, 5) || !integer(source.score, 0, maxScore)
      || !integer(source.hits, 0, source.score) || !integer(source.resources, 0, source.hits)
      || !integer(source.duration, 30, 120) || !integer(source.remaining, 1, source.duration)
      || !integer(source.selectedPiece, 0, 2) || !Array.isArray(source.pieces) || source.pieces.length !== 3) {
      return emptySave.puzzle;
    }
    const anchors = new Set();
    const pieces = [];
    for (const piece of source.pieces) {
      if (!piece || typeof piece.placed !== "boolean" || !integer(piece.x, 0, 2) || !integer(piece.y, 0, 2)
        || !integer(piece.turns, 0, 3)) return emptySave.puzzle;
      const anchor = piece.x + piece.y * 3;
      if (piece.placed && anchors.has(anchor)) return emptySave.puzzle;
      if (piece.placed) anchors.add(anchor);
      pieces.push({ placed: piece.placed, x: piece.x, y: piece.y, turns: piece.turns });
    }
    return { active: true, updatedAt: source.updatedAt, round: source.round, health: source.health,
      hits: source.hits, resources: source.resources, score: source.score, duration: source.duration,
      remaining: source.remaining, selectedPiece: source.selectedPiece, pieces };
  }

  function parseSave(raw) {
    try {
      const save = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (save?.version !== 1) return emptySave;
      const highScores = {};
      for (const mode of Object.keys(modes)) {
        const score = save.highScores?.[mode];
        highScores[mode] = integer(score, 0, mode === "launch" ? Number.MAX_SAFE_INTEGER : maxScore) ? score : 0;
      }
      return { version: 1, highScores, puzzle: parsePuzzle(save.puzzle) };
    } catch {
      return emptySave;
    }
  }

  function mergeSaves(current, candidate,
    puzzle = candidate.puzzle.updatedAt > current.puzzle.updatedAt ? candidate.puzzle : current.puzzle) {
    const highScores = {};
    for (const mode of Object.keys(modes)) highScores[mode] = Math.max(current.highScores[mode], candidate.highScores[mode]);
    return { version: 1, highScores, puzzle };
  }

  const sameCheckpoint = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  function createPlayerSaves({ storage, request, changed, schedule = setTimeout, cancel = clearTimeout }) {
    const guest = "guest";
    const cached = new Map();
    let profile = guest;
    let session;
    let timer;
    let storageAvailable = true;
    let status = "";

    function loadRecord(key = profile) {
      const memory = cached.get(key);
      try {
        const stored = parseSave(storage.getItem(prefix + key));
        // The disk checkpoint can move backward after a cloud conflict. Only reuse an
        // in-memory checkpoint if its write failed and the disk still has its old base.
        const pendingBase = memory?.pendingBase && sameCheckpoint(stored.puzzle, memory.pendingBase)
          ? memory.pendingBase : undefined;
        const save = memory ? mergeSaves(stored, memory.save, pendingBase ? memory.save.puzzle : stored.puzzle) : stored;
        cached.set(key, { save, stored, pendingBase });
        return { save, stored };
      } catch {
        storageAvailable = false;
        return { save: memory?.save ?? emptySave };
      }
    }

    const load = key => loadRecord(key).save;

    function persist(key, save, observed) {
      try {
        storage.setItem(prefix + key, JSON.stringify(save));
        cached.set(key, { save, stored: save });
        storageAvailable = true;
      } catch {
        const stored = observed ?? cached.get(key)?.stored ?? emptySave;
        cached.set(key, { save, stored, pendingBase: stored.puzzle });
        storageAvailable = false;
      }
      return storageAvailable;
    }

    function updateStatus(message) {
      status = message;
      changed();
    }

    function queue(delay) {
      if (!session?.token || timer !== undefined) return;
      timer = schedule(() => {
        timer = undefined;
        sync();
      }, delay);
    }

    async function sync({ pull = false, keepalive = false } = {}) {
      const current = session;
      if (!current?.token) return;
      if (current.pending) return current.pending;
      cancel(timer);
      timer = undefined;
      const saved = load();
      const dirty = JSON.stringify(saved) !== JSON.stringify(current.cloud);
      if (!dirty && !pull) return true;
      const key = profile;
      current.pending = (async () => {
        try {
          const reply = dirty
            ? await request("/v1/save", { method: "PUT", token: current.token, keepalive,
              body: { revision: current.revision, save: saved } })
            : await request("/v1/save", { token: current.token });
          if (session !== current) return;
          if (!Number.isSafeInteger(reply.revision) || reply.revision < current.revision) throw new Error("unavailable");
          const cloud = parseSave(reply.save);
          const cloudChangedCheckpoint = (!dirty || reply.error === "conflict")
            && !sameCheckpoint(current.cloud.puzzle, cloud.puzzle);
          const local = loadRecord(key);
          const combined = mergeSaves(local.save, cloud, cloudChangedCheckpoint ? cloud.puzzle : local.save.puzzle);
          current.revision = reply.revision;
          current.cloud = cloud;
          persist(key, combined, local.stored);
          const pending = JSON.stringify(combined) !== JSON.stringify(cloud);
          if (pending) queue(3000);
          updateStatus(pending ? "Progress saved on this device. Cloud sync pending." : "Cloud save up to date.");
          return !pending;
        } catch (error) {
          if (session !== current) return;
          if (error.message === "unauthorized") {
            current.token = undefined;
            updateStatus("Session expired. Sign in again to sync your saved progress.");
          } else {
            queue(30000);
            updateStatus("Cloud sync paused. This device will retry when it can.");
          }
          return false;
        } finally {
          current.pending = undefined;
        }
      })();
      return current.pending;
    }

    async function authenticate(action, { username, password }, active = () => true) {
      const reply = await request("/v1/accounts/" + action, { method: "POST", body: { username, password } });
      if (typeof reply.username !== "string" || !/^[a-z0-9][a-z0-9_-]{2,23}$/.test(reply.username)) throw new Error("unavailable");
      if (!active()) {
        discardSession(reply.token);
        return false;
      }
      acceptSession(reply, "account." + reply.username, reply.username, action === "register", reply.username);
      return true;
    }

    function discardSession(token) {
      if (typeof token === "string" && token) {
        request("/v1/accounts/logout", { method: "POST", token, keepalive: true }).catch(() => {});
      }
    }

    function acceptSession(reply, key, displayName, copyGuest, username) {
      if (typeof reply.token !== "string" || !reply.token
        || !Number.isSafeInteger(reply.revision) || reply.revision < 0) throw new Error("unavailable");
      const remote = parseSave(reply.save);
      cancel(timer);
      timer = undefined;
      const localGuest = copyGuest ? load(guest) : emptySave;
      profile = key;
      const previous = session;
      session = { token: reply.token, displayName, username, revision: reply.revision, cloud: remote };
      if (previous?.token && previous.token !== session.token) discardSession(previous.token);
      const local = loadRecord();
      const save = mergeSaves(mergeSaves(local.save, remote), localGuest);
      persist(profile, save, local.stored);
      if (JSON.stringify(save) !== JSON.stringify(remote)) queue(0);
      updateStatus("Signed in.");
    }

    async function signOut() {
      if (!session) return true;
      const current = session;
      if (session.token) {
        await sync();
      }
      const pending = JSON.stringify(load()) !== JSON.stringify(current.cloud);
      session = undefined;
      cancel(timer);
      timer = undefined;
      profile = guest;
      if (current.token) {
        discardSession(current.token);
        current.token = undefined;
      }
      updateStatus(pending
        ? "Signed out. Sign back in on this device to sync pending progress."
        : "Switched to guest progress on this device.");
      return true;
    }

    function storeChanged(before, save) {
      const persisted = persist(profile, save, before.stored);
      if (JSON.stringify(before.save) !== JSON.stringify(save)) {
        if (session?.token) status = "Saved on this device. Cloud sync pending.";
        queue(3000);
        changed();
      }
      return persisted;
    }

    return {
      read: () => JSON.stringify(load()),
      write(raw) {
        const before = loadRecord();
        return storeChanged(before, mergeSaves(before.save, parseSave(raw), before.save.puzzle));
      },
      writeCheckpoint(raw, expectedVersion) {
        const before = loadRecord();
        const after = parseSave(raw);
        if (before.save.puzzle.updatedAt !== expectedVersion || after.puzzle.updatedAt <= expectedVersion) return false;
        storeChanged(before, mergeSaves(before.save, after, after.puzzle));
        return true;
      },
      reconcileStorage(key, raw) {
        if (key !== prefix + guest || raw === null) return;
        const { save, stored } = loadRecord(guest);
        const combined = mergeSaves(save, parseSave(raw), save.puzzle);
        cached.set(guest, { ...cached.get(guest), save: combined });
        if (!stored) return;
        // Reconcile only scores and always take the checkpoint from the current disk record.
        if (JSON.stringify(combined.highScores) === JSON.stringify(stored.highScores)) return;
        try {
          storage.setItem(key, JSON.stringify({ ...stored, highScores: combined.highScores }));
        } catch {
          storageAvailable = false;
        }
      },
      copyGuest() {
        if (!session?.token) return;
        const local = loadRecord();
        persist(profile, mergeSaves(local.save, load(guest)), local.stored);
        queue(0);
        updateStatus("Guest progress copied to your account.");
      },
      saveNow() {
        if (session?.token) return sync({ pull: true });
        const local = loadRecord();
        const persisted = persist(profile, local.save, local.stored);
        if (persisted) updateStatus("Progress saved on this device.");
      },
      sync,
      authenticate,
      discardSession,
      acceptProviderSession(reply) {
        if (typeof reply.profile !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(reply.profile)
          || !["Google player", "Apple player", "Phone player"].includes(reply.displayName)
          || typeof reply.created !== "boolean") throw new Error("unavailable");
        acceptSession(reply, "provider." + reply.profile, reply.displayName, reply.created);
      },
      signOut,
      snapshot() {
        const save = load();
        return { save, username: session?.username, displayName: session?.displayName, signedIn: Boolean(session?.token),
          hasGuestProgress: JSON.stringify(load(guest)) !== emptyJson, storageAvailable, status };
      }
    };
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { createPlayerSaves };
    return;
  }

  // GitHub Pages and the account worker are cross-site. Keep the bearer in page memory.
  const api = location.origin === "https://ramborngames.github.io" && location.pathname.startsWith("/asteroids/")
    ? "https://asteroids-accounts.cfireborn.workers.dev"
    : ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://127.0.0.1:8787" : null;
  async function request(path, { method = "GET", token, body, keepalive, signal } = {}) {
    if (!api) throw new Error("unavailable");
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    if (body) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(api + path, {
        method, headers, keepalive, credentials: "omit", cache: "no-store", redirect: "error",
        body: body && JSON.stringify(body), signal: controller.signal
      });
      if (response.status === 204) return {};
      const result = await response.json();
      if (!response.ok && !(response.status === 409 && result.error === "conflict")) {
        throw new Error(result.error || "unavailable");
      }
      return result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  // The account panel shares the bridge's release version but loads only when opened.
  const bridgeUrl = new URL(document.currentScript.src);
  function assetUrl(name) {
    const url = new URL(name, bridgeUrl);
    url.search = bridgeUrl.search;
    return url.href;
  }

  let menuVisible = false;
  let panel;
  const canOpenPanel = typeof window.HTMLDialogElement?.prototype.showModal === "function";
  const entry = document.createElement("button");
  entry.type = "button";
  entry.className = "player-saves-entry";
  entry.textContent = "Player saves";
  entry.hidden = true;
  document.body.appendChild(entry);

  const saves = createPlayerSaves({
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, data) => localStorage.setItem(key, data) },
    request,
    changed: () => panel?.refresh()
  });

  function openPanel() {
    if (!menuVisible) return;
    if (panel) {
      panel.open();
      return;
    }
    if (entry.disabled) return;

    entry.disabled = true;
    entry.textContent = "Opening player saves…";
    const script = document.createElement("script");
    script.src = assetUrl("player-saves-panel.js");
    script.async = true;
    const failed = () => {
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      script.remove();
      entry.disabled = false;
      entry.textContent = "Retry player saves";
    };
    const timeout = setTimeout(failed, 10000);
    script.onerror = failed;
    script.onload = () => {
      clearTimeout(timeout);
      const createPanel = window.asteroidsCreatePlayerSavesPanel;
      delete window.asteroidsCreatePlayerSavesPanel;
      if (typeof createPanel !== "function") {
        failed();
        return;
      }
      try {
        panel = createPanel({ entry, saves, request, assetUrl, modes,
          isMenuVisible: () => menuVisible, canReachAccounts: Boolean(api) });
      } catch {
        failed();
        return;
      }
      entry.disabled = false;
      entry.textContent = "Player saves";
      if (menuVisible) panel.open();
    };
    document.head.appendChild(script);
  }

  entry.onclick = openPanel;
  window.AsteroidsSaves = {
    read: saves.read,
    write: saves.write,
    writeCheckpoint: saves.writeCheckpoint,
    setMenuVisible(visible) {
      menuVisible = visible && canOpenPanel;
      entry.hidden = !menuVisible;
      if (!menuVisible) panel?.close();
    }
  };
  window.addEventListener("online", () => saves.sync({ pull: menuVisible }));
  window.addEventListener("pagehide", () => saves.sync({ keepalive: true }));
  window.addEventListener("storage", event => {
    if (event.key?.startsWith(prefix)) {
      saves.reconcileStorage(event.key, event.newValue);
      panel?.refresh();
      saves.sync();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saves.sync({ keepalive: true });
    else if (menuVisible) {
      saves.sync({ pull: true });
      panel?.resume();
    }
  });
})();
