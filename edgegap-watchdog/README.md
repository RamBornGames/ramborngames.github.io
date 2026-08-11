# Compersion Edgegap watchdog

This Cloudflare Worker wakes when the homepage sends `POST /wake`. It performs at most one authoritative health check per minute. After the first failure, a Durable Object alarm continues the incident checks and replacement observation without requiring more visitors; the alarm stops when service is healthy. A SQLite-backed Durable Object stores state and serializes checks.

## Assumptions and safety behavior

- This is a strict singleton design: everyone connects to one persistent server.
- After three failures, the watchdog asks Edgegap to stop the known active deployment and waits for confirmed termination before creating a replacement. It never intentionally runs two production deployments against the shared Cloudflare Tunnel.
- This creates a short outage and disconnects current players during recovery, but prevents split-brain game state.
- The current `wss://` check proves the multiplayer socket accepts connections. An application-aware health endpoint would be stronger, but is not required for basic singleton recovery.
- Production currently has `ENABLE_DEPLOYMENTS=true`. Before changing or redeploying this Worker, verify the stable Edgegap version, placement, secrets, tunnel route, and that no more than one application-wide deployment is live.
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
   - `HEALTH_URL` after implementing a real readiness endpoint
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

With the included settings, a homepage visit wakes the Worker. If that check fails, alarms perform subsequent checks once per minute. After three failures, singleton recovery stops the known server, waits up to five minutes for confirmed termination, and then creates one replacement. The replacement has ten minutes to become `READY` and reconnect the public WebSocket. Cooldowns, attempt caps, durable attempt IDs, and a circuit breaker limit retries.

## Connect the homepage

The included route handles `https://compersion.charliefeuerborn.com/watchdog/*`, and the homepage sends an empty `POST` to `/watchdog/wake`. The Durable Object records an immediate alarm before the Worker returns `202`; the alarm performs health and Edgegap reconciliation asynchronously. The existing direct WebSocket check independently drives the visible status message. Until the Worker route is deployed, the wake fails harmlessly and status still works. Do not embed `ADMIN_TOKEN` or `EDGEGAP_TOKEN` in the site. CORS reduces browser drive-by calls but is not authentication; apply Cloudflare rate controls to `/watchdog/wake` and `/watchdog/status` while allowing the documented status-poll cadence.

## Recommended server health endpoint

Return HTTP `200` only after the multiplayer listener and required game state are initialized. Return `503` during startup or when the server cannot accept new players. Do not return credentials, environment variables, logs, filesystem paths, or player information.
