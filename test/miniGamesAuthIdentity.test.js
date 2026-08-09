/**
 * Smoke: Golden Tree / Poseidon identity must come from JWT (req.user), not body/query.
 * Run: node --test test/miniGamesAuthIdentity.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  requireUserId: goldenRequireUserId,
} = require("../controllers/goldenTreeController");
const {
  requireUserId: poseidonRequireUserId,
} = require("../controllers/poseidonController");

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("mini-games JWT identity (Golden Tree / Poseidon)", () => {
  it("Golden Tree requireUserId rejects missing req.user", () => {
    const req = { body: { userId: "spoofed-attacker" }, query: {} };
    const res = mockRes();
    let nextCalled = false;
    goldenRequireUserId(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(req.goldenTreeUserId, undefined);
  });

  it("Golden Tree requireUserId ignores body/query spoof and uses JWT user", () => {
    const req = {
      body: { userId: "spoofed-other-user" },
      query: { userId: "spoofed-query-user" },
      user: { _id: "jwt-user-abc" },
    };
    const res = mockRes();
    let nextCalled = false;
    goldenRequireUserId(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.goldenTreeUserId, "jwt-user-abc");
  });

  it("Poseidon requireUserId rejects missing req.user", () => {
    const req = { body: { userId: "spoofed-attacker" }, query: {} };
    const res = mockRes();
    let nextCalled = false;
    poseidonRequireUserId(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it("Poseidon requireUserId ignores body spoof and uses JWT user", () => {
    const req = {
      body: { userId: "victim-id" },
      user: { id: "jwt-user-xyz" },
    };
    const res = mockRes();
    let nextCalled = false;
    poseidonRequireUserId(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.poseidonUserId, "jwt-user-xyz");
  });

  it("Golden Tree router mounts protect before play/jackpot routes", () => {
    const router = require("../routes/goldenTreeRoute");
    const stack = router.stack || [];
    const layers = stack.map((l) => ({
      path: l.route?.path,
      methods: l.route ? Object.keys(l.route.methods) : null,
      name: l.name,
      handleName: l.handle?.name,
    }));

    // Public win-rules first
    const winRules = layers.find((l) => l.path === "/win-rules");
    assert.ok(winRules, "win-rules route exists");

    // authService.protect appears as a router-level middleware (no route path)
    const protectLayer = stack.find(
      (l) => !l.route && typeof l.handle === "function",
    );
    assert.ok(protectLayer, "router.use(protect) is mounted");

    const spinIdx = stack.findIndex((l) => l.route?.path === "/spin");
    const protectIdx = stack.findIndex(
      (l) => !l.route && typeof l.handle === "function",
    );
    assert.ok(protectIdx >= 0 && spinIdx > protectIdx, "protect before /spin");
  });

  it("Poseidon router mounts protect for all routes", () => {
    const router = require("../routes/poseidonRoute");
    const stack = router.stack || [];
    const protectIdx = stack.findIndex(
      (l) => !l.route && typeof l.handle === "function",
    );
    const spinIdx = stack.findIndex((l) => l.route?.path === "/spin");
    assert.ok(protectIdx >= 0, "protect mounted");
    assert.ok(spinIdx > protectIdx, "protect before /spin");
  });
});
