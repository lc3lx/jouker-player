const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const { sendAlert } = require("./alert");

async function setupSocketIoRedis(io) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return {
      enabled: false,
      commandClient: null,
      async close() {},
    };
  }

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();
  const commandClient = pubClient.duplicate();

  for (const c of [pubClient, subClient, commandClient]) {
    c.on("error", (err) => {
      void sendAlert("redis_client_error", {
        message: err?.message || "unknown",
      });
    });
    c.on("end", () => {
      void sendAlert("redis_disconnect", { client: "socketio_redis" });
    });
  }

  await Promise.all([
    pubClient.connect(),
    subClient.connect(),
    commandClient.connect(),
  ]);

  io.adapter(createAdapter(pubClient, subClient));

  return {
    enabled: true,
    commandClient,
    async close() {
      await Promise.allSettled([
        commandClient.quit(),
        subClient.quit(),
        pubClient.quit(),
      ]);
    },
  };
}

module.exports = { setupSocketIoRedis };

