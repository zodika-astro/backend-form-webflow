// middlewares/errorHandler.js

/**
 * Express error-handling middleware.
 * Captures errors thrown in routes/controllers and formats a consistent JSON response.
 *
 * @param {Error} err - The error object
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next middleware function
 */
function errorHandler(err, req, res, next) {
  console.error(err); // You can replace this with your logger utility

  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;

  res.status(statusCode).json({
    message: err.message || 'Internal Server Error',
    // Only expose stack in development
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

module.exports = errorHandler;
