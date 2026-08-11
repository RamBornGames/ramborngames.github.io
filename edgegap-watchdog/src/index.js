const EDGEGAP_API = "https://api.edgegap.com";
const STATE_KEY = "state";

export const initialState = () => ({
  initialized: false,
  phase: "monitoring",
  consecutiveFailures: 0,
  activeDeploymentId: null,
  stoppingDeploymentId: null,
  stopRequestedAt: null,
  replacementDeploymentId: null,
  replacementStartedAt: null,
  lastDeploymentAt: null,
  lastCheckAt: null,
  lastHealthyAt: null,
  lastError: null,
  nextCheckNotBefore: null,
  deploymentAttempts: [],
  pendingAttemptId: null,
  replacementStatusErrors: 0,
  circuitOpen: false,
});

export function shouldDeploy(state, now, failureThreshold, cooldownMs) {
  if (state.circuitOpen || state.pendingAttemptId) return false;
  if (state.replacementDeploymentId) return false;
  if (state.consecutiveFailures < failureThreshold) return false;
  if (state.lastDeploymentAt && now - state.lastDeploymentAt < cooldownMs) return false;
  return true;
}

export function deploymentStatus(body) {
  return String(body?.status ?? body?.current_status ?? "").toUpperCase();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function requireConfig(env, names = ["HEALTH_URL"]) {
  for (const name of names) {
    if (!env[name] || String(env[name]).startsWith("REPLACE_WITH_")) {
      throw new Error(`Missing required configuration: ${name}`);
    }
  }
}

class EdgegapRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "EdgegapRequestError";
    this.status = status;
  }
}

async function healthCheck(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const parsed = new URL(url);
    const websocket = parsed.protocol === "wss:" || parsed.protocol === "ws:";
    if (websocket) parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    const response = await fetch(parsed, {
      method: "GET",
      headers: websocket ? { Upgrade: "websocket" } : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    if (websocket && response.webSocket) {
      response.webSocket.accept();
      response.webSocket.close(1000, "health check complete");
    }
    return websocket ? response.status === 101 : response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function edgegapRequest(env, path, options = {}) {
  const response = await fetch(`${EDGEGAP_API}${path}`, {
    ...options,
    headers: {
      Authorization: `token ${env.EDGEGAP_TOKEN}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 500) }; }
  }
  if (!response.ok) {
    throw new EdgegapRequestError(
      `Edgegap ${options.method ?? "GET"} ${path} returned ${response.status}: ${body?.message ?? text}`,
      response.status,
    );
  }
  return body;
}

async function startReplacement(env, attemptId) {
  requireConfig(env, ["EDGEGAP_APPLICATION", "EDGEGAP_VERSION", "EDGEGAP_TOKEN"]);
  let users;
  try {
    users = JSON.parse(env.EDGEGAP_DEPLOYMENT_USERS_JSON || "[]");
  } catch {
    throw new Error("EDGEGAP_DEPLOYMENT_USERS_JSON is not valid JSON");
  }
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error("EDGEGAP_DEPLOYMENT_USERS_JSON must contain at least one user location");
  }
  const body = await edgegapRequest(env, "/v2/deployments", {
    method: "POST",
    body: JSON.stringify({
      application: env.EDGEGAP_APPLICATION,
      version: env.EDGEGAP_VERSION,
      users,
      tags: ["compersion-primary", "watchdog-managed", attemptId],
    }),
  });
  const requestId = body?.request_id ?? body?.requestId;
  if (!requestId) throw new Error("Edgegap accepted the deployment but returned no request_id");
  return requestId;
}

export class Watchdog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.running = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/public-status") {
      const state = await this.ctx.storage.get(STATE_KEY) ?? initialState();
      return Response.json(this.publicState(state));
    }
    if (url.pathname === "/status") {
      return Response.json(await this.ctx.storage.get(STATE_KEY) ?? initialState());
    }
    if (url.pathname === "/wake" && request.method === "POST") {
      return Response.json(this.publicState(await this.wake()));
    }
    if (url.pathname !== "/check" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    const result = await this.check();
    return Response.json(result);
  }

  async alarm() {
    await this.check();
  }

  publicState(state) {
    let status = "checking";
    if (state.circuitOpen) status = "error";
    else if (state.phase === "stopping") status = "stopping";
    else if (state.phase === "starting" || state.replacementDeploymentId) status = "starting";
    else if (state.lastHealthyAt && (!state.lastCheckAt || state.lastHealthyAt >= state.lastCheckAt)) status = "operational";
    return {
      status,
      checkedAt: state.lastCheckAt,
    };
  }

  async wake() {
    const now = Date.now();
    const interval = positiveNumber(this.env.MIN_CHECK_INTERVAL_SECONDS, 60) * 1000;
    const state = await this.ctx.storage.get(STATE_KEY) ?? initialState();
    if (state.nextCheckNotBefore && now < state.nextCheckNotBefore) return state;

    // Reserve the interval durably before yielding to external network requests.
    state.nextCheckNotBefore = now + interval;
    await this.ctx.storage.put(STATE_KEY, state);
    return this.check();
  }

  async updateAlarm(state) {
    const needsFollowUp = !state.circuitOpen &&
      (state.phase !== "monitoring" || Boolean(state.replacementDeploymentId) || state.consecutiveFailures > 0);
    if (needsFollowUp) {
      const interval = positiveNumber(this.env.MIN_CHECK_INTERVAL_SECONDS, 60) * 1000;
      await this.ctx.storage.setAlarm(Date.now() + interval);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async check() {
    if (this.running) return { skipped: true, reason: "check already running" };
    this.running = true;
    try {
      requireConfig(this.env);
      const now = Date.now();
      const state = await this.ctx.storage.get(STATE_KEY) ?? initialState();
      if (!state.initialized) {
        state.initialized = true;
        if (this.env.INITIAL_DEPLOYMENT_ID && !String(this.env.INITIAL_DEPLOYMENT_ID).startsWith("REPLACE_WITH_")) {
          state.activeDeploymentId = this.env.INITIAL_DEPLOYMENT_ID;
        }
      }
      state.lastCheckAt = now;

      // A create request is non-idempotent. If execution ended after persisting
      // the attempt but before saving Edgegap's deployment ID, stop all alarms
      // and require reconciliation instead of retrying or polling forever.
      if (state.pendingAttemptId && !state.replacementDeploymentId) {
        state.circuitOpen = true;
        state.lastError = `Deployment attempt ${state.pendingAttemptId} has an unknown outcome; reconcile its Edgegap tag manually`;
        await this.ctx.storage.put(STATE_KEY, state);
        await this.updateAlarm(state);
        return state;
      }

      if (state.phase === "stopping") {
        await this.observeStop(state, now);
        await this.ctx.storage.put(STATE_KEY, state);
        await this.updateAlarm(state);
        return state;
      }

      if (state.replacementDeploymentId) {
        await this.observeReplacement(state, now);
        await this.ctx.storage.put(STATE_KEY, state);
        await this.updateAlarm(state);
        return state;
      }

      if (await healthCheck(this.env.HEALTH_URL)) {
        state.consecutiveFailures = 0;
        state.lastHealthyAt = now;
        state.lastError = null;
        state.circuitOpen = false;
      } else {
        state.consecutiveFailures += 1;
        state.lastError = "Public multiplayer health check failed";
        const threshold = positiveNumber(this.env.FAILURES_BEFORE_DEPLOY, 3);
        const cooldown = positiveNumber(this.env.DEPLOY_COOLDOWN_SECONDS, 900) * 1000;
        if (shouldDeploy(state, now, threshold, cooldown)) {
          if (String(this.env.ENABLE_DEPLOYMENTS).toLowerCase() !== "true") {
            state.circuitOpen = true;
            state.lastError = "Deployment automation is disabled until deterministic replacement routing is configured";
          } else {
            await this.beginSingletonRecovery(state, now);
          }
        }
      }
      await this.ctx.storage.put(STATE_KEY, state);
      await this.updateAlarm(state);
      return state;
    } catch (error) {
      console.error("Watchdog check failed", error);
      const state = await this.ctx.storage.get(STATE_KEY) ?? initialState();
      state.lastCheckAt = Date.now();
      state.lastError = error instanceof Error ? error.message : String(error);
      await this.ctx.storage.put(STATE_KEY, state);
      await this.updateAlarm(state);
      return state;
    } finally {
      this.running = false;
    }
  }

  async beginSingletonRecovery(state, now) {
    requireConfig(this.env, ["EDGEGAP_TOKEN", "EDGEGAP_APPLICATION", "EDGEGAP_VERSION"]);
    if (!state.activeDeploymentId) {
      state.circuitOpen = true;
      state.lastError = "No active deployment ID is known; refusing to start a second server";
      return;
    }

    state.phase = "stopping";
    state.stoppingDeploymentId = state.activeDeploymentId;
    state.stopRequestedAt = now;
    await this.ctx.storage.put(STATE_KEY, state);
    try {
      await edgegapRequest(this.env, `/v1/stop/${encodeURIComponent(state.stoppingDeploymentId)}`, { method: "DELETE" });
      state.lastError = "Unhealthy deployment is stopping before singleton replacement";
    } catch (error) {
      // 410 means Edgegap already terminated it. Other outcomes are resolved by the
      // status poll; never start a replacement merely because the stop response failed.
      if (error instanceof EdgegapRequestError && error.status === 410) {
        await this.startSingletonReplacement(state, now);
      } else {
        state.lastError = "Stop request outcome is uncertain; waiting for Edgegap status confirmation";
        console.error(state.lastError, error);
      }
    }
  }

  async observeStop(state, now) {
    const stopTimeout = positiveNumber(this.env.STOP_TIMEOUT_SECONDS, 300) * 1000;
    if (!state.stoppingDeploymentId || now - state.stopRequestedAt > stopTimeout) {
      state.circuitOpen = true;
      state.lastError = "Old deployment did not reach a confirmed stopped state; refusing to start another server";
      return;
    }

    try {
      const details = await edgegapRequest(this.env, `/v1/status/${encodeURIComponent(state.stoppingDeploymentId)}`);
      const status = deploymentStatus(details);
      if (["ERROR", "TERMINATED", "STOPPED"].includes(status)) {
        await this.startSingletonReplacement(state, now);
      } else {
        state.lastError = `Waiting for old deployment to stop (status: ${status || "unknown"})`;
      }
    } catch (error) {
      if (error instanceof EdgegapRequestError && [404, 410].includes(error.status)) {
        await this.startSingletonReplacement(state, now);
      } else {
        state.lastError = "Unable to confirm that the old deployment stopped; no replacement will start yet";
        console.error(state.lastError, error);
      }
    }
  }

  async startSingletonReplacement(state, now) {
    const hourAgo = now - 3_600_000;
    const dayAgo = now - 86_400_000;
    state.deploymentAttempts = (state.deploymentAttempts ?? []).filter(value => value >= dayAgo);
    const hourly = state.deploymentAttempts.filter(value => value >= hourAgo).length;
    const maxHour = positiveNumber(this.env.MAX_DEPLOYMENTS_PER_HOUR, 3);
    const maxDay = positiveNumber(this.env.MAX_DEPLOYMENTS_PER_DAY, 6);
    if (hourly >= maxHour || state.deploymentAttempts.length >= maxDay) {
      state.circuitOpen = true;
      state.lastError = "Automatic deployment cap reached; manual review required";
      return;
    }

    state.activeDeploymentId = null;
    state.stoppingDeploymentId = null;
    state.stopRequestedAt = null;
    state.phase = "starting";
    const attemptId = `wd-${crypto.randomUUID().slice(0, 8)}`;
    state.pendingAttemptId = attemptId;
    state.lastDeploymentAt = now;
    state.deploymentAttempts.push(now);
    await this.ctx.storage.put(STATE_KEY, state);
    try {
      state.replacementDeploymentId = await startReplacement(this.env, attemptId);
      state.replacementStartedAt = now;
      state.replacementStatusErrors = 0;
      state.pendingAttemptId = null;
      console.log("Started singleton Edgegap replacement", state.replacementDeploymentId, attemptId);
    } catch (error) {
      state.circuitOpen = true;
      state.lastError = `Deployment request outcome is ambiguous for ${attemptId}; reconcile in Edgegap before retrying`;
      console.error(state.lastError, error);
    }
  }

  async observeReplacement(state, now) {
    const timeout = positiveNumber(this.env.REPLACEMENT_TIMEOUT_SECONDS, 600) * 1000;
    if (now - state.replacementStartedAt > timeout) {
      state.lastError = `Replacement ${state.replacementDeploymentId} timed out; manual cleanup may be required`;
      state.replacementDeploymentId = null;
      state.replacementStartedAt = null;
      state.circuitOpen = true;
      return;
    }

    let details;
    try {
      details = await edgegapRequest(this.env, `/v1/status/${encodeURIComponent(state.replacementDeploymentId)}`);
      state.replacementStatusErrors = 0;
    } catch (error) {
      state.replacementStatusErrors = (state.replacementStatusErrors ?? 0) + 1;
      state.lastError = `Unable to read replacement status (${state.replacementStatusErrors} consecutive errors)`;
      if (state.replacementStatusErrors >= 3) state.circuitOpen = true;
      console.error(state.lastError, error);
      return;
    }
    const status = deploymentStatus(details);

    if (status === "READY") {
      // The container is expected to attach to the same Cloudflare Tunnel. Verify the
      // public route before accepting it. We deliberately do not stop the previous
      // deployment here because doing so without player/session knowledge risks data loss.
      if (await healthCheck(this.env.HEALTH_URL)) {
        state.activeDeploymentId = state.replacementDeploymentId;
        state.replacementDeploymentId = null;
        state.replacementStartedAt = null;
        state.replacementStatusErrors = 0;
        state.consecutiveFailures = 0;
        state.phase = "monitoring";
        state.lastHealthyAt = now;
        state.lastError = null;
        console.log("Replacement is healthy", state.activeDeploymentId);
      } else {
        state.lastError = "Replacement is READY, but the public health check still fails; verify Cloudflare Tunnel routing";
        if (now - state.replacementStartedAt > timeout) {
          state.lastError += "; recovery timed out and may be retried after the cooldown";
          state.replacementDeploymentId = null;
          state.replacementStartedAt = null;
        }
      }
      return;
    }

    if (["ERROR", "TERMINATED", "STOPPED"].includes(status) || now - state.replacementStartedAt > timeout) {
      state.lastError = `Replacement ${state.replacementDeploymentId} failed or timed out (status: ${status || "unknown"})`;
      state.replacementDeploymentId = null;
      state.replacementStartedAt = null;
      state.circuitOpen = true;
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.startsWith("/watchdog/")
      ? url.pathname.slice("/watchdog".length)
      : url.pathname;
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.PUBLIC_ORIGIN;

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }

    if (pathname === "/wake" && request.method === "POST") {
      if (origin !== allowedOrigin) return new Response("Forbidden", { status: 403 });
      const id = env.WATCHDOG.idFromName("compersion-primary");
      ctx.waitUntil(env.WATCHDOG.get(id).fetch("https://watchdog.internal/wake", { method: "POST" }));
      return new Response(null, {
        status: 202,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Cache-Control": "no-store",
          Vary: "Origin",
        },
      });
    }

    if (pathname === "/status" && request.method === "GET") {
      if (origin !== allowedOrigin) return new Response("Forbidden", { status: 403 });
      const id = env.WATCHDOG.idFromName("compersion-primary");
      const response = await env.WATCHDOG.get(id).fetch("https://watchdog.internal/public-status");
      const result = new Response(response.body, response);
      result.headers.set("Access-Control-Allow-Origin", allowedOrigin);
      result.headers.set("Cache-Control", "no-store");
      result.headers.set("Vary", "Origin");
      return result;
    }

    const supplied = request.headers.get("Authorization");
    if (!env.ADMIN_TOKEN || supplied !== `Bearer ${env.ADMIN_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!["/admin/status", "/admin/check"].includes(pathname)) return new Response("Not found", { status: 404 });
    const id = env.WATCHDOG.idFromName("compersion-primary");
    const internalPath = pathname === "/admin/check" ? "/check" : "/status";
    return env.WATCHDOG.get(id).fetch(`https://watchdog.internal${internalPath}`, {
      method: internalPath === "/check" ? "POST" : "GET",
    });
  },
};
