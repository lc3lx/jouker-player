/**
 * سيرفر اختبار طرنيب - للتحقق من منطق اللعبة قبل Flutter
 * يستخدم Socket.io ويخدم صفحة HTML بسيطة
 */
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const TarneebGame = require("../games/tarneeb/TarneebGame");

const app = express();
const httpServer = http.createServer(app);

// خدمة الملفات الثابتة
app.use(express.static(path.join(__dirname, "public")));

app.get("/ping", (req, res) => res.json({ ok: true, msg: "Tarneeb server OK" }));

const io = new Server(httpServer, {
  cors: { origin: "*" },
  transports: ["polling", "websocket"],
  allowEIO3: true
});

// لعبة طرنيب واحدة مع 4 لاعبين محاكيين
let game = null;

function initGame() {
  game = new TarneebGame("test-room");
  for (let i = 0; i < 4; i += 1) {
    game.addPlayer(`p${i}`, `sock-${i}`);
  }
  game.startGame();
}

initGame();

io.on("connection", (socket) => {
  console.log("[Tarneeb] Client connected:", socket.id);
  socket.on("disconnect", () => console.log("[Tarneeb] Client disconnected:", socket.id));
  // إرسال الحالة الحالية للاعب المحدد
  function sendState(playerIndex) {
    if (!game) return;
    const idx = Math.max(0, Math.min(3, parseInt(playerIndex, 10) || 0));
    const state = game.getGameState(idx);
    state.viewPlayerIndex = idx;
    socket.emit("game_state", state);
  }

  socket.on("get_state", (playerIndex) => {
    sendState(playerIndex);
  });

  socket.on("action", (msg) => {
    const { playerIndex, action, payload } = msg || {};
    const idx = Math.max(0, Math.min(3, parseInt(playerIndex, 10) || 0));

    if (!game) {
      socket.emit("error", { reason: "no_game" });
      return;
    }

    let result;
    if (action === "bid") {
      result = game.applyMove(idx, "bid", payload || {});
    } else if (action === "choose_trump") {
      result = game.applyMove(idx, "choose_trump", payload || {});
    } else if (action === "play_card") {
      result = game.applyMove(idx, "play_card", payload || {});
    } else if (action === "next_round") {
      const ok = game.nextRound();
      result = { success: ok, reason: ok ? null : "cannot_next_round" };
    } else {
      result = { success: false, reason: "unknown_action" };
    }

    socket.emit("action_result", result);
    sendState(idx);

    if (game.state === "round_end" || game.state === "game_end") {
      socket.emit("round_result", game.getRoundResult());
      if (game.isGameFinished()) {
        socket.emit("game_finished", game.getGameResult());
      }
    }
  });

  socket.on("reset_game", () => {
    initGame();
    sendState(0);
    socket.emit("reset_ok", {});
  });

  sendState(0);
});

const PORT = process.env.TARNEEB_PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Tarneeb test server: http://localhost:${PORT}`);
});
