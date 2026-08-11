import test from "node:test";
import assert from "node:assert/strict";
import { deploymentStatus, initialState, shouldDeploy } from "../src/index.js";

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
});
