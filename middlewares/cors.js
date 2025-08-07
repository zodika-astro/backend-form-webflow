// middlewares/cors.js
const cors = require('cors');

const allowedOrigins = ['https://zodika.com.br', 'https://www.zodika.com.br'];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    const msg = 'CORS policy does not allow access from origin: ' + origin;
    return callback(new Error(msg), false);
  }
};

module.exports = cors(corsOptions);
