import { OpenAIAdapter } from './adapters/openai';
import { AnthropicAdapter } from './adapters/anthropic';
import { LocalAIAdapter } from './adapters/local';
import { NvidiaAdapter } from './adapters/nvidia';
import { registerAdapter, registerTask } from './registry';
import { ClassificationHandler } from './tasks/classification';
import { ExtractionHandler } from './tasks/extraction';
import { QAHandler } from './tasks/qa';
import { ReasoningHandler } from './tasks/reasoning';
import { run } from './pipeline';

// Register adapters
registerAdapter('openai', new OpenAIAdapter(process.env.OPENAI_API_KEY ?? ''));
registerAdapter('anthropic', new AnthropicAdapter(process.env.ANTHROPIC_API_KEY ?? ''));
registerAdapter('local', new LocalAIAdapter(process.env.LOCAL_AI_URL, process.env.LOCAL_AI_MODEL));
registerAdapter(
  'nvidia',
  new NvidiaAdapter(
    process.env.NVIDIA_API_KEY ?? '',
    process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
    process.env.NVIDIA_MODEL ?? 'meta/llama-3.1-8b-instruct',
  ),
);

// Register task handlers
registerTask('classification', new ClassificationHandler());
registerTask('extraction', new ExtractionHandler());
registerTask('qa', new QAHandler());
registerTask('reasoning', new ReasoningHandler());

export { run };
export type { AIInput, AIResult, AIAdapter, TaskHandler } from './types';
