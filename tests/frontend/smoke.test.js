import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = resolve(process.cwd(), 'public');

describe('game frontend shell', () => {
  it('ships a static entry point and a syntactically valid game module', () => {
    const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
    const app = readFileSync(resolve(publicDir, 'app.js'), 'utf8');

    expect(html).toContain('id="app"');
    expect(html).toContain('src="/app.js"');
    expect(() => new Function(app)).not.toThrow();
  });

  it('keeps the child-friendly battle safeguards in the shipped client', () => {
    const app = readFileSync(resolve(publicDir, 'app.js'), 'utf8');

    expect(app).toContain('fallbackQuestions');
    expect(app).toContain("game.attempts === 1");
    expect(app).toContain('我们一起完成');
    expect(app).toContain('speechSynthesis');
    expect(app).toContain('scheduleQuestionSpeech');
    expect(app).toContain('playFeedbackSound');
    expect(app).toContain('setTimeout(() => { if (game?.questions[game.index]?.id === question.id) speakQuestion(); }, 500)');
    expect(app).toContain("/api/v1");
  });
});
