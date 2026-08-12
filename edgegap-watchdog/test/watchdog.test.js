import test from "node:test";
import assert from "node:assert/strict";
import { classifyContainerLogs, deploymentApplication, deploymentStatus, initialState, nextWakeAt, shouldDeploy, singletonRecoveryDecision, Watchdog } from "../src/index.js";

test("requires the configured number of failures", () => {
  const state = initialState();
  state.consecutiveFailures = 2;
  assert.equal(shouldDeploy(state, 10_000, 3, 1_000), false);
  state.consecutiveFailures = 3;
  assert.equal(shouldDeploy(state, 10_000, 3, 1_000), true);
});

test("does not deploy during cooldown or while replacement exists", () => {
  const state = initialState();
  state.consecutiveFailures = 3;
  state.lastDeploymentAt = 9_500;
  assert.equal(shouldDeploy(state, 10_000, 3, 1_000), false);
  state.lastDeploymentAt = 8_000;
  state.replacementDeploymentId = "replacement";
  assert.equal(shouldDeploy(state, 10_000, 3, 1_000), false);
});

test("does not deploy while the circuit is open or an attempt is ambiguous", () => {
  const state = initialState();
  state.consecutiveFailures = 3;
  state.circuitOpen = true;
  assert.equal(shouldDeploy(state, 10_000, 3, 1_000), false);
  state.circuitOpen = false;
  state.pendingAttemptId = "wd-ambiguous";
  assert.equal(shouldDeploy(state, 10_000, 3, 1_000), false);
});

test("creates only when no live deployment exists and never restarts a singleton", () => {
  assert.equal(singletonRecoveryDecision(0), "create");
  assert.equal(singletonRecoveryDecision(1), "preserve");
  assert.equal(singletonRecoveryDecision(2), "ambiguous");
});

test("normalizes Edgegap deployment status", () => {
  assert.equal(deploymentStatus({ status: "ready" }), "READY");
  assert.equal(deploymentStatus({ current_status: "error" }), "ERROR");
  assert.equal(deploymentStatus({ status: { current_status: "ready" } }), "READY");
  assert.equal(deploymentStatus({ data: { current_status: "deploying" } }), "DEPLOYING");
  assert.equal(deploymentStatus({ result: { deployment: { status: { state: "ready" } } } }), "READY");
  assert.equal(deploymentStatus({ result: { deployment: { lifecycle: "ready" } } }), "READY");
  assert.equal(deploymentStatus({ current_status: "Status.READY" }), "READY");
  assert.equal(deploymentStatus({ result: { city: "readyville" } }), "");
});

test("finds the application name in flat and nested Edgegap payloads", () => {
  assert.equal(deploymentApplication({ application: "compersion" }), "compersion");
  assert.equal(deploymentApplication({ application: { metadata: "ignored" }, details: { app_name: "compersion" } }), "compersion");
  assert.equal(deploymentApplication({ app: { name: "compersion" } }), "compersion");
});

test("classifies container failures without returning raw logs", () => {
  assert.equal(classifyContainerLogs({ logs: "CF_TUNNEL_TOKEN must be provided at runtime" }), "missing-tunnel-token");
  assert.equal(classifyContainerLogs({ logs: "Provided Tunnel token is not valid." }), "tunnel-auth-failed");
  assert.equal(classifyContainerLogs({ logs: "Mono Assertion failed" }), "unity-runtime-crash");
});

test("a repeated wake preserves the pending incident alarm", () => {
  const state = initialState();
  state.nextCheckNotBefore = 20_000;
  assert.equal(nextWakeAt(state, 10_000), 20_000);
  assert.equal(nextWakeAt(state, 30_000), 30_000);
});

test("public status counts checks and only reports booting after Edgegap accepts", () => {
  const watchdog = new Watchdog(null, { FAILURES_BEFORE_DEPLOY: "3" });
  const state = initialState();
  state.consecutiveFailures = 2;
  state.phase = "starting";
  state.pendingAttemptId = "wd-pending";
  assert.deepEqual(watchdog.publicState(state), {
    status: "checking",
    checkedAt: null,
    reason: null,
    failureCount: 2,
    failureThreshold: 3,
    deploymentAccepted: false,
  });
  state.replacementDeploymentId = "accepted-id";
  assert.equal(watchdog.publicState(state).status, "starting");
  assert.equal(watchdog.publicState(state).deploymentAccepted, true);
});

test("a deliberate config generation clears parked state on the next visitor wake", async () => {
  let stored = { ...initialState(), circuitOpen: true, consecutiveFailures: 3 };
  let alarmAt = null;
  const ctx = {
    storage: {
      get: async () => stored,
      put: async (_key, value) => { stored = value; },
      setAlarm: async value => { alarmAt = value; },
    },
  };
  const watchdog = new Watchdog(ctx, { CONFIG_GENERATION: "tunnel-fixed" });
  const result = await watchdog.wake();
  assert.equal(result.configGeneration, "tunnel-fixed");
  assert.equal(result.circuitOpen, false);
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(typeof alarmAt, "number");
});
