// modules/birthchart/router.js

const express = require('express');
const router = express.Router();
const refererAuth = require('../../middlewares/refererAuth');
const birthchartController = require('./controller');

router.post('/birthchartsubmit-form', refererAuth, birthchartController.processForm);

module.exports = router;
