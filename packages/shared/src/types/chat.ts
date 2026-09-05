/**
 * Chat message types
 */

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
}

export interface ChatSession {
  id: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  userId?: string;
}

export interface ChatRequest {
  messages: Pick<Message, 'role' | 'content'>[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  response: string;
  tokensUsed?: number;
}

/**
 * VoidCode AI modes
 */
export type TutorMode = 'TEACHING' | 'DEBUG' | 'FOLLOWUP' | 'EXPLAIN';

export interface TutorModeConfig {
  mode: TutorMode;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}
