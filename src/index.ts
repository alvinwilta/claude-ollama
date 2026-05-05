#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import 'dotenv/config';

function getDefaultModelText(): string {
  return process.env.OLLAMA_DEFAULT_MODEL_TEXT || process.env.OLLAMA_DEFAULT_MODEL || 'gpt-oss';
}

function getDefaultModelChat(): string {
  return process.env.OLLAMA_DEFAULT_MODEL_CHAT || process.env.OLLAMA_DEFAULT_MODEL || 'gpt-oss';
}

function getDefaultModelCode(): string {
  return process.env.OLLAMA_DEFAULT_MODEL_CODE || process.env.OLLAMA_DEFAULT_MODEL || 'gpt-oss';
}

function getDefaultModelSummarise(): string {
  return process.env.OLLAMA_DEFAULT_MODEL_SUMMARISE || process.env.OLLAMA_DEFAULT_MODEL || 'gpt-oss';
}

function getDefaultModelEmbed(): string {
  // Embeddings often require a dedicated embedding model; do not fall back to the global text model.
  return process.env.OLLAMA_DEFAULT_MODEL_EMBED || 'nomic-embed-text';
}

// Define Tool interface inline since it might not be exported
interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

interface OllamaModel {
  name: string;
  capabilities: string[];
  description: string;
}

interface OllamaConfig {
  baseUrl: string;
  timeout: number;
  models: OllamaModel[];
}

class OllamaClient {
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  private async requestJson<TResponse>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {}
  ): Promise<TResponse> {
    const url = new URL(path, this.config.baseUrl).toString();

    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? this.config.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
      }

      return (await res.json()) as TResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const data = await this.requestJson<{ models?: { name: string }[] }>('/api/tags', {
        method: 'GET',
      });
      return data.models?.map((model) => model.name) || [];
    } catch (error) {
      console.error('Failed to list Ollama models:', error);
      return [];
    }
  }

  async generateText(model: string, prompt: string, options: any = {}): Promise<string> {
    try {
      const data = await this.requestJson<{ response?: string }>('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: {
            temperature: options.temperature || 0.7,
            top_p: options.top_p || 0.9,
            top_k: options.top_k || 40,
            ...options,
          },
        }),
      });

      return data.response || '';
    } catch (error) {
      throw new Error(`Ollama generation failed: ${error}`);
    }
  }

  async chatCompletion(model: string, messages: any[], options: any = {}): Promise<string> {
    try {
      const data = await this.requestJson<{ message?: { content?: string } }>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: options.temperature || 0.7,
            top_p: options.top_p || 0.9,
            ...options,
          },
        }),
      });

      return data.message?.content || '';
    } catch (error) {
      throw new Error(`Ollama chat completion failed: ${error}`);
    }
  }

  async generateEmbedding(model: string, text: string): Promise<number[]> {
    try {
      const data = await this.requestJson<{ embedding?: number[] }>('/api/embeddings', {
        method: 'POST',
        body: JSON.stringify({
          model,
          prompt: text,
        }),
      });

      return data.embedding || [];
    } catch (error) {
      throw new Error(`Ollama embedding generation failed: ${error}`);
    }
  }

  async pullModel(model: string): Promise<boolean> {
    try {
      await this.requestJson('/api/pull', {
        method: 'POST',
        body: JSON.stringify({
          name: model,
          stream: false,
        }),
      });
      return true;
    } catch (error) {
      console.error(`Failed to pull model ${model}:`, error);
      return false;
    }
  }
}

class MCPOllamaServer {
  private server: McpServer;
  private ollama: OllamaClient;
  private availableModels: string[] = [];

  constructor() {
    // Default configuration - modify as needed
    const config: OllamaConfig = {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      timeout: Number.parseInt(process.env.OLLAMA_TIMEOUT || '300000', 10) || 300000, // 5 minutes for large models
      models: [
        {
          name: 'gpt-oss',
          capabilities: ['coding', 'text-generation', 'chat', 'reasoning'],
          description: 'General purpose text generation and reasoning',
        },
        {
          name: 'llama3.2',
          capabilities: ['text-generation', 'chat', 'reasoning'],
          description: 'General purpose text generation and reasoning',
        },
        {
          name: 'qwen2.5',
          capabilities: ['text-generation', 'chat', 'coding'],
          description: 'High-quality text generation with strong coding abilities',
        },
        {
          name: 'deepseek-coder',
          capabilities: ['coding', 'text-generation'],
          description: 'Specialised code generation and programming assistance',
        },
        {
          name: 'nomic-embed-text',
          capabilities: ['embeddings'],
          description: 'Text embedding generation for semantic similarity',
        },
      ],
    };

    this.ollama = new OllamaClient(config);
    this.server = new McpServer(
      {
        name: 'claude-ollama',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const defaultModelText = getDefaultModelText();
      const defaultModelChat = getDefaultModelChat();
      const defaultModelCode = getDefaultModelCode();
      const defaultModelSummarise = getDefaultModelSummarise();
      const defaultModelEmbed = getDefaultModelEmbed();
      const tools: Tool[] = [
        {
          name: 'ollama_generate_text',
          description: 'Generate text using local Ollama for SIMPLE, token-efficient tasks like basic content, error messages, placeholder text, boilerplate code, or routine documentation. Use instead of Claude for non-analytical text generation. AVOID for complex reasoning, analysis, or creative writing that requires nuanced understanding.',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Ollama model name (e.g., gpt-oss, llama3.2, qwen2.5)',
                default: defaultModelText,
              },
              prompt: {
                type: 'string',
                description: 'Text prompt for generation',
              },
              temperature: {
                type: 'number',
                description: 'Sampling temperature (0.0-2.0)',
                default: 0.7,
              },
              max_tokens: {
                type: 'number',
                description: 'Maximum tokens to generate',
                default: 2048,
              },
            },
            required: ['prompt'],
          },
        },
        {
          name: 'ollama_chat',
          description: 'Have a conversation with local Ollama for SIMPLE Q&A, factual questions, or basic explanations that don\'t require deep reasoning. Prefer for routine queries to save Claude tokens. AVOID for complex analysis, nuanced discussions, or tasks requiring sophisticated reasoning.',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Ollama model name',
                default: defaultModelChat,
              },
              messages: {
                type: 'array',
                description: 'Array of chat messages with role and content',
                items: {
                  type: 'object',
                  properties: {
                    role: {
                      type: 'string',
                      enum: ['system', 'user', 'assistant'],
                    },
                    content: {
                      type: 'string',
                    },
                  },
                  required: ['role', 'content'],
                },
              },
              temperature: {
                type: 'number',
                default: 0.7,
              },
            },
            required: ['messages'],
          },
        },
        {
          name: 'ollama_embed_text',
          description: 'Generate text embeddings using local embedding models like nomic-embed-text. Ideal for batch embedding tasks, semantic search, similarity comparisons, and clustering. Use this for routine embedding generation to save Claude tokens.',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Embedding model name',
                default: defaultModelEmbed,
              },
              text: {
                type: 'string',
                description: 'Text to embed',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'ollama_code_generation',
          description: 'Generate SIMPLE code like getters/setters, basic CRUD operations, validation rules, boilerplate code, or routine functions. Use for mechanical coding tasks that follow established patterns. AVOID for architectural decisions, complex business logic, or code requiring sophisticated design patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Coding model name',
                default: defaultModelCode,
              },
              task: {
                type: 'string',
                description: 'Coding task description',
              },
              language: {
                type: 'string',
                description: 'Programming language',
                default: 'python',
              },
              temperature: {
                type: 'number',
                default: 0.2,
              },
            },
            required: ['task'],
          },
        },
        {
          name: 'ollama_summarise',
          description: 'Create BRIEF summaries for logs, documentation, or simple content. Use for factual condensation and routine document processing that doesn\'t require deep analysis or insight. Ideal for batch summarization tasks to save Claude tokens. AVOID for content requiring interpretation or analytical summarization.',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                default: defaultModelSummarise,
              },
              text: {
                type: 'string',
                description: 'Text to summarise',
              },
              length: {
                type: 'string',
                enum: ['brief', 'medium', 'detailed'],
                default: 'medium',
                description: 'Summary length preference',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'ollama_list_models',
          description: 'List all available Ollama models on the local system',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'ollama_pull_model',
          description: 'Download and install a new model to Ollama',
          inputSchema: {
            type: 'object',
            properties: {
              model: {
                type: 'string',
                description: 'Model name to pull (e.g., gpt-oss, llama3.2, qwen2.5:14b)',
              },
            },
            required: ['model'],
          },
        },
      ];

      return { tools };
    });

    this.server.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'ollama_generate_text':
            return await this.handleTextGeneration(args);

          case 'ollama_chat':
            return await this.handleChatCompletion(args);

          case 'ollama_embed_text':
            return await this.handleEmbedding(args);

          case 'ollama_code_generation':
            return await this.handleCodeGeneration(args);

          case 'ollama_summarise':
            return await this.handleSummarisation(args);

          case 'ollama_list_models':
            return await this.handleListModels();

          case 'ollama_pull_model':
            return await this.handlePullModel(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleTextGeneration(args: any) {
    const { model = getDefaultModelText(), prompt, temperature = 0.7, max_tokens = 2048 } = args;

    const enhancedPrompt = `${prompt}\n\nPlease provide a clear, concise response.`;
    const response = await this.ollama.generateText(model, enhancedPrompt, {
      temperature,
      num_predict: max_tokens,
    });

    return {
      content: [
        {
          type: 'text',
          text: `**Model:** ${model}\n**Generated Text:**\n\n${response}`,
        },
      ],
    };
  }

  private async handleChatCompletion(args: any) {
    const { model = getDefaultModelChat(), messages, temperature = 0.7 } = args;

    const response = await this.ollama.chatCompletion(model, messages, {
      temperature,
    });

    return {
      content: [
        {
          type: 'text',
          text: `**Model:** ${model}\n**Response:**\n\n${response}`,
        },
      ],
    };
  }

  private async handleEmbedding(args: any) {
    const { model = getDefaultModelEmbed(), text } = args;

    const embedding = await this.ollama.generateEmbedding(model, text);

    return {
      content: [
        {
          type: 'text',
          text: `**Model:** ${model}\n**Text:** ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}\n**Embedding Vector:** [${embedding.length} dimensions]\n**Sample Values:** [${embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`,
        },
      ],
    };
  }

  private async handleCodeGeneration(args: any) {
    const { model = getDefaultModelCode(), task, language = 'python', temperature = 0.2 } = args;

    const prompt = `Generate ${language} code for the following task:\n\n${task}\n\nProvide clean, modern code that follows best practices:`;

    const response = await this.ollama.generateText(model, prompt, {
      temperature,
      num_predict: 2048,
    });

    return {
      content: [
        {
          type: 'text',
          text: `**Model:** ${model}\n**Language:** ${language}\n**Task:** ${task}\n\n**Generated Code:**\n\n\`\`\`${language}\n${response}\n\`\`\``,
        },
      ],
    };
  }

  private async handleSummarisation(args: any) {
    const { model = getDefaultModelSummarise(), text, length = 'medium' } = args;

    const lengthInstructions = {
      brief: 'Provide a very brief summary in 1-2 sentences.',
      medium: 'Provide a concise summary in 2-4 sentences.',
      detailed: 'Provide a detailed summary covering all key points.',
    };

    const prompt = `Please summarise the following text. ${lengthInstructions[length as keyof typeof lengthInstructions]}\n\nText to summarise:\n${text}\n\nSummary:`;

    const response = await this.ollama.generateText(model, prompt, {
      temperature: 0.3,
    });

    return {
      content: [
        {
          type: 'text',
          text: `**Model:** ${model}\n**Length:** ${length}\n**Original Length:** ${text.length} characters\n\n**Summary:**\n\n${response}`,
        },
      ],
    };
  }

  private async handleListModels() {
    try {
      const models = await this.ollama.listModels();
      this.availableModels = models;

      return {
        content: [
          {
            type: 'text',
            text: `**Available Ollama Models:**\n\n${models.length > 0 ? models.map(model => `• ${model}`).join('\n') : 'No models found. Try pulling a model first.'}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to list models: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handlePullModel(args: any) {
    const { model } = args;

    try {
      const success = await this.ollama.pullModel(model);

      if (success) {
        return {
          content: [
            {
              type: 'text',
              text: `Successfully pulled model: ${model}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to pull model: ${model}. Check if the model name is correct and Ollama is running.`,
            },
          ],
          isError: true,
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error pulling model ${model}: ${error}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run(): Promise<void> {
    // Test Ollama connection on startup
    try {
      await this.ollama.listModels();
      console.error('✅ Connected to Ollama successfully');
    } catch (error) {
      console.error('❌ Failed to connect to Ollama. Make sure Ollama is running on localhost:11434');
      console.error('   You can start Ollama with: ollama serve');
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('🚀 MCP Ollama Server running');
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error('\n👋 Shutting down MCP Ollama Server');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\n👋 Shutting down MCP Ollama Server');
  process.exit(0);
});

// Start the server
const server = new MCPOllamaServer();
server.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});