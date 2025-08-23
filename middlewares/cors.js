// middlewares/cors.js

const cors = require('cors');

const allowed = (process.env.ALLOWED_ORIGINS).split(',').map(s => s.trim());

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowed.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS blocked: ' + origin));
  }
};

module.exports = cors(corsOptions);
