import type { TestSuiteConfig } from 'promptfoo';

const config: TestSuiteConfig = {
  description: 'WISP — skill prompt regression',
  prompts: ['file://./cases/*.yaml'],
  providers: [
    // Use Claude via Anthropic API for evals; assumes ANTHROPIC_API_KEY is set
    'anthropic:messages:claude-haiku-4-5-20251001',
  ],
  defaultTest: {
    options: {
      // LLM-as-judge grading is provided by promptfoo's defaults
    },
  },
};

export default config;
