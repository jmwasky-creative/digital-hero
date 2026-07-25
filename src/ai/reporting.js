import OpenAI from 'openai';
import { z } from 'zod';

const skillNameSchema = z.enum([
  'number_basic',
  'addition_10',
  'addition_20_no_carry',
  'addition_20_carry',
  'subtraction_10',
  'subtraction_20_no_borrow',
  'subtraction_20_borrow',
]);

export const analysisSchema = z.object({
  schemaVersion: z.literal(1),
  trend: z.enum(['improving', 'steady', 'needs_support']),
  weakSkills: z.array(z.object({
    skill: skillNameSchema,
    reasonCodes: z.array(z.enum(['LOW_ACCURACY', 'HIGH_HINT_RATE', 'SLOW_RESPONSE'])).min(1),
  })).max(3),
  weightAdjustments: z.array(z.object({
    skill: skillNameSchema,
    multiplier: z.number().min(0.8).max(1.2),
  })).max(3),
  parentAdviceCodes: z.array(z.enum([
    'PRACTICE_WITH_FRUIT',
    'PRACTICE_WITH_NUMBER_LINE',
    'CELEBRATE_PERSISTENCE',
    'TAKE_A_SHORT_BREAK',
  ])).max(3),
}).strict();

const adviceText = {
  PRACTICE_WITH_FRUIT: '可以用分水果或分积木的小游戏，和孩子一起练习“还剩多少”。',
  PRACTICE_WITH_NUMBER_LINE: '可以在纸上画一条数字线，让孩子边移动边说出加减过程。',
  CELEBRATE_PERSISTENCE: '孩子愿意继续尝试很棒，请多肯定努力和思考过程。',
  TAKE_A_SHORT_BREAK: '如果连续使用提示较多，可以先休息几分钟，再进行一小关练习。',
};

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function aggregateLearningWindow(records) {
  const skills = new Map();
  for (const record of records) {
    const summary = skills.get(record.skillName) ?? {
      skill: record.skillName,
      count: 0,
      correctCount: 0,
      hintCount: 0,
      responseTimesMs: [],
    };
    summary.count += 1;
    summary.correctCount += record.firstAttemptCorrect ? 1 : 0;
    summary.hintCount += record.hintUsed ? 1 : 0;
    if (Number.isFinite(record.clientElapsedMs)) summary.responseTimesMs.push(record.clientElapsedMs);
    skills.set(record.skillName, summary);
  }

  return [...skills.values()].map((summary) => ({
    skill: summary.skill,
    count: summary.count,
    accuracy: summary.count ? summary.correctCount / summary.count : 0,
    hintRate: summary.count ? summary.hintCount / summary.count : 0,
    medianResponseMs: median(summary.responseTimesMs),
  }));
}

export function createRuleReport(skillSummaries) {
  const weakSkills = skillSummaries
    .filter((summary) => summary.count >= 3 && (summary.accuracy < 0.7 || summary.hintRate > 0.4))
    .sort((a, b) => a.accuracy - b.accuracy || b.hintRate - a.hintRate)
    .slice(0, 3)
    .map((summary) => ({
      skill: summary.skill,
      reasonCodes: [
        ...(summary.accuracy < 0.7 ? ['LOW_ACCURACY'] : []),
        ...(summary.hintRate > 0.4 ? ['HIGH_HINT_RATE'] : []),
      ],
    }));

  const averageAccuracy = skillSummaries.length
    ? skillSummaries.reduce((total, summary) => total + summary.accuracy, 0) / skillSummaries.length
    : 0;
  const trend = averageAccuracy >= 0.85 ? 'improving' : averageAccuracy >= 0.7 ? 'steady' : 'needs_support';
  const parentAdviceCodes = weakSkills.length
    ? ['PRACTICE_WITH_FRUIT', 'CELEBRATE_PERSISTENCE']
    : ['CELEBRATE_PERSISTENCE'];

  return {
    schemaVersion: 1,
    trend,
    weakSkills,
    weightAdjustments: weakSkills.map(({ skill }) => ({ skill, multiplier: 1.15 })),
    parentAdviceCodes,
  };
}

export function renderParentAdvice(codes) {
  return codes.map((code) => adviceText[code]).filter(Boolean);
}

export function createReporter({ apiKey, model, enabled = false, timeoutMs = 12_000, client } = {}) {
  const openai = client ?? (apiKey && enabled ? new OpenAI({ apiKey, timeout: timeoutMs }) : null);

  return {
    async analyze(skillSummaries) {
      const fallback = createRuleReport(skillSummaries);
      if (!openai || !enabled) return { source: 'rules', report: fallback };

      try {
        const response = await openai.responses.create({
          model,
          store: false,
          input: [{
            role: 'system',
            content: '你只分析匿名、聚合的儿童数学练习数据。只返回符合给定 JSON Schema 的受控枚举，不生成自由文本，也不做医疗或心理判断。',
          }, {
            role: 'user',
            content: JSON.stringify({ skillSummaries }),
          }],
          text: {
            format: {
              type: 'json_schema',
              name: 'digital_hero_learning_report',
              strict: true,
              schema: z.toJSONSchema(analysisSchema),
            },
          },
        });
        const parsed = analysisSchema.parse(JSON.parse(response.output_text));
        return { source: 'ai', report: parsed };
      } catch {
        return { source: 'rules', report: fallback };
      }
    },
  };
}
