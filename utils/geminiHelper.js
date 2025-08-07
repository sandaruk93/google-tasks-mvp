const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiHelper {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    this.maxRetries = 3;
    this.retryDelay = 2000; // 2 seconds
  }

  async extractActionItems(text, retryCount = 0) {
    try {
      console.log(`Attempting Gemini API call (attempt ${retryCount + 1}/${this.maxRetries + 1})`);
      
      const prompt = `Analyze the following meeting transcript to extract action items and identify task assignments.

TASK: Extract action items and assign them to the most appropriate meeting attendee based on:
1. Who is mentioned in relation to the task
2. Who has the expertise or responsibility for the task
3. Who volunteered or was assigned the task
4. Context clues about who should handle the task

INSTRUCTIONS:
- First, identify all meeting attendees mentioned in the transcript
- For each action item, determine the most appropriate assignee
- If no clear assignee is found, mark as "Unassigned"
- Consider context, responsibilities, and explicit assignments

Return ONLY a JSON array of objects, where each object has:
- "task": a clear, concise task description
- "assignee": the name of the person assigned to the task (or "Unassigned" if unclear)
- "assigneeReason": brief explanation of why this person was assigned (e.g., "mentioned in relation to task", "has expertise in area", "volunteered")
- "deadline": the deadline in ISO 8601 format (YYYY-MM-DDTHH:MM:SS) if mentioned, or null if no deadline
- "deadlineText": the original deadline text as mentioned in the transcript (e.g., "by Friday", "tomorrow", "next week")

Example output format:
[
  {
    "task": "Review the quarterly budget",
    "assignee": "Sarah Johnson",
    "assigneeReason": "mentioned as finance lead",
    "deadline": "2024-01-15T17:00:00",
    "deadlineText": "by Friday"
  },
  {
    "task": "Schedule follow-up meeting",
    "assignee": "Unassigned",
    "assigneeReason": "no clear assignee mentioned",
    "deadline": null,
    "deadlineText": null
  }
]

Meeting transcript: ${text}`;

      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const geminiResponse = response.text();
      
      console.log('Gemini response received, length:', geminiResponse.length);
      
      return this.parseGeminiResponse(geminiResponse);
      
    } catch (error) {
      console.error(`Gemini API error (attempt ${retryCount + 1}):`, error.message);
      
      // Check if it's a retryable error
      if (this.isRetryableError(error) && retryCount < this.maxRetries) {
        console.log(`Retrying in ${this.retryDelay}ms...`);
        await this.delay(this.retryDelay);
        return this.extractActionItems(text, retryCount + 1);
      }
      
      // If all retries failed or it's a non-retryable error
      console.error('All Gemini API attempts failed, returning empty array');
      return [];
    }
  }

  isRetryableError(error) {
    const retryableStatusCodes = [429, 500, 502, 503, 504];
    const retryableMessages = [
      'overloaded',
      'service unavailable',
      'rate limit',
      'timeout',
      'network error',
      'fetch failed'
    ];
    
    // Check status code
    if (error.status && retryableStatusCodes.includes(error.status)) {
      return true;
    }
    
    // Check error message
    const errorMessage = error.message.toLowerCase();
    return retryableMessages.some(msg => errorMessage.includes(msg));
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  parseGeminiResponse(geminiResponse) {
    try {
      // Clean up the response and parse JSON
      const cleanedText = geminiResponse.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
      console.log('Cleaned response for JSON parsing:', cleanedText);
      
      let actionItems = JSON.parse(cleanedText);
      
      // Debug: Log the raw parsed response
      console.log('Raw parsed action items:', JSON.stringify(actionItems, null, 2));
      
      // Ensure it's an array
      if (!Array.isArray(actionItems)) {
        console.error('Gemini response is not an array:', actionItems);
        return [];
      }
      
      // Filter out empty or invalid items and convert to new format
      actionItems = actionItems.filter(item => {
        if (!item || typeof item !== 'object') {
          console.log('Skipping invalid item:', item);
          return false;
        }
        
        // Handle both old string format and new object format
        if (typeof item === 'string') {
          return item.trim().length > 5 && item.trim().length < 300;
        } else if (item.task) {
          return item.task.trim().length > 5 && item.task.trim().length < 300;
        }
        return false;
      }).map(item => {
        // Convert to consistent object format with assignee information
        if (typeof item === 'string') {
          return {
            task: item.trim(),
            assignee: 'Unassigned',
            assigneeReason: 'legacy format - no assignee information',
            deadline: null,
            deadlineText: null
          };
        } else {
          const processedItem = {
            task: item.task.trim(),
            assignee: item.assignee || 'Unassigned',
            assigneeReason: item.assigneeReason || 'no clear assignee mentioned',
            deadline: item.deadline || null,
            deadlineText: item.deadlineText || null
          };
          console.log('Processed item:', processedItem);
          return processedItem;
        }
      });
      
      console.log('Successfully extracted action items with assignments:', actionItems);
      return actionItems;
      
    } catch (parseError) {
      console.error('Error parsing Gemini response:', parseError);
      console.error('Raw response:', geminiResponse);
      return [];
    }
  }

  extractActionItemsFallback(text) {
    console.log('Using fallback regex extraction');
    const actionItems = [];
    
    // Enhanced patterns for fallback
    const patterns = [
      /\bI\s+(?:will|'ll)\s+([^.!?]+[.!?])/gi,
      /\bI\s+(?:need\s+to|have\s+to)\s+([^.!?]+[.!?])/gi,
      /(?:action\s+item|todo):\s*([^.!?]+[.!?])/gi,
      /next\s+steps?:\s*([^.!?]+[.!?])/gi,
      /follow\s+up:\s*([^.!?]+[.!?])/gi,
      /\b(?:we\s+need\s+to|we\s+should)\s+([^.!?]+[.!?])/gi,
      /\b(?:please\s+)?(?:review|check|update|send|schedule|call|email)\s+([^.!?]+[.!?])/gi
    ];
    
    patterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => {
          const task = match.replace(pattern, '$1').trim();
          if (task.length > 5 && task.length < 300) {
            actionItems.push({
              task: task,
              assignee: 'Unassigned',
              assigneeReason: 'regex fallback - no attendee information available',
              deadline: null,
              deadlineText: null
            });
          }
        });
      }
    });
    
    // Remove duplicates
    const uniqueItems = actionItems.filter((item, index, self) => 
      index === self.findIndex(t => t.task === item.task)
    );
    
    console.log('Fallback extraction found items:', uniqueItems);
    return uniqueItems;
  }

  // Health check method
  async healthCheck() {
    try {
      const testPrompt = 'Extract action items from: "We need to review the budget and schedule a meeting."';
      const result = await this.model.generateContent(testPrompt);
      const response = await result.response;
      return {
        status: 'healthy',
        message: 'Gemini API is working correctly',
        responseLength: response.text().length
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error.message,
        error: error
      };
    }
  }
}

module.exports = GeminiHelper; 