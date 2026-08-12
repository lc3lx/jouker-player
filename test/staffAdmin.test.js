/**
 * Platform staff / superadmin permissions API tests.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "staff-admin-test-secret";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");

const MONGO_URI = `mongodb://127.0.0.1:27017/staff_admin_test_${process.pid}`;

let mongoAvailable = false;
let server;
let base;
let User;
const users = {};

const createToken = require("../utils/createToken");
const globalError = require("../middlewares/errorMiddleware");

async function makeUser(name, role = "user", permissions) {
  const doc = await User.create({
    name,
    email: `${name}@test.local`,
    password: "secret123",
    role,
    ...(permissions ? { permissions } : {}),
  });
  return { doc, token: createToken(doc._id, doc.sessionVersion) };
}

async function api(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, body: json };
}

function guarded(name, fn) {
  test(name, async (t) => {
    if (!mongoAvailable) {
      t.skip("mongo unavailable");
      return;
    }
    await fn();
  });
}

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2500 });
    mongoAvailable = true;
  } catch (_) {
    mongoAvailable = false;
    return;
  }

  User = require("../models/userModel");
  const adminStaffRoute = require("../routes/adminStaffRoute");
  const supportRoute = require("../routes/supportRoute");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminStaffRoute);
  app.use("/api/v1/support", supportRoute);
  app.use(globalError);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  users.super = await makeUser("super", "superadmin");
  users.admin = await makeUser("admin", "admin");
  users.support = await makeUser("support", "support");
  users.player = await makeUser("player", "user");
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (mongoAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

guarded("superadmin /admin/me returns all modules", async () => {
  const res = await api("GET", "/api/v1/admin/me", users.super.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.isSuperAdmin, true);
  assert.equal(res.body.data.modules.staff, true);
  assert.equal(res.body.data.modules.users, true);
  assert.ok(res.body.data.permissions.length > 5);
});

guarded("player cannot access /admin/me", async () => {
  const res = await api("GET", "/api/v1/admin/me", users.player.token);
  assert.equal(res.status, 403);
});

guarded("superadmin creates support staff with limited permissions", async () => {
  const created = await api("POST", "/api/v1/admin/staff", users.super.token, {
    name: "Support Desk",
    email: "desk@test.local",
    password: "secret123",
    role: "support",
    permissions: ["support.read", "support.write", "users.read", "admin.access"],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.role, "support");
  assert.ok(created.body.data.permissions.includes("support.write"));

  const list = await api("GET", "/api/v1/admin/staff", users.super.token);
  assert.equal(list.status, 200);
  assert.ok(list.body.results >= 4);
});

guarded("legacy admin without staff.write cannot create staff", async () => {
  const res = await api("POST", "/api/v1/admin/staff", users.admin.token, {
    name: "X",
    email: "x@test.local",
    password: "secret123",
    role: "support",
  });
  assert.equal(res.status, 403);
});

guarded("support staff can open support admin counts", async () => {
  const res = await api("GET", "/api/v1/support/admin/counts", users.support.token);
  assert.equal(res.status, 200);
});

guarded("platform overview works for staff", async () => {
  const res = await api(
    "GET",
    "/api/v1/admin/platform/overview",
    users.super.token
  );
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.data.users.total === "number");
  assert.ok(typeof res.body.data.staff.total === "number");
  assert.ok(res.body.data.live);
  assert.ok(typeof res.body.data.live.totalTables === "number");
  assert.ok(typeof res.body.data.live.seatedPlayers === "number");
  assert.ok(typeof res.body.data.live.playingTables === "number");
});

guarded("permissions catalog available to superadmin", async () => {
  const res = await api(
    "GET",
    "/api/v1/admin/permissions-catalog",
    users.super.token
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data.capabilities));
  assert.ok(res.body.data.staffRoles.includes("superadmin"));
});
