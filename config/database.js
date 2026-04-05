const mongoose = require("mongoose");

const dbConnection = () => {
  const uri =
    process.env.DB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/game';
  mongoose.connect(uri).then((conn) => {
    console.log(`Database Connected: ${conn.connection.host}`);
  });
  // .catch((err) => {
  //   console.error(`Database Error: ${err}`);
  //   process.exit(1);
  // });
};

module.exports = dbConnection;
