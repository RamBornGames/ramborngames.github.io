# Compersion Edgegap watchdog

This Cloudflare Worker wakes when the homepage sends `POST /wake`. It performs three serialized cold-start health checks about five seconds apart. After the first failure, a Durable Object alarm continues the incident checks and replacement observation without requiring more visitors; the alarm stops when service is healthy. A SQLite-backed Durable Object stores state and serializes checks.

## Assumptions and safety behavior

- This is a strict singleton design: everyone connects to one persistent server.
- After three failures, the watchdog reconciles every live deployment for the application. It creates one server only when Edgegap reports zero live deployments.
- If one live deployment exists but the public WebSocket is unhealthy, the watchdog preserves it, opens its circuit, and asks for manual review. It never automatically stops or restarts a server. More than one live deployment also opens the circuit.
- Health is intentionally the same direct WebSocket handshake introduced by commit `763e6fb`: open `wss://compersion.charliefeuerborn.com` and require it to connect. This verifies the browser-to-Cloudflare-to-tunnel-to-Bayou path without requiring a separate Unity readiness endpoint.
- Production is intentionally parked with `ENABLE_DEPLOYMENTS=false` after the 2026-08-11 controlled launch proved that the Cloudflare connector could become healthy but the uploaded Unity image did not expose Bayou on localhost:7771. Keep deployment creation disabled until a corrected image passes one controlled launch. Before changing or redeploying this Worker, verify the stable Edgegap version, placement, secrets, tunnel route, and that no more than one application-wide deployment is live.
- Hard hourly/daily attempt caps and an ambiguity circuit breaker limit deployment storms.
- The API token is stored as a Worker secret and never sent to the website.
- The Cloudflare Tunnel token is injected into the Edgegap app version as the secret environment variable `CF_TUNNEL_TOKEN`; it is not baked into the container image.

## Configure

1. Install Node.js 22 or newer, then install dependencies:

   ```sh
   cd edgegap-watchdog
   npm install
   ```

2. Edit `wrangler.jsonc` and replace:

   - `EDGEGAP_APPLICATION`
   - `EDGEGAP_VERSION`
   - `INITIAL_DEPLOYMENT_ID` only if deliberately seeding a known running deployment; normal authoritative reconciliation leaves it blank
   - `EDGEGAP_DEPLOYMENT_USERS_JSON` with the region/user placement Edgegap should use
   - `HEALTH_URL` only if the stable public multiplayer WebSocket hostname changes; keep it as a `wss://` URL
   - `PUBLIC_ORIGIN` if the homepage origin changes

3. Store secrets interactively (do not paste them into tracked files):

   ```sh
   npx wrangler secret put EDGEGAP_TOKEN
   npx wrangler secret put ADMIN_TOKEN
   ```

   `ADMIN_TOKEN` protects the optional manual status/check endpoints. Generate a long random value with a password manager.

4. Test and deploy:

   ```sh
   npm test
   npm run deploy
   ```

5. Inspect the Worker logs after deployment. You can also query state manually:

   ```sh
   curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" https://YOUR_WORKER.workers.dev/admin/status
   ```

## Recovery timing

With the included settings, a homepage visit wakes the Worker. If that check fails, alarms perform two subsequent checks about five seconds apart. After three failures, singleton recovery lists all live application deployments. It creates one server only if that list is empty. An existing unhealthy server is left untouched and opens the circuit for manual review. A newly created server has ten minutes to become `READY` and reconnect the public WebSocket. Cooldowns, attempt caps, durable attempt IDs, and a circuit breaker limit retries.

`GET /watchdog/status` reports the real durable `failureCount` and configured `failureThreshold`; the homepage renders these as **Checking server (1/3)**, for example. **Server booting** is returned only after Edgegap accepts the create request and supplies a deployment ID. Browser polling controls when the display observes a state, but it does not advance the state machine.

This behavior is gated by `ENABLE_DEPLOYMENTS`. When it is `false`, checks fail closed without creating a server. Changing the tracked value is not enough: deploy the Worker deliberately, then confirm the binding shown by Wrangler.

## Connect the homepage

The included route handles `https://compersion.charliefeuerborn.com/watchdog/*`, and the homepage sends an empty `POST` to `/watchdog/wake`. The Durable Object records an immediate alarm before the Worker returns `202`; the alarm performs health and Edgegap reconciliation asynchronously. The existing direct WebSocket check independently drives the visible status message. Until the Worker route is deployed, the wake fails harmlessly and status still works. Do not embed `ADMIN_TOKEN` or `EDGEGAP_TOKEN` in the site. CORS reduces browser drive-by calls but is not authentication; apply Cloudflare rate controls to `/watchdog/wake` and `/watchdog/status` while allowing the documented status-poll cadence.

## Health-check contract

Do not add a separate HTTP readiness endpoint for this architecture. The homepage and Worker deliberately use the same direct WSS handshake. A successful check means Cloudflare reached the Bayou listener and completed the WebSocket opening handshake; it does not claim that every gameplay subsystem is healthy. Actual game-client connection remains the post-build smoke test.
