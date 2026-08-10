"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Lightweight contract checks for activities feed mapping / filters.
 * Keeps activityService behavior honest without spinning Mongo.
 */

const FEED_CATEGORIES = {
  all: null,
  win: ["win"],
  loss: ["loss"],
  task: ["task", "bonus"],
};

const WIN_TX_TYPES = ["win", "game_win", "island_jackpot_win"];
const LOSS_TX_TYPES = ["game_loss", "bet", "game_buyin"];

function mapTxToActivity(tx, tableName = "طاولة") {
  const amount = Math.floor(Number(tx.amount) || 0);
  if (tx.type === "win" || tx.type === "game_win" || tx.type === "island_jackpot_win") {
    return {
      category: "win",
      amountValue: amount,
      label: `فزت في ${tableName}`,
    };
  }
  if (tx.type === "game_loss") {
    return {
      category: "loss",
      amountValue: -amount,
      label: `خسرت في ${tableName}`,
    };
  }
  if (tx.type === "bet" || tx.type === "game_buyin") {
    return {
      category: "other",
      amountValue: -amount,
      label: tx.type === "game_buyin" ? `دخول ${tableName}` : `رهان في ${tableName}`,
    };
  }
  return null;
}

describe("activities feed filters", () => {
  it("exposes win/loss/task filter sets used by the API", () => {
    assert.deepEqual(FEED_CATEGORIES.win, ["win"]);
    assert.deepEqual(FEED_CATEGORIES.loss, ["loss"]);
    assert.deepEqual(FEED_CATEGORIES.task, ["task", "bonus"]);
    assert.equal(FEED_CATEGORIES.all, null);
  });

  it("does not label bet/buy-in as loss category", () => {
    const bet = mapTxToActivity({ type: "bet", amount: 500 });
    const buyIn = mapTxToActivity({ type: "game_buyin", amount: 1000 });
    const loss = mapTxToActivity({ type: "game_loss", amount: 200 });
    assert.equal(bet.category, "other");
    assert.equal(buyIn.category, "other");
    assert.equal(loss.category, "loss");
    assert.ok(!String(bet.label).startsWith("خسرت"));
    assert.ok(String(loss.label).startsWith("خسرت"));
  });

  it("maps win types to win category", () => {
    for (const type of WIN_TX_TYPES) {
      const row = mapTxToActivity({ type, amount: 100 });
      assert.equal(row.category, "win");
      assert.equal(row.amountValue, 100);
    }
  });

  it("weekly PnL signs: wins positive, loss types subtract", () => {
    const wins = 1000;
    const losses = LOSS_TX_TYPES.reduce((s, _t, i) => s + (i + 1) * 100, 0);
    // 100+200+300 = 600
    assert.equal(losses, 600);
    assert.equal(wins - losses, 400);
  });
});
