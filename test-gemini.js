const GeminiHelper = require('./utils/geminiHelper');
require('dotenv').config();

async function testGemini() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not found in environment variables');
    return;
  }

  const geminiHelper = new GeminiHelper(process.env.GEMINI_API_KEY);
  
  // Test with a simple meeting transcript
  const testTranscript = `
  Meeting: Project Planning
  Attendees: John Smith, Sarah Johnson, Mike Davis
  
  John: I'll review the quarterly budget by Friday.
  Sarah: I need to schedule the follow-up meeting.
  Mike: I'll update the project timeline.
  John: Sarah, can you handle the client communication?
  Sarah: Yes, I'll take care of that.
  `;

  console.log('Testing Gemini with transcript:');
  console.log(testTranscript);
  console.log('\n---\n');

  try {
    const result = await geminiHelper.extractActionItems(testTranscript);
    console.log('Gemini result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error testing Gemini:', error);
  }
}

testGemini();
