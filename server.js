const express = require('express');
const { google } = require('googleapis');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Google OAuth configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI || 'https://google-tasks-mvp.onrender.com/oauth2callback'
);

// Store tokens (in production, use a proper database)
let userTokens = {};

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// OAuth routes
app.get('/auth', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/tasks'],
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        userTokens = tokens;
        
        // Set tokens in cookies
        res.cookie('userTokens', JSON.stringify(tokens), {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict'
        });
        
        res.redirect('/');
    } catch (error) {
        console.error('Error getting tokens:', error);
        res.redirect('/?error=auth_failed');
    }
});

// Process text endpoint
app.post('/process-text', async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text || text.trim().length === 0) {
            return res.json({ success: false, message: 'Please provide some text' });
        }

        // Extract action items using Gemini API
        const actionItems = await extractActionItems(text);
        
        res.json({ 
            success: true, 
            message: `Found ${actionItems.length} action item(s)`,
            tasks: actionItems
        });
    } catch (error) {
        console.error('Error processing text:', error);
        res.json({ success: false, message: 'Error processing text' });
    }
});

// Process PDF endpoint
app.post('/process-transcript', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, message: 'No file uploaded' });
        }

        const pdfBuffer = req.file.buffer;
        const pdfData = await pdfParse(pdfBuffer);
        const text = pdfData.text;

        // Extract action items using Gemini API
        const actionItems = await extractActionItems(text);
        
        res.json({ 
            success: true, 
            message: `Found ${actionItems.length} action item(s)`,
            tasks: actionItems
        });
    } catch (error) {
        console.error('Error processing PDF:', error);
        res.json({ success: false, message: 'Error processing PDF' });
    }
});

// Add tasks to Google Tasks
app.post('/add-task', async (req, res) => {
    try {
        const { task } = req.body;
        
        if (!userTokens.access_token) {
            return res.json({ success: false, message: 'Please authenticate first' });
        }

        oauth2Client.setCredentials(userTokens);
        const tasksAPI = google.tasks({ version: 'v1', auth: oauth2Client });
        
        const result = await tasksAPI.tasks.insert({
            tasklist: '@default',
            requestBody: { title: task }
        });

        res.json({ success: true, message: 'Task added successfully' });
    } catch (error) {
        console.error('Error adding task:', error);
        res.json({ success: false, message: 'Error adding task' });
    }
});

// Extract action items using Gemini API
async function extractActionItems(text) {
    try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const prompt = `Extract action items and tasks from the following text. Return only the action items as a simple list, one per line. Do not include any explanations or additional text:

${text}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const tasks = response.text().split('\n').filter(task => task.trim().length > 0);
        
        return tasks;
    } catch (error) {
        console.error('Error using Gemini API:', error);
        // Fallback to regex extraction
        const actionItems = text.match(/(?:^|\n)(?:[-*•]\s*)?([A-Z][^.!?]*[.!?])/g);
        return actionItems ? actionItems.map(item => item.replace(/^[-*•]\s*/, '').trim()) : [];
    }
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
}); 