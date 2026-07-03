"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  probeMongoTransactions,
  resetMongoTransactionProbeForTests,
} = require("../services/walletLedgerService");

test("probeMongoTransactions uses standalone fast-path for localhost URI", async () => {
  resetMongoTransactionProbeForTests();
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    DB_URI: process.env.DB_URI,
    MONGO_URI: process.env.MONGO_URI,
    MONGODB_URI: process.env.MONGODB_URI,
    MONGO_STANDALONE: process.env.MONGO_STANDALONE,
  };
  process.env.NODE_ENV = "development";
  delete process.env.DB_URI;
  delete process.env.MONGO_URI;
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/game";
  delete process.env.MONGO_STANDALONE;

  try {
    const capability = await probeMongoTransactions();
    assert.equal(capability, "unsupported");
    const again = await probeMongoTransactions();
    assert.equal(again, "unsupported");
  } finally {
    resetMongoTransactionProbeForTests();
    process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.DB_URI === undefined) delete process.env.DB_URI;
    else process.env.DB_URI = prev.DB_URI;
    if (prev.MONGO_URI === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = prev.MONGO_URI;
    if (prev.MONGODB_URI === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = prev.MONGODB_URI;
    if (prev.MONGO_STANDALONE === undefined) delete process.env.MONGO_STANDALONE;
    else process.env.MONGO_STANDALONE = prev.MONGO_STANDALONE;
  }
});
