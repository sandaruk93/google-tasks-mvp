# Use official Node.js runtime as base image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install security updates and create non-root user
RUN apk add --no-cache --update \
    && addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install dependencies with security audit
RUN npm ci --only=production \
    && npm audit --audit-level=high \
    && npm cache clean --force

# Copy application code
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p logs uploads/temp \
    && chown -R nodejs:nodejs /usr/src/app \
    && chmod -R 755 /usr/src/app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })" || exit 1

# Start the application
CMD ["node", "server.js"] 