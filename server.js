import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { openDatabase } from './src/database.js';
import { createReporter } from './src/ai/reporting.js';

const db = openDatabase(config.databasePath);
const reporter = createReporter({
  enabled: config.aiAnalysisEnabled,
  apiKey: config.openAiApiKey,
  model: config.openAiModel,
});
const app = createApp({ db, reporter });

app.listen(config.port, () => {
  console.log(`数字小英雄已启动：http://localhost:${config.port}`);
});
