const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scriptPath = path.join(__dirname, "..", "script.js");
const htmlPath = path.join(__dirname, "..", "index.html");
const source = fs.readFileSync(scriptPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const definitions = source.split("\n(async()=>")[0];

class FakeElement {
  constructor() {
    this.attributes = {};
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.textContent = "";
    this.title = "";
  }

  append(child) {
    this.children.push(child);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

function loadLanding(overrides = {}) {
  const elements = {
    "multiplayer-status": new FakeElement(),
    "multiplayer-help": new FakeElement(),
  };
  const document = {
    cookie: "",
    hidden: false,
    createElement: () => new FakeElement(),
    getElementById: (id) => elements[id],
  };
  const context = {
    WebSocket: overrides.WebSocket || class {},
    clearTimeout: overrides.clearTimeout || (() => {}),
    console,
    decodeURIComponent,
    document,
    encodeURIComponent,
    fetch: overrides.fetch || (async () => ({ status: 500 })),
    queueMicrotask,
    setTimeout: overrides.setTimeout || (() => 1),
  };
  vm.runInNewContext(
    definitions + "\nglobalThis.__landing={STATUS_SOCKET,WATCHDOG_WAKE,WATCHDOG_STATUS,states,fallback,checkSocketStatus,checkLiveStatus,renderStatus,followStartup};",
    context,
  );
  return { api: context.__landing, document, elements };
}

test("keeps the production endpoints and state names", () => {
  const { api } = loadLanding();
  assert.equal(api.STATUS_SOCKET, "wss://compersion.charliefeuerborn.com");
  assert.equal(api.WATCHDOG_WAKE, "https://compersion.charliefeuerborn.com/watchdog/wake");
  assert.equal(api.WATCHDOG_STATUS, "https://compersion.charliefeuerborn.com/watchdog/status");
  assert.deepEqual(Object.keys(api.states), [
    "ok", "operational", "waking", "checking", "stopping", "starting",
    "error", "degraded", "partial", "outage", "maintenance",
  ]);
});

test("loads and starts the status bootstrap before presentation assets", () => {
  const probeTag = '<script id="multiplayer-probe">';
  const scriptTag = '<script src="script.js?v=20260818-4" defer></script>';
  assert.ok(html.includes('id="multiplayer-status"'));
  assert.ok(html.includes('id="multiplayer-help"'));
  assert.ok(html.indexOf(probeTag) < html.indexOf(scriptTag));
  assert.ok(html.indexOf(scriptTag) < html.indexOf('<link rel="stylesheet" href="styles.css?v=20260818-5">'));
  assert.match(html, /__compersionSocketProbe=new Promise[\s\S]*new WebSocket\("wss:\/\/compersion\.charliefeuerborn\.com"\)[\s\S]*5000/);
  assert.match(source, /\(async\(\)=>\{let data=await checkLiveStatus\(\);saveHistory\(data\);renderStatus\(data\);if\(data\.current==="waking"\)followStartup\(data\.history\)\}\)\(\);\s*$/);
});

test("keeps every original destination and label without the extra header copy", () => {
  const originalLinks = [
    ["https://ramborngames.github.io/compersion/", "Play Compersion"],
    ["https://ramborngames.github.io/unscene/", "UNSCENE Compersion Article, Extended Cut"],
    ["https://ramseyfireborngames.com/", "Studio Website"],
    ["https://www.patreon.com/RamseyFirebornGames", "Support us on Patreon"],
    ["https://forms.gle/hxLfkX4au94oon1B8", "Sign up for our mailing list"],
  ];
  originalLinks.forEach(([href, label]) => {
    assert.ok(html.includes(`href="${href}"`));
    assert.ok(html.includes(label));
  });
  assert.ok(html.includes('class="brand-link" href="https://ramseyfireborngames.com/#contact"'));
  assert.ok(html.indexOf('class="squirrel-visual"') < html.indexOf('class="squirrel-caption"'));
  assert.ok(html.includes('id="mailing-list"'));
  assert.doesNotMatch(html, /site-header|A little portal|Featured game|link-note/);
});

test("a healthy socket reports operational without waking the worker", async () => {
  const events = [];
  class OpenSocket {
    constructor(url) {
      events.push(["socket", url]);
      this.readyState = 0;
      queueMicrotask(() => this.onopen());
    }
    close() {}
  }
  const { api } = loadLanding({
    WebSocket: OpenSocket,
    fetch: async () => {
      events.push(["fetch"]);
      return { status: 202 };
    },
  });

  const result = await api.checkLiveStatus();
  assert.equal(result.current, "ok");
  assert.deepEqual(events, [["socket", "wss://compersion.charliefeuerborn.com"]]);
});

test("a failed socket wakes the worker only afterward and accepts only 202", async () => {
  const events = [];
  class FailedSocket {
    constructor(url) {
      events.push(["socket", url]);
      this.readyState = 0;
      queueMicrotask(() => this.onerror());
    }
    close() {}
  }
  const { api } = loadLanding({
    WebSocket: FailedSocket,
    fetch: async (url, options) => {
      events.push(["fetch", url, options.method, options.cache]);
      return { status: 202 };
    },
  });

  const result = await api.checkLiveStatus();
  assert.equal(result.current, "waking");
  assert.deepEqual(events, [
    ["socket", "wss://compersion.charliefeuerborn.com"],
    ["fetch", "https://compersion.charliefeuerborn.com/watchdog/wake", "POST", "no-store"],
  ]);

  const nonAccepted = loadLanding({
    WebSocket: FailedSocket,
    fetch: async () => ({ status: 204 }),
  });
  assert.equal((await nonAccepted.api.checkLiveStatus()).current, "error");
});

test("renders checking detail, a single stage strip, and attention-only help", () => {
  const { api, elements } = loadLanding();
  api.renderStatus({
    current: "checking",
    failureCount: 1,
    failureThreshold: 3,
    history: api.fallback.history,
  });

  const host = elements["multiplayer-status"];
  assert.equal(host.className, "status maintenance");
  assert.equal(host.children[1].textContent, "Checking startup (1/3)");
  assert.equal(host.children[3].children.length, 1);
  assert.equal(host.children[3].attributes["aria-hidden"], "true");
  assert.equal(elements["multiplayer-help"].hidden, true);

  api.renderStatus({ current: "error", history: api.fallback.history });
  assert.equal(elements["multiplayer-help"].hidden, false);

  api.renderStatus({ current: "operational", history: api.fallback.history });
  assert.equal(host.className, "status ok");
  assert.equal(elements["multiplayer-help"].hidden, true);
});

test("preserves the staged polling, hidden-tab pause, deadline, and socket confirmation", () => {
  assert.match(source, /deadline=started\+660000/);
  assert.match(source, /delay=elapsed<30000\?2000:elapsed<120000\?5000:20000/);
  assert.match(source, /if\(document\.hidden\)continue/);
  assert.match(source, /if\(current==="operational"&&await checkSocketStatus\(\)!=="ok"\)current="checking"/);
  assert.match(source, /if\(current==="operational"\|\|current==="error"\)return/);
});
