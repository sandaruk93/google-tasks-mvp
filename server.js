const app = require('./app');
const { logger } = require('./config/logger');
const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
  
  // Force close after 30 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', {
    error: err.message,
    stack: err.stack
  });
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', {
    promise: promise,
    reason: reason
  });
  process.exit(1);
});

// Handle SIGTERM and SIGINT
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info('Omnia server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch
  });
  
  // Log environment configuration (without sensitive data)
  logger.info('Environment configuration', {
    googleClientId: process.env.GOOGLE_CLIENT_ID ? 'SET' : 'NOT SET',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'NOT SET',
    redirectUri: process.env.REDIRECT_URI || 'NOT SET',
    geminiApiKey: process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET',
    sessionSecret: process.env.SESSION_SECRET ? 'SET' : 'NOT SET',
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info'
  });
});

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use`);
    process.exit(1);
  } else {
    logger.error('Server error:', {
      error: err.message,
      stack: err.stack
    });
  }
});

// Export for testing
module.exports = server; 