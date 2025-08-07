// routes/birthchart.route.js
const express = require('express');
const router = express.Router();
const birthchartController = require('../controllers/birthchart.controller');

// POST /birth-chartendpoint
router.post('/', birthchartController.handleBirthChartRequest);

module.exports = router;
