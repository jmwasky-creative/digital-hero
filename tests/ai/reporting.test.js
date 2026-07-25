import { describe, expect, it } from 'vitest';
import {
  aggregateLearningWindow,
  createReporter,
  createRuleReport,
  renderParentAdvice,
} from '../../src/ai/reporting.js';

describe('learning reports', () => {
  it('aggregates only learning metrics and identifies weak skills', () => {
    const summaries = aggregateLearningWindow([
      { skillName: 'subtraction_10', firstAttemptCorrect: false, hintUsed: true, clientElapsedMs: 12_000 },
      { skillName: 'subtraction_10', firstAttemptCorrect: false, hintUsed: true, clientElapsedMs: 14_000 },
      { skillName: 'subtraction_10', firstAttemptCorrect: true, hintUsed: false, clientElapsedMs: 9_000 },
    ]);
    const report = createRuleReport(summaries);

    expect(report.weakSkills[0].skill).toBe('subtraction_10');
    expect(renderParentAdvice(report.parentAdviceCodes)[0]).toContain('水果');
  });

  it('falls back to deterministic rules when AI is disabled', async () => {
    const reporter = createReporter({ enabled: false });
    const result = await reporter.analyze([]);

    expect(result.source).toBe('rules');
    expect(result.report.schemaVersion).toBe(1);
  });
});
