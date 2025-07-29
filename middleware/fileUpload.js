const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { logger, logFileUpload } = require('../config/logger');

// Enhanced file storage configuration
const storage = multer.memoryStorage();

// File filter with enhanced security
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['application/pdf'];
  const allowedExtensions = ['.pdf'];
  
  // Check MIME type
  if (!allowedMimeTypes.includes(file.mimetype)) {
    logFileUpload({
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous',
      fileName: file.originalname,
      mimeType: file.mimetype,
      success: false,
      failureReason: 'Invalid MIME type'
    });
    
    return cb(new Error('Only PDF files are allowed'), false);
  }
  
  // Check file extension
  const fileExtension = path.extname(file.originalname).toLowerCase();
  if (!allowedExtensions.includes(fileExtension)) {
    logFileUpload({
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous',
      fileName: file.originalname,
      mimeType: file.mimetype,
      success: false,
      failureReason: 'Invalid file extension'
    });
    
    return cb(new Error('Invalid file extension'), false);
  }
  
  // Check for malicious filenames
  const maliciousPatterns = [
    /\.\./, // Path traversal
    /[<>:"|?*]/, // Invalid characters
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, // Reserved names
    /\.(exe|bat|cmd|com|pif|scr|vbs|js|jar|dll|so|dylib)$/i // Executable extensions
  ];
  
  for (const pattern of maliciousPatterns) {
    if (pattern.test(file.originalname)) {
      logFileUpload({
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.userId || 'anonymous',
        fileName: file.originalname,
        mimeType: file.mimetype,
        success: false,
        failureReason: 'Malicious filename detected'
      });
      
      return cb(new Error('Invalid filename'), false);
    }
  }
  
  // Check file size (10MB limit)
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size && file.size > maxSize) {
    logFileUpload({
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous',
      fileName: file.originalname,
      mimeType: file.mimetype,
      fileSize: file.size,
      success: false,
      failureReason: 'File size exceeds limit'
    });
    
    return cb(new Error('File size exceeds 10MB limit'), false);
  }
  
  // File passed all checks
  logFileUpload({
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.userId || 'anonymous',
    fileName: file.originalname,
    mimeType: file.mimetype,
    fileSize: file.size,
    success: true
  });
  
  cb(null, true);
};

// Enhanced multer configuration
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1, // Only allow 1 file per request
    fieldSize: 1024 * 1024 // 1MB for field data
  },
  fileFilter: fileFilter
});

// File content validation middleware
const validateFileContent = async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No file uploaded'
    });
  }
  
  try {
    const buffer = req.file.buffer;
    
    // Check for PDF magic numbers
    const pdfMagicNumbers = [0x25, 0x50, 0x44, 0x46]; // %PDF
    const isPdf = pdfMagicNumbers.every((byte, index) => buffer[index] === byte);
    
    if (!isPdf) {
      logFileUpload({
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.userId || 'anonymous',
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        success: false,
        failureReason: 'Invalid PDF content'
      });
      
      return res.status(400).json({
        success: false,
        message: 'Invalid PDF file content'
      });
    }
    
    // Check for embedded objects or scripts (basic check)
    const content = buffer.toString('utf8', 0, Math.min(buffer.length, 10000));
    const suspiciousPatterns = [
      /\/JavaScript/,
      /\/JS/,
      /\/Launch/,
      /\/SubmitForm/,
      /\/ImportData/,
      /\/RichMedia/,
      /\/XFA/
    ];
    
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(content)) {
        logFileUpload({
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          userId: req.userId || 'anonymous',
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          fileSize: req.file.size,
          success: false,
          failureReason: 'Suspicious PDF content detected'
        });
        
        return res.status(400).json({
          success: false,
          message: 'PDF contains potentially harmful content'
        });
      }
    }
    
    // File passed all content validation
    next();
    
  } catch (error) {
    logger.error('File content validation error', {
      error: error.message,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous',
      fileName: req.file?.originalname
    });
    
    return res.status(500).json({
      success: false,
      message: 'Error validating file content'
    });
  }
};

// Rate limiting for file uploads
const uploadRateLimit = {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 10 uploads per hour
  message: {
    error: 'Too many file uploads, please try again later.',
    retryAfter: '1 hour'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skipFailedRequests: false
};

// File cleanup middleware
const cleanupUploads = (req, res, next) => {
  // Clean up file buffer after processing
  if (req.file && req.file.buffer) {
    req.file.buffer = null;
  }
  next();
};

// Enhanced error handling for file uploads
const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    let message = 'File upload error';
    
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File size exceeds 10MB limit';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Only one file allowed per request';
        break;
      case 'LIMIT_FIELD_SIZE':
        message = 'Field size exceeds limit';
        break;
      default:
        message = 'File upload error';
    }
    
    logFileUpload({
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous',
      success: false,
      failureReason: message
    });
    
    return res.status(400).json({
      success: false,
      message
    });
  }
  
  // Handle other file-related errors
  if (error.message.includes('Only PDF files are allowed') ||
      error.message.includes('Invalid file extension') ||
      error.message.includes('Invalid filename') ||
      error.message.includes('File size exceeds')) {
    
    logFileUpload({
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.userId || 'anonymous',
      success: false,
      failureReason: error.message
    });
    
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
  
  // Log unexpected errors
  logger.error('Unexpected file upload error', {
    error: error.message,
    stack: error.stack,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.userId || 'anonymous'
  });
  
  return res.status(500).json({
    success: false,
    message: 'File upload error'
  });
};

module.exports = {
  upload,
  validateFileContent,
  uploadRateLimit,
  cleanupUploads,
  handleUploadError
}; 