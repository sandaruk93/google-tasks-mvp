const request = require('supertest');
const app = require('../app');
const { logger } = require('../config/logger');

describe('Security Tests', () => {
  let server;

  beforeAll(() => {
    server = app.listen(0); // Use random port for testing
  });

  afterAll((done) => {
    server.close(done);
  });

  describe('Authentication & Authorization', () => {
    test('should reject requests without authentication', async () => {
      const response = await request(app)
        .post('/add-task')
        .send({ task: 'Test task' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Not authenticated');
    });

    test('should reject requests with invalid tokens', async () => {
      const response = await request(app)
        .post('/add-task')
        .set('Cookie', 'userTokens=invalid-json')
        .send({ task: 'Test task' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Invalid authentication tokens');
    });

    test('should reject requests with expired tokens', async () => {
      const expiredTokens = {
        access_token: 'expired-token',
        expiry_date: Date.now() - 1000 // Expired 1 second ago
      };

      const response = await request(app)
        .post('/add-task')
        .set('Cookie', `userTokens=${JSON.stringify(expiredTokens)}`)
        .send({ task: 'Test task' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Authentication expired');
    });
  });

  describe('Input Validation & Sanitization', () => {
    test('should reject tasks with XSS attempts', async () => {
      const maliciousTasks = [
        '<script>alert("xss")</script>',
        'javascript:alert("xss")',
        '<img src="x" onerror="alert(\'xss\')">',
        '"><script>alert("xss")</script>'
      ];

      for (const task of maliciousTasks) {
        const response = await request(app)
          .post('/add-task')
          .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
          .send({ task })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain('Validation failed');
      }
    });

    test('should reject tasks that are too long', async () => {
      const longTask = 'a'.repeat(9000); // Exceeds 8192 limit

      const response = await request(app)
        .post('/add-task')
        .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
        .send({ task: longTask })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Task must be between 1 and 8192 characters');
    });

    test('should reject empty tasks', async () => {
      const response = await request(app)
        .post('/add-task')
        .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
        .send({ task: '' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Validation failed');
    });
  });

  describe('File Upload Security', () => {
    test('should reject non-PDF files', async () => {
      const response = await request(app)
        .post('/process-transcript')
        .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
        .attach('transcript', Buffer.from('not a pdf'), 'test.txt')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Only PDF files are allowed');
    });

    test('should reject files with malicious names', async () => {
      const maliciousNames = [
        '../../../etc/passwd',
        'test.exe',
        'test.bat',
        'CON.pdf',
        'test<script>.pdf'
      ];

      for (const name of maliciousNames) {
        const response = await request(app)
          .post('/process-transcript')
          .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
          .attach('transcript', Buffer.from('%PDF-1.4 test'), name)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toContain('Invalid filename');
      }
    });

    test('should reject files that are too large', async () => {
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
      largeBuffer.write('%PDF-1.4', 0);

      const response = await request(app)
        .post('/process-transcript')
        .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
        .attach('transcript', largeBuffer, 'test.pdf')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('File size exceeds');
    });
  });

  describe('Rate Limiting', () => {
    test('should enforce rate limits on authentication endpoints', async () => {
      // Make multiple requests to trigger rate limiting
      for (let i = 0; i < 6; i++) {
        const response = await request(app)
          .get('/oauth2callback')
          .query({ code: 'test-code' });

        if (i < 5) {
          expect(response.status).not.toBe(429);
        } else {
          expect(response.status).toBe(429);
        }
      }
    });

    test('should enforce rate limits on file uploads', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 test content');

      // Make multiple upload requests to trigger rate limiting
      for (let i = 0; i < 11; i++) {
        const response = await request(app)
          .post('/process-transcript')
          .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
          .attach('transcript', pdfBuffer, `test${i}.pdf`);

        if (i < 10) {
          expect(response.status).not.toBe(429);
        } else {
          expect(response.status).toBe(429);
        }
      }
    });
  });

  describe('Security Headers', () => {
    test('should include security headers', async () => {
      const response = await request(app).get('/');

      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-xss-protection']).toBe('1; mode=block');
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(response.headers['permissions-policy']).toBe('geolocation=(), microphone=(), camera=()');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CSRF Protection', () => {
    test('should reject requests without CSRF token', async () => {
      const response = await request(app)
        .post('/add-task')
        .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
        .send({ task: 'Test task' })
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('CSRF token validation failed');
    });
  });

  describe('Request Size Limits', () => {
    test('should reject requests that are too large', async () => {
      const largeBody = { task: 'a'.repeat(60 * 1024 * 1024) }; // 60MB

      const response = await request(app)
        .post('/add-task')
        .set('Cookie', 'userTokens={"access_token":"test","expiry_date":9999999999999}')
        .send(largeBody)
        .expect(413);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Request entity too large');
    });
  });

  describe('Error Handling', () => {
    test('should not expose internal errors in production', async () => {
      // Mock production environment
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const response = await request(app)
        .post('/add-task')
        .send({ task: 'Test task' })
        .expect(401);

      expect(response.body.stack).toBeUndefined();
      expect(response.body.message).toBe('Not authenticated. Please sign in again.');

      // Restore environment
      process.env.NODE_ENV = originalEnv;
    });

    test('should log security events', async () => {
      const logSpy = jest.spyOn(logger, 'warn');

      await request(app)
        .post('/add-task')
        .set('Cookie', 'userTokens=invalid-json')
        .send({ task: 'Test task' });

      expect(logSpy).toHaveBeenCalledWith(
        'Invalid token format',
        expect.objectContaining({
          ip: expect.any(String),
          userAgent: expect.any(String),
          error: expect.any(String)
        })
      );

      logSpy.mockRestore();
    });
  });

  describe('Session Management', () => {
    test('should clear expired sessions', async () => {
      const expiredTokens = {
        access_token: 'test',
        expiry_date: Date.now() - 1000
      };

      const response = await request(app)
        .get('/account')
        .set('Cookie', `userTokens=${JSON.stringify(expiredTokens)}`);

      // Should redirect to home page when session is expired
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/');
    });
  });
}); 