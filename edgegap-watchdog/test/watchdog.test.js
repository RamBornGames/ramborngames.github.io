import test from "node:test";
import assert from "node:assert/strict";
import { classifyContainerLogs, deploymentApplication, deploymentStatus, initialState, nextWakeAt, shouldDeploy } from "../src/index.js";

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

test("normalizes Edgegap deployment status", () => {
  assert.equal(deploymentStatus({ status: "ready" }), "READY");
  assert.equal(deploymentStatus({ current_status: "error" }), "ERROR");
  assert.equal(deploymentStatus({ status: { current_status: "ready" } }), "READY");
  assert.equal(deploymentStatus({ data: { current_status: "deploying" } }), "DEPLOYING");
  assert.equal(deploymentStatus({ result: { deployment: { status: { state: "ready" } } } }), "READY");
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
