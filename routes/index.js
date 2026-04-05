const userRoute = require("./userRoute");
const authRoute = require("./authRoute");
const walletRoute = require("./walletRoute");
const rechargeCodeRoute = require("./rechargeCodeRoute");
const gameRoute = require("./gameRoute");
const tableRoute = require("./tableRoute");
const tournamentRoute = require("./tournamentRoute");
const jackpotRoute = require("./jackpotRoute");
const sideGamesRoute = require("./sideGamesRoute");
const statsRoute = require("./statsRoute");
const rtcRoute = require("./rtcRoute");
const agentRoute = require("./agentRoute");
const adminRoute = require("./adminRoute");
const analyticsRoute = require("./analyticsRoute");
const cosmeticsRoute = require("./cosmeticsRoute");
const videoRoute = require("./videoRoute");
const kingArthRoute = require("./kingArthRoute");

const mountRoutes = (app) => {
  app.get("/api/v1/games/html5", (req, res) => {
    res.json({
      results: 1,
      data: [
        {
          id: "trix",
          name: "تركس",
          nameEn: "Trix",
          description: "لعبة ورق شهيرة في الشرق الأوسط - 4 لاعبين، 20 جولة",
          url: "/games/trix/",
        },
      ],
    });
  });
  app.use("/api/v1/users", userRoute);
  app.use("/api/v1/auth", authRoute);
  app.use("/api/v1/wallet", walletRoute);
  app.use("/api/v1/game", gameRoute);
  app.use("/api/v1/tables", tableRoute);
  app.use("/api/v1/tournaments", tournamentRoute);
  app.use("/api/v1/jackpot", jackpotRoute);
  app.use("/api/v1/side-games", sideGamesRoute);
  app.use("/api/v1/stats", statsRoute);
  app.use("/api/v1/rtc", rtcRoute);
  app.use("/api/v1/recharge-codes", rechargeCodeRoute);
  app.use("/api/v1/agents", agentRoute);
  app.use("/api/v1/admin", adminRoute);
  app.use("/api/v1/analytics", analyticsRoute);
  app.use("/api/v1/cosmetics", cosmeticsRoute);
  app.use("/api/v1/video", videoRoute);
  app.use("/api/v1/king-arth", kingArthRoute);
};

module.exports = mountRoutes;
