const winston = require('winston');
const path = require('path');

// Custom format to exclude sensitive data
const sensitiveFields = ['password', 'token', 'secret', 'authorization', 'cookie', 'userTokens'];
const excludeSensitiveData = winston.format((info) => {
  const sanitizedInfo = { ...info };
  
  // Remove sensitive fields from log messages
  sensitiveFields.forEach(field => {
    if (sanitizedInfo[field]) {
      sanitizedInfo[field] = '[REDACTED]';
    }
  });
  
  // Sanitize request objects
  if (sanitizedInfo.req && sanitizedInfo.req.headers) {
    const sanitizedHeaders = { ...sanitizedInfo.req.headers };
    sensitiveFields.forEach(field => {
      if (sanitizedHeaders[field]) {
        sanitizedHeaders[field] = '[REDACTED]';
      }
    });
    sanitizedInfo.req.headers = sanitizedHeaders;
  }
  
  return sanitizedInfo;
});

// Custom format for structured logging
const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  excludeSensitiveData(),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp(),
  excludeSensitiveData(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'google-tasks-bot' },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug'
    }),
    
    // File transport for errors
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: logFormat
    }),
    
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: logFormat
    })
  ],
  
  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/exceptions.log'),
      format: logFormat
    })
  ],
  
  // Handle unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/rejections.log'),
      format: logFormat
    })
  ]
});

// Security audit logging
const securityLogger = winston.createLogger({
  level: 'info',
  format: logFormat,
  defaultMeta: { service: 'google-tasks-bot', component: 'security' },
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/security.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      format: logFormat
    })
  ]
});

// Security event logging
const logSecurityEvent = (event, details = {}) => {
  const securityEvent = {
    event,
    timestamp: new Date().toISOString(),
    ...details
  };
  
  // Log to security-specific file
  securityLogger.info(`Security event: ${event}`, securityEvent);
  
  // Also log to main logger for monitoring
  logger.warn(`Security event detected: ${event}`, securityEvent);
  
  // For critical security events, also log to error level
  const criticalEvents = ['authentication_failure', 'csrf_attempt', 'xss_attempt', 'file_upload_violation'];
  if (criticalEvents.includes(event)) {
    logger.error(`Critical security event: ${event}`, securityEvent);
  }
};

// Authentication logging
const logAuthentication = (action, details = {}) => {
  const authEvent = {
    action,
    timestamp: new Date().toISOString(),
    ...details
  };
  
  if (action === 'failed') {
    logSecurityEvent('authentication_failure', authEvent);
  } else {
    securityLogger.info(`Authentication ${action}`, authEvent);
  }
};

// File upload security logging
const logFileUpload = (details = {}) => {
  const uploadEvent = {
    timestamp: new Date().toISOString(),
    ...details
  };
  
  if (details.violation) {
    logSecurityEvent('file_upload_violation', uploadEvent);
  } else {
    securityLogger.info('File upload processed', uploadEvent);
  }
};

// Task operation logging
const logTaskOperation = (operation, details = {}) => {
  const taskEvent = {
    operation,
    timestamp: new Date().toISOString(),
    ...details
  };
  
  securityLogger.info(`Task operation: ${operation}`, taskEvent);
};

module.exports = {
  logger,
  securityLogger,
  logSecurityEvent,
  logAuthentication,
  logFileUpload,
  logTaskOperation
}; 