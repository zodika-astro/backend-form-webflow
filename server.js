// server.js

'use strict';

/**
 * server.js
 * ---------
 * This file is the single entry point to start the Node.js server.
 * It imports the Express app definition from `index.js` and listens on a port.
 *
 * This separation allows the app definition (`index.js`) to be tested
 * and imported by other modules without accidentally starting the server.
 */

const app = require('./index');
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${PORT}`);
});
