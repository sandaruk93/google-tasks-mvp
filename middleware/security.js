const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { logger, logSecurityEvent, logAuthentication } = require('../config/logger');

// Enhanced authentication middleware
const authenticateUser = async (req, res, next) => {
  try {
    const userTokens = req.cookies && req.cookies.userTokens;
    
    if (!userTokens) {
      logAuthentication('failed', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        reason: 'No tokens provided'
      });
      
      return res.status(401).json({
        success: false,
        message: 'Not authenticated. Please sign in again.'
      });
    }

    let tokens;
    try {
      tokens = JSON.parse(userTokens);
    } catch (error) {
      logAuthentication('failed', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        reason: 'Invalid token format'
      });
      
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication tokens'
      });
    }

    if (!tokens.access_token) {
      logAuthentication('failed', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        reason: 'Missing access token'
      });
      
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication tokens'
      });
    }

    // Check token expiration
    if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
      logAuthentication('failed', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        reason: 'Token expired'
      });
      
      return res.status(401).json({
        success: false,
        message: 'Authentication expired. Please sign in again.'
      });
    }

    // Validate token format (basic check)
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length < 10) {
      logAuthentication('failed', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        reason: 'Invalid token format'
      });
      
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication tokens'
      });
    }

    // Store tokens in request for later use
    req.userTokens = tokens;
    req.userId = tokens.user_id || 'unknown';
    
    logAuthentication('success', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId
    });
    
    next();
  } catch (error) {
    logger.error('Authentication error', {
      error: error.message,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    return res.status(500).json({
      success: false,
      message: 'Authentication error'
    });
  }
};

// Authorization middleware for specific resources
const authorizeResource = (resourceType) => {
  return (req, res, next) => {
    try {
      // For now, we only have user-specific resources
      // In the future, you might want to check specific permissions
      const userId = req.userId;
      
      if (!userId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
      
      // Log resource access
      logSecurityEvent('resource_access', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId,
        resource: resourceType,
        action: req.method,
        success: true
      });
      
      next();
    } catch (error) {
      logger.error('Authorization error', {
        error: error.message,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        resource: resourceType
      });
      
      return res.status(500).json({
        success: false,
        message: 'Authorization error'
      });
    }
  };
};

// CSRF protection middleware
const csrfProtection = (req, res, next) => {
  // For API endpoints, we'll use token-based CSRF protection
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  
  // Check for CSRF token in headers or body
  const csrfToken = req.get('X-CSRF-Token') || req.body._csrf;
  const sessionToken = req.cookies && req.cookies.csrfToken;
  
  if (!csrfToken || !sessionToken) {
    logSecurityEvent('csrf_attempt', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      method: req.method,
      path: req.path,
      reason: 'Missing CSRF token'
    });
    
    return res.status(403).json({
      success: false,
      message: 'CSRF token validation failed'
    });
  }
  
  if (csrfToken !== sessionToken) {
    logSecurityEvent('csrf_attempt', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      method: req.method,
      path: req.path,
      reason: 'CSRF token mismatch'
    });
    
    return res.status(403).json({
      success: false,
      message: 'CSRF token validation failed'
    });
  }
  
  next();
};

// Request logging middleware
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  // Log request start
  logger.info('Request started', {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.userId || 'anonymous'
  });
  
  // Override res.end to log response
  const originalEnd = res.end;
  res.end = function(chunk, encoding) {
    const duration = Date.now() - start;
    
    logger.info('Request completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous'
    });
    
    originalEnd.call(this, chunk, encoding);
  };
  
  next();
};

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.userId || 'anonymous'
  });
  
  // Don't expose internal errors to client
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;
  
  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// Security headers middleware
const securityHeaders = (req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Permissions policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // Remove X-Powered-By header
  res.removeHeader('X-Powered-By');
  
  // Content Security Policy
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src 'none'; object-src 'none'");
  
  next();
};

// Rate limiting error handler
const rateLimitErrorHandler = (err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Request entity too large'
    });
  }
  
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      message: 'Invalid request body'
    });
  }
  
  next(err);
};

// Session validation middleware
const validateSession = (req, res, next) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  
  if (!userTokens) {
    return next();
  }
  
  try {
    const tokens = JSON.parse(userTokens);
    
    // Check if session is still valid
    if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
      // Clear expired session
      res.clearCookie('userTokens');
      return next();
    }
    
    // Session is valid
    req.userTokens = tokens;
    req.userId = tokens.user_id || 'unknown';
    
  } catch (error) {
    // Clear invalid session
    res.clearCookie('userTokens');
  }
  
  next();
};

// Audit logging middleware
const auditLogger = (action) => {
  return (req, res, next) => {
    const auditData = {
      action,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous',
      timestamp: new Date().toISOString()
    };
    
    // Add request body for POST/PUT requests (excluding sensitive data)
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      const sanitizedBody = { ...req.body };
      delete sanitizedBody.password;
      delete sanitizedBody.token;
      delete sanitizedBody.secret;
      auditData.requestBody = sanitizedBody;
    }
    
    logger.info('Audit log', auditData);
    next();
  };
};

module.exports = {
  authenticateUser,
  authorizeResource,
  csrfProtection,
  requestLogger,
  errorHandler,
  securityHeaders,
  rateLimitErrorHandler,
  validateSession,
  auditLogger
}; 