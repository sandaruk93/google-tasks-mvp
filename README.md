# Google Tasks MVP

A simple web application that allows users to create Google Tasks through a web interface.

## Features

- Google OAuth2 authentication
- Create tasks in your Google Tasks list
- Simple web UI

## Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd google-meet-tasks-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up Google Cloud OAuth credentials**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable Google Tasks API
   - Create OAuth 2.0 credentials (Web application)
   - Set redirect URI to: `http://localhost:3000/oauth2callback`

4. **Create .env file**
   ```bash
   cp .env.example .env
   ```
   Then add your credentials:
   ```
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   REDIRECT_URI=http://localhost:3000/oauth2callback
   ```

5. **Run the application**
   ```bash
   npm start
   ```

6. **Visit the app**
   - Open [http://localhost:3000](http://localhost:3000)
   - Sign in with Google
   - Start creating tasks!

## Usage

1. Click "Sign in with Google"
2. Grant permission to access your Google Tasks
3. Enter a task description
4. Click "Add Task"
5. Check your Google Tasks to see the created task

## Technologies Used

- Node.js
- Express.js
- Google APIs (Tasks, OAuth2)
- HTML/CSS (minimal) 