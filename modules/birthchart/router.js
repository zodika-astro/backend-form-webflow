// modules/birthchart/router.js

const express = require('express');
const router = express.Router();
const refererAuth = require('../../middlewares/refererAuth');
const birthchartRouter = require('./controller');

router.post('/birthchartsubmit-form', refererAuth, birthchartRouter.processForm);

module.exports = router;
