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
const interactionRoute = require("./interactionRoute");
const videoRoute = require("./videoRoute");
const kingArthRoute = require("./kingArthRoute");
const activityRoute = require("./activityRoute");
const taskRoute = require("./taskRoute");
const parkourRoute = require("./parkourRoute");
const timeRoute = require("./timeRoute");
const goldenTreeRoute = require("./goldenTreeRoute");
const poseidonRoute = require("./poseidonRoute");
const sicboRoute = require("./sicboRoute");
const adminSicboRoute = require("./adminSicboRoute");
const luckyWheelRoute = require("./luckyWheelRoute");
const socialRoute = require("./socialRoute");
const chatRoute = require("./chatRoute");
const replayRoute = require("./replayRoute");
const platformRoute = require("./platformRoute");
const historyRoute = require("./historyRoute");
const openapiRoute = require("./openapiRoute");
const vipRoute = require("./vipRoute");
const adminVipRoute = require("./adminVipRoute");
const islandJackpotRoute = require("./islandJackpotRoute");
const adminIslandJackpotRoute = require("./adminIslandJackpotRoute");
const notificationRoute = require("./notificationRoute");
const supportRoute = require("./supportRoute");
const agentDepositRoute = require("./agentDepositRoute");
const referralRoute = require("./referralRoute");
const adminReferralRoute = require("./adminReferralRoute");
const adminEconomyRoute = require("./adminEconomyRoute");
const adminCosmeticsRoute = require("./adminCosmeticsRoute");
const adminUserRoute = require("./adminUserRoute");
const adminBotRoute = require("./adminBotRoute");
const adminClanRoute = require("./adminClanRoute");
const giftRoute = require("./giftRoute");
const clanRoute = require("./clanRoute");
const mountInviteLanding = require("./inviteLandingRoute");

const mountRoutes = (app) => {
  mountInviteLanding(app);
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
  app.use("/api/v1/poker/island", islandJackpotRoute);
  app.use("/api/v1/side-games", sideGamesRoute);
  app.use("/api/v1/stats", statsRoute);
  app.use("/api/v1/rtc", rtcRoute);
  app.use("/api/v1/recharge-codes", rechargeCodeRoute);
  app.use("/api/v1/agents", agentRoute);
  app.use("/api/v1/admin/vip", adminVipRoute);
  app.use("/api/v1/admin/island-jackpot", adminIslandJackpotRoute);
  // Mounted BEFORE the generic /admin router so these sub-paths resolve here.
  app.use("/api/v1/admin/economy", adminEconomyRoute);
  app.use("/api/v1/admin/cosmetics", adminCosmeticsRoute);
  app.use("/api/v1/admin/users", adminUserRoute);
  app.use("/api/v1/admin/clans", adminClanRoute);
  app.use("/api/v1/admin/bots", adminBotRoute);
  app.use("/api/v1/admin", adminRoute);
  app.use("/api/v1/vip", vipRoute);
  app.use("/api/v1/analytics", analyticsRoute);
  app.use("/api/v1/cosmetics", cosmeticsRoute);
  app.use("/api/v1/interactions", interactionRoute);
  app.use("/api/v1/video", videoRoute);
  app.use("/api/v1/king-arth", kingArthRoute);
  app.use("/api/v1/activities", activityRoute);
  app.use("/api/v1/tasks", taskRoute);
  app.use("/api/v1/notifications", notificationRoute);
  app.use("/api/v1/support", supportRoute);
  app.use("/api/v1/agent-deposits", agentDepositRoute);
  app.use("/api/v1/referrals", referralRoute);
  app.use("/api/v1/admin/referrals", adminReferralRoute);
  app.use("/api/v1/parkour", parkourRoute);
  app.use("/api/v1/time", timeRoute);
  app.use("/api/v1/lucky-wheel", luckyWheelRoute);
  app.use("/api/v1/sicbo", sicboRoute);
  app.use("/api/v1/admin/sicbo", adminSicboRoute);
  app.use("/api/v1/social", socialRoute);
  app.use("/api/v1/clans", clanRoute);
  app.use("/api/v1/gifts", giftRoute);
  app.use("/api/v1/chat", chatRoute);
  app.use("/api/v1/replay", replayRoute);
  app.use("/api/v1/platform", platformRoute);
  app.use("/api/v1/history", historyRoute);
  app.use("/api-docs", openapiRoute);
  app.use("/api/game", goldenTreeRoute);
  app.use("/api/poseidon", poseidonRoute);
};

module.exports = mountRoutes;
