const { body, param, query, validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
const xss = require('xss');
const { logger } = require('../config/logger');

// Sanitization options for HTML content
const sanitizeOptions = {
  allowedTags: [],
  allowedAttributes: {},
  allowedIframeHostnames: []
};

// XSS protection function
const sanitizeInput = (input) => {
  if (typeof input === 'string') {
    // Remove HTML tags
    const sanitized = sanitizeHtml(input, sanitizeOptions);
    // Additional XSS protection
    return xss(sanitized);
  }
  return input;
};

// Recursively sanitize object properties
const sanitizeObject = (obj) => {
  if (typeof obj !== 'object' || obj === null) {
    return sanitizeInput(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = sanitizeObject(value);
  }
  return sanitized;
};

// Middleware to sanitize request body
const sanitizeBody = (req, res, next) => {
  if (req.body) {
    req.body = sanitizeObject(req.body);
  }
  next();
};

// Middleware to sanitize query parameters
const sanitizeQuery = (req, res, next) => {
  if (req.query) {
    req.query = sanitizeObject(req.query);
  }
  next();
};

// Validation error handler
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation error', {
      errors: errors.array(),
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(error => ({
        field: error.path,
        message: error.msg,
        value: error.value
      }))
    });
  }
  next();
};

// Task validation rules
const validateTask = [
  body('task')
    .trim()
    .isLength({ min: 1, max: 8192 })
    .withMessage('Task must be between 1 and 8192 characters')
    .custom((value) => {
      // Check for XSS attempts
      const xssPatterns = [
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
        /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
        /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi
      ];
      
      for (const pattern of xssPatterns) {
        if (pattern.test(value)) {
          throw new Error('Task contains potentially malicious content');
        }
      }
      
      // Check for HTML tags
      if (/<[^>]*>/.test(value)) {
        throw new Error('Task contains HTML tags which are not allowed');
      }
      
      return true;
    }),
  handleValidationErrors
];

// Text processing validation rules
const validateTextProcessing = [
  body('text')
    .trim()
    .isLength({ min: 1, max: 50000 })
    .withMessage('Text must be between 1 and 50000 characters')
    .custom((value) => {
      // Check for XSS attempts
      const xssPatterns = [
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
        /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
        /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi
      ];
      
      for (const pattern of xssPatterns) {
        if (pattern.test(value)) {
          throw new Error('Text contains potentially malicious content');
        }
      }
      
      return true;
    }),
  handleValidationErrors
];

// Task confirmation validation rules
const validateTaskConfirmation = [
  body('tasks')
    .isArray({ min: 1, max: 100 })
    .withMessage('Tasks must be an array with 1-100 items'),
  body('tasks.*.task')
    .optional()
    .trim()
    .isLength({ min: 1, max: 8192 })
    .withMessage('Each task must be between 1 and 8192 characters')
    .matches(/^[^<>{}]*$/)
    .withMessage('Task contains invalid characters'),
  body('tasks.*.deadline')
    .optional()
    .isISO8601()
    .withMessage('Deadline must be a valid ISO 8601 date'),
  handleValidationErrors
];

// File upload validation
const validateFileUpload = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No file uploaded'
    });
  }
  
  // Check file size
  if (req.file.size > 10 * 1024 * 1024) { // 10MB
    return res.status(400).json({
      success: false,
      message: 'File size exceeds 10MB limit'
    });
  }
  
  // Check MIME type
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({
      success: false,
      message: 'Only PDF files are allowed'
    });
  }
  
  // Check file extension
  const allowedExtensions = ['.pdf'];
  const fileExtension = req.file.originalname.toLowerCase().substring(req.file.originalname.lastIndexOf('.'));
  if (!allowedExtensions.includes(fileExtension)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid file extension'
    });
  }
  
  // Additional security checks
  if (req.file.originalname.includes('..') || req.file.originalname.includes('/') || req.file.originalname.includes('\\')) {
    return res.status(400).json({
      success: false,
      message: 'Invalid filename'
    });
  }
  
  next();
};

// Authentication validation
const validateAuthentication = (req, res, next) => {
  const userTokens = req.cookies && req.cookies.userTokens;
  
  if (!userTokens) {
    return res.status(401).json({
      success: false,
      message: 'Not authenticated. Please sign in again.'
    });
  }
  
  try {
    const tokens = JSON.parse(userTokens);
    if (!tokens.access_token) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication tokens'
      });
    }
    next();
  } catch (error) {
    logger.warn('Invalid token format', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      error: error.message
    });
    
    return res.status(401).json({
      success: false,
      message: 'Invalid authentication tokens'
    });
  }
};

// Rate limiting validation
const validateRateLimit = (req, res, next) => {
  // This will be handled by express-rate-limit middleware
  next();
};

// Request size validation
const validateRequestSize = (req, res, next) => {
  const contentLength = parseInt(req.get('Content-Length') || '0');
  const maxSize = 50 * 1024 * 1024; // 50MB
  
  if (contentLength > maxSize) {
    return res.status(413).json({
      success: false,
      message: 'Request entity too large'
    });
  }
  
  next();
};

module.exports = {
  sanitizeBody,
  sanitizeQuery,
  sanitizeInput,
  sanitizeObject,
  validateTask,
  validateTextProcessing,
  validateTaskConfirmation,
  validateFileUpload,
  validateAuthentication,
  validateRateLimit,
  validateRequestSize,
  handleValidationErrors
}; 