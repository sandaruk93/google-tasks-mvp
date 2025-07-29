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

// Helper functions for structured logging
const logSecurityEvent = (event, details = {}) => {
  securityLogger.info('Security event', {
    event,
    timestamp: new Date().toISOString(),
    ip: details.ip,
    userAgent: details.userAgent,
    userId: details.userId,
    action: details.action,
    resource: details.resource,
    success: details.success,
    ...details
  });
};

const logAuthentication = (action, details = {}) => {
  securityLogger.info('Authentication event', {
    event: 'authentication',
    action,
    timestamp: new Date().toISOString(),
    ip: details.ip,
    userAgent: details.userAgent,
    success: details.success,
    failureReason: details.failureReason,
    ...details
  });
};

const logFileUpload = (details = {}) => {
  securityLogger.info('File upload event', {
    event: 'file_upload',
    timestamp: new Date().toISOString(),
    ip: details.ip,
    userAgent: details.userAgent,
    userId: details.userId,
    fileName: details.fileName,
    fileSize: details.fileSize,
    mimeType: details.mimeType,
    success: details.success,
    failureReason: details.failureReason,
    ...details
  });
};

const logTaskOperation = (operation, details = {}) => {
  securityLogger.info('Task operation event', {
    event: 'task_operation',
    operation,
    timestamp: new Date().toISOString(),
    ip: details.ip,
    userAgent: details.userAgent,
    userId: details.userId,
    taskCount: details.taskCount,
    success: details.success,
    failureReason: details.failureReason,
    ...details
  });
};

module.exports = {
  logger,
  securityLogger,
  logSecurityEvent,
  logAuthentication,
  logFileUpload,
  logTaskOperation
}; 