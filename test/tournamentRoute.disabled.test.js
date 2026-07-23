"use strict";

/**
 * Regression tests proving the standalone legacy Tournament system's public
 * routes are fully disabled (see docs/STANDALONE_TOURNAMENT_DISABLED.md):
 * every route responds with the documented disabled shape, auth middleware
 * on the money-mutating routes is still intact, and — the strongest
 * guarantee — the route file no longer even requires the modules containing
 * the buggy wallet-debit/registration code, so it is structurally
 * impossible for any request through this router to reach them.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROUTE_FILE = path.join(__dirname, "..", "routes", "tournamentRoute.js");
const router = require("../routes/tournamentRoute.js");

function findRoute(routerStack, method, routePath) {
  const layer = routerStack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  return layer.route;
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

test("route file no longer requires the modules containing the buggy money-path code", () => {
  const source = fs.readFileSync(ROUTE_FILE, "utf8");
  // Check actual require(...) calls, not explanatory comment text (the file's
  // header comment legitimately names these modules to explain the disable).
  const requireCalls = [...source.matchAll(/require\((["'])(.*?)\1\)/g)].map((m) => m[2]);
  assert.equal(requireCalls.some((r) => r.includes("tournamentService")), false);
  assert.equal(requireCalls.some((r) => r.includes("tournamentEngineService")), false);
  assert.equal(requireCalls.some((r) => r.includes("walletModel")), false);
  // The file must still exist and export something usable (not deleted, per the disable-not-delete requirement).
  assert.equal(typeof router, "function");
});

test("GET / returns the empty success shape (paginated) with no error", async () => {
  const route = findRoute(router.stack, "get", "/");
  const handler = route.stack[route.stack.length - 1].handle;
  const req = { query: {} };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "success");
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.results, 0);
  assert.ok(res.body.paginationResult);
});

test("GET /lobby returns the empty success shape matching the live Flutter client's expectations", async () => {
  const route = findRoute(router.stack, "get", "/lobby");
  const handler = route.stack[route.stack.length - 1].handle;
  const req = {};
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  // frontapp's PokerTournamentService.fetchLobby() reads res.data['data'] as a List.
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.results, 0);
});

for (const routePath of ["/:id", "/:id/statistics", "/:id/leaderboard"]) {
  test(`GET ${routePath} returns 404 "feature unavailable"`, async () => {
    const route = findRoute(router.stack, "get", routePath);
    const handler = route.stack[route.stack.length - 1].handle;
    const req = { params: { id: "507f1f77bcf86cd799439011" } };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.status, "error");
  });
}

test("POST / (create) keeps admin-only auth middleware, and its final handler is the disabled stub (never the real createTournament)", () => {
  const route = findRoute(router.stack, "post", "/");
  const names = route.stack.map((l) => l.name);
  // authService.protect + authService.allowedTo are both express-async-handler-wrapped.
  assert.equal(route.stack.length, 3, "protect + allowedTo + disabledMutation");
  assert.equal(names[names.length - 1], "disabledMutation");
});

test("POST / (create) final handler returns 410 without touching any wallet/engine code", async () => {
  const route = findRoute(router.stack, "post", "/");
  const handler = route.stack[route.stack.length - 1].handle;
  const req = { body: { name: "x" } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.status, "error");
});

test("POST /:id/register keeps protect auth middleware, and its final handler is the disabled stub (never the real registerTournament)", () => {
  const route = findRoute(router.stack, "post", "/:id/register");
  const names = route.stack.map((l) => l.name);
  assert.equal(route.stack.length, 2, "protect + disabledMutation");
  assert.equal(names[names.length - 1], "disabledMutation");
});

test("POST /:id/register final handler returns 410 without touching any wallet/engine code", async () => {
  const route = findRoute(router.stack, "post", "/:id/register");
  const handler = route.stack[route.stack.length - 1].handle;
  const req = { params: { id: "507f1f77bcf86cd799439011" }, user: { _id: "507f1f77bcf86cd799439012" } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.status, "error");
  assert.match(res.body.message, /disabled/i);
});

test("the standalone Tournament model/service/engine files are untouched — still present, not deleted", () => {
  const files = [
    "../models/tournamentModel.js",
    "../services/tournamentService.js",
    "../services/tournamentEngineService.js",
  ];
  for (const f of files) {
    assert.doesNotThrow(() => require(f), `${f} must still exist and load cleanly`);
  }
});

test("server.js no longer starts the standalone tournament engine at boot", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(
    /startEngine:\s*startTournamentEngine\s*\}\s*=\s*require\(["']\.\/services\/tournamentEngineService["']\)/.test(
      serverSource
    ),
    false,
    "server.js must not destructure/require startEngine from tournamentEngineService for boot"
  );
  assert.equal(
    /(?<!Clan)startTournamentEngine\(\)/.test(serverSource),
    false,
    "server.js must not call startTournamentEngine()"
  );
});
