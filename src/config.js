import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH ?? path.resolve('data/digital-hero.db'),
  aiAnalysisEnabled: process.env.AI_ANALYSIS_ENABLED === 'true',
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL ?? 'gpt-5.6',
};
