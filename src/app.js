import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z, ZodError } from 'zod';
import {
  LEARNING_CONSTANTS,
  PRESENTATION_TYPES,
  SKILLS,
  adjustDifficulty,
  calculateMastery,
  calculateReward,
  createQuestion,
  evaluateAnswer,
  toPublicQuestion,
} from './domain/index.js';
import { createSession, clearSessionCookie, playerDto, requirePlayer, setSessionCookie } from './auth.js';
import { errorResponse, requestContext } from './http.js';
import { aggregateLearningWindow, createReporter, createRuleReport, renderParentAdvice } from './ai/reporting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillNames = Object.values(SKILLS);
const avatarIds = new Set(['🦊', '🐼', '🐯', '🦄', 'hero_01', 'hero_02', 'hero_03', 'hero_04']);
const playerSchema = z.object({
  clientRequestId: z.string().min(1).max(100),
  nickname: z.string().trim().min(1).max(12).optional().nullable(),
  avatarId: z.string().min(1).max(32),
});
const runSchema = z.object({
  clientRequestId: z.string().min(1).max(100),
  mapId: z.literal('taoyuan'),
  level: z.union([z.number().int().min(1).max(5), z.string().regex(/^taoyuan_0?[1-5]$/)]).optional(),
  levelId: z.string().regex(/^taoyuan_0?[1-5]$/).optional(),
});
const answerSchema = z.object({
  responseId: z.string().min(1).max(100),
  selectedOptionId: z.union([z.string(), z.number()]).optional(),
  choice: z.union([z.string(), z.number()]).optional(),
  clientElapsedMs: z.number().int().min(0).max(300_000).default(0),
}).refine((value) => value.selectedOptionId !== undefined || value.choice !== undefined, { message: '请选择一个答案。' });

function parseJson(value) {
  return JSON.parse(value);
}

function publicIssuedQuestion(attempt) {
  const question = parseJson(attempt.question_snapshot_json);
  const publicQuestion = toPublicQuestion(question);
  return {
    attemptId: attempt.id,
    question: {
      ...publicQuestion,
      a: publicQuestion.operands.left,
      b: publicQuestion.operands.right,
      operator: publicQuestion.operation === 'subtraction' ? '-' : '+',
      story: publicQuestion.prompt,
      options: publicQuestion.options.map((option) => option.value),
    },
    position: attempt.sequence_no,
    targetQuestionCount: 5,
  };
}

function hintFor(question) {
  if (question.operation === 'subtraction') return '先摆出前面的数量，再慢慢拿走后面的数量，数一数还剩多少。';
  if (question.operation === 'successor') return '在这个数字后面再数一个，就是答案。';
  return '把两边的数量放在一起，慢慢从一开始数一数。';
}

export function skillForLevel(levelId) {
  const level = Number(String(levelId).match(/(\d)$/)?.[1] ?? 1);
  return [
    SKILLS.NUMBER_BASICS,
    SKILLS.ADDITION_WITHIN_10,
    SKILLS.SUBTRACTION_WITHIN_10,
    SKILLS.ADDITION_WITHIN_20_NO_CARRY,
    SKILLS.SUBTRACTION_WITHIN_20_NO_BORROW,
  ][level - 1] ?? SKILLS.NUMBER_BASICS;
}

function buildSkillUpdate(db, playerId, skillName) {
  const attempts = db.prepare(`
    SELECT qa.first_attempt_correct, qa.hint_used, qa.assisted, ae.client_elapsed_ms
    FROM question_attempts qa
    LEFT JOIN answer_events ae ON ae.attempt_id = qa.id
    WHERE qa.player_id = ? AND qa.skill_name = ? AND qa.status = 'ANSWERED'
    GROUP BY qa.id
    ORDER BY qa.answered_at ASC
  `).all(playerId, skillName).map((row) => ({
    isCorrect: Boolean(row.first_attempt_correct),
    usedHint: Boolean(row.hint_used),
    assisted: Boolean(row.assisted),
    responseTimeSeconds: row.client_elapsed_ms / 1000,
  }));
  const current = db.prepare('SELECT * FROM player_skills WHERE player_id = ? AND skill_name = ?').get(playerId, skillName);
  const mastery = calculateMastery(attempts);
  const difficulty = adjustDifficulty({
    currentTier: current.current_tier,
    attempts,
    expectedSeconds: LEARNING_CONSTANTS.EXPECTED_SECONDS_BY_TIER[current.current_tier],
  });
  db.prepare(`
    UPDATE player_skills
    SET mastery_score = ?, current_tier = ?, attempt_count = ?,
        correct_count = ?, hint_count = ?, updated_at = ?
    WHERE player_id = ? AND skill_name = ?
  `).run(
    mastery.score,
    difficulty.tier,
    attempts.length,
    attempts.filter((attempt) => attempt.isCorrect).length,
    attempts.filter((attempt) => attempt.usedHint).length,
    Date.now(),
    playerId,
    skillName,
  );
  return { masteryScore: mastery.score, difficultyTier: difficulty.tier, dataReady: mastery.isReady };
}

function collectReportSummaries(db, playerId) {
  const rows = db.prepare(`
    SELECT qa.skill_name, qa.first_attempt_correct, qa.hint_used, MIN(ae.client_elapsed_ms) AS client_elapsed_ms
    FROM question_attempts qa
    LEFT JOIN answer_events ae ON ae.attempt_id = qa.id
    WHERE qa.player_id = ? AND qa.status = 'ANSWERED'
    GROUP BY qa.id
    ORDER BY qa.answered_at DESC
    LIMIT 25
  `).all(playerId);
  return aggregateLearningWindow(rows.map((row) => ({
    skillName: row.skill_name,
    firstAttemptCorrect: Boolean(row.first_attempt_correct),
    hintUsed: Boolean(row.hint_used),
    clientElapsedMs: row.client_elapsed_ms,
  })));
}

function createCheckpointReport(db, playerId, checkpointNo) {
  const summaries = collectReportSummaries(db, playerId);
  const report = createRuleReport(summaries);
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO ai_reports(id, player_id, checkpoint_no, source, report_json, created_at, updated_at)
    VALUES (?, ?, ?, 'rules', ?, ?, ?)
  `).run(randomUUID(), playerId, checkpointNo, JSON.stringify(report), now, now);
  db.prepare(`
    INSERT OR IGNORE INTO ai_jobs(id, player_id, checkpoint_no, status, attempts, input_summary_json, created_at, updated_at)
    VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?)
  `).run(randomUUID(), playerId, checkpointNo, JSON.stringify(summaries), now, now);
  return { report, summaries };
}

async function enrichReport(db, reporter, playerId, checkpointNo, summaries) {
  const result = await reporter.analyze(summaries);
  const now = Date.now();
  if (result.source === 'ai') {
    db.prepare(`
      UPDATE ai_reports
      SET source = 'ai', report_json = ?, updated_at = ?
      WHERE player_id = ? AND checkpoint_no = ?
    `).run(JSON.stringify(result.report), now, playerId, checkpointNo);
    db.prepare(`
      UPDATE ai_jobs SET status = 'SUCCEEDED', attempts = attempts + 1, updated_at = ?
      WHERE player_id = ? AND checkpoint_no = ?
    `).run(now, playerId, checkpointNo);
  } else {
    db.prepare(`
      UPDATE ai_jobs SET status = 'FAILED', attempts = attempts + 1, last_error_code = 'RULE_FALLBACK', updated_at = ?
      WHERE player_id = ? AND checkpoint_no = ?
    `).run(now, playerId, checkpointNo);
  }
}

export function createApp({ db, reporter = createReporter() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(requestContext);

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', (_req, res) => {
    db.prepare('SELECT 1').get();
    return res.json({ status: 'ready' });
  });

  app.post('/api/v1/players', (req, res) => {
    const input = playerSchema.parse(req.body);
    if (!avatarIds.has(input.avatarId)) return errorResponse(res, req.requestId, 422, 'INVALID_AVATAR', '请选择预设的小英雄外观。');
    const existing = db.prepare('SELECT * FROM players WHERE client_request_id = ?').get(input.clientRequestId);
    let player = existing;
    if (!player) {
      const now = Date.now();
      player = { id: randomUUID(), client_request_id: input.clientRequestId, nickname: input.nickname ?? null, avatar_id: input.avatarId, level: 1, exp: 0, gold: 0, completed_run_count: 0, created_at: now, updated_at: now };
      const create = db.transaction(() => {
        db.prepare(`
          INSERT INTO players(id, client_request_id, nickname, avatar_id, level, exp, gold, completed_run_count, created_at, updated_at)
          VALUES (@id, @client_request_id, @nickname, @avatar_id, @level, @exp, @gold, @completed_run_count, @created_at, @updated_at)
        `).run(player);
        const insertSkill = db.prepare(`
          INSERT INTO player_skills(player_id, skill_name, updated_at) VALUES (?, ?, ?)
        `);
        skillNames.forEach((skill) => insertSkill.run(player.id, skill, now));
      });
      create();
    }
    const session = createSession(db, player.id);
    setSessionCookie(res, session.token, session.expiresAt);
    return res.status(existing ? 200 : 201).json({ player: playerDto(player) });
  });

  app.get('/api/v1/me', requirePlayer(db, errorResponse), (req, res) => res.json({ player: playerDto(req.player) }));

  app.get('/api/v1/me/progress', requirePlayer(db, errorResponse), (req, res) => {
    const skills = db.prepare('SELECT skill_name, mastery_score, current_tier, attempt_count FROM player_skills WHERE player_id = ?').all(req.player.id)
      .map((row) => ({ skillName: row.skill_name, masteryScore: row.mastery_score, difficultyTier: row.current_tier, attempts: row.attempt_count }));
    return res.json({ player: playerDto(req.player), map: { id: 'taoyuan', unlockedLevel: Math.min(5, req.player.completed_run_count + 1) }, skills });
  });

  app.delete('/api/v1/me', requirePlayer(db, errorResponse), (req, res) => {
    db.prepare('DELETE FROM players WHERE id = ?').run(req.player.id);
    clearSessionCookie(res);
    return res.status(204).end();
  });

  app.post('/api/v1/runs', requirePlayer(db, errorResponse), (req, res) => {
    const input = runSchema.parse(req.body);
    const existing = db.prepare('SELECT * FROM game_runs WHERE player_id = ? AND client_request_id = ?').get(req.player.id, input.clientRequestId);
    if (existing) return res.json({ runId: existing.id, run: { id: existing.id, status: existing.status, targetQuestionCount: existing.target_question_count } });
    const requestedLevel = typeof input.level === 'number' ? input.level : Number((input.levelId ?? input.level ?? 'taoyuan_01').match(/(\d)$/)?.[1] ?? 1);
    if (requestedLevel > Math.min(5, req.player.completed_run_count + 1)) {
      return errorResponse(res, req.requestId, 403, 'LEVEL_LOCKED', '先完成前一关，再继续冒险吧。');
    }
    const now = Date.now();
    const run = { id: randomUUID(), playerId: req.player.id, clientRequestId: input.clientRequestId, mapId: input.mapId, levelId: `taoyuan_0${requestedLevel}`, sequenceNo: req.player.completed_run_count + 1, now };
    db.prepare(`
      INSERT INTO game_runs(id, player_id, client_request_id, map_id, level_id, sequence_no, started_at)
      VALUES (@id, @playerId, @clientRequestId, @mapId, @levelId, @sequenceNo, @now)
    `).run(run);
    return res.status(201).json({ runId: run.id, run: { id: run.id, levelId: run.levelId, targetQuestionCount: 5, status: 'ACTIVE' } });
  });

  app.post('/api/v1/runs/:runId/questions/next', requirePlayer(db, errorResponse), (req, res) => {
    const run = db.prepare('SELECT * FROM game_runs WHERE id = ? AND player_id = ?').get(req.params.runId, req.player.id);
    if (!run) return errorResponse(res, req.requestId, 404, 'RUN_NOT_FOUND', '没有找到这个关卡。');
    if (run.status !== 'ACTIVE') return errorResponse(res, req.requestId, 409, 'RUN_FINISHED', '这个关卡已经结束。');
    const issued = db.prepare("SELECT * FROM question_attempts WHERE run_id = ? AND status = 'ISSUED'").get(run.id);
    if (issued) return res.json(publicIssuedQuestion(issued));
    if (run.answered_count >= run.target_question_count) return errorResponse(res, req.requestId, 409, 'RUN_READY_TO_FINISH', '本关题目已完成，请结算奖励。');

    const skillName = skillForLevel(run.level_id);
    const skill = db.prepare('SELECT * FROM player_skills WHERE player_id = ? AND skill_name = ?').get(req.player.id, skillName);
    const history = db.prepare('SELECT question_snapshot_json FROM question_attempts WHERE run_id = ?').all(run.id)
      .map((row) => parseJson(row.question_snapshot_json).signature);
    const presentationTypes = Object.values(PRESENTATION_TYPES);
    const question = createQuestion({
      skill: skillName,
      tier: skill.current_tier,
      presentationType: presentationTypes[run.answered_count % presentationTypes.length],
      excludedSignatures: history,
    });
    const attempt = { id: randomUUID(), runId: run.id, playerId: req.player.id, question, skillName, tier: skill.current_tier, sequenceNo: run.answered_count + 1, now: Date.now() };
    db.prepare(`
      INSERT INTO question_attempts(id, run_id, player_id, question_snapshot_json, skill_name, difficulty_tier, sequence_no, issued_at)
      VALUES (@id, @runId, @playerId, @question, @skillName, @tier, @sequenceNo, @now)
    `).run({ ...attempt, question: JSON.stringify(question) });
    return res.status(201).json(publicIssuedQuestion({ id: attempt.id, question_snapshot_json: JSON.stringify(question), sequence_no: attempt.sequenceNo }));
  });

  app.post('/api/v1/attempts/:attemptId/hint', requirePlayer(db, errorResponse), (req, res) => {
    const attempt = db.prepare('SELECT * FROM question_attempts WHERE id = ? AND player_id = ?').get(req.params.attemptId, req.player.id);
    if (!attempt) return errorResponse(res, req.requestId, 404, 'ATTEMPT_NOT_FOUND', '没有找到这道题。');
    db.prepare('UPDATE question_attempts SET hint_used = 1 WHERE id = ?').run(attempt.id);
    return res.json({ hint: hintFor(parseJson(attempt.question_snapshot_json)) });
  });

  app.post('/api/v1/attempts/:attemptId/answers', requirePlayer(db, errorResponse), (req, res) => {
    const input = answerSchema.parse(req.body);
    const existingEvent = db.prepare('SELECT result_json FROM answer_events WHERE id = ?').get(input.responseId);
    if (existingEvent) return res.json(parseJson(existingEvent.result_json));
    const attempt = db.prepare('SELECT * FROM question_attempts WHERE id = ? AND player_id = ?').get(req.params.attemptId, req.player.id);
    if (!attempt) return errorResponse(res, req.requestId, 404, 'ATTEMPT_NOT_FOUND', '没有找到这道题。');
    if (attempt.status !== 'ISSUED') return errorResponse(res, req.requestId, 409, 'ANSWER_ALREADY_SUBMITTED', '这道题已经完成了。');
    const question = parseJson(attempt.question_snapshot_json);
    const selected = input.selectedOptionId ?? input.choice;
    const option = question.options.find((candidate) => String(candidate.id) === String(selected) || Number(candidate.value) === Number(selected));
    if (!option) return errorResponse(res, req.requestId, 422, 'INVALID_OPTION', '请选择题目中的答案。');
    const evaluation = evaluateAnswer(question, option.id);
    const isFirst = attempt.response_count === 0;
    const isFinal = evaluation.isCorrect || !isFirst;
    const now = Date.now();
    const reward = calculateReward({ isCorrect: evaluation.isCorrect });
    const transaction = db.transaction(() => {
      let runProgress;
      if (isFinal) {
        db.prepare(`
          UPDATE question_attempts
          SET status = 'ANSWERED', response_count = response_count + 1, first_attempt_correct = ?,
              assisted = ?, answered_at = ?
          WHERE id = ?
        `).run(isFirst && evaluation.isCorrect ? 1 : 0, evaluation.isCorrect ? 0 : 1, now, attempt.id);
        db.prepare('UPDATE game_runs SET answered_count = answered_count + 1, correct_count = correct_count + ? WHERE id = ?')
          .run(isFirst && evaluation.isCorrect ? 1 : 0, attempt.run_id);
      } else {
        db.prepare('UPDATE question_attempts SET response_count = response_count + 1, hint_used = 1 WHERE id = ?').run(attempt.id);
      }
      if (reward.experience > 0) {
        db.prepare('UPDATE players SET exp = exp + ?, gold = gold + ?, updated_at = ? WHERE id = ?')
          .run(reward.experience, reward.coins, now, req.player.id);
      }
      const updatedRun = db.prepare('SELECT answered_count, target_question_count FROM game_runs WHERE id = ?').get(attempt.run_id);
      runProgress = { answered: updatedRun.answered_count, target: updatedRun.target_question_count };
      const result = {
        correct: evaluation.isCorrect,
        isCorrect: evaluation.isCorrect,
        state: evaluation.isCorrect ? 'CORRECT' : isFinal ? 'GUIDED' : 'RETRY',
        ...(isFinal ? { correctOptionId: evaluation.correctOptionId, explanation: evaluation.isCorrect ? '答对啦！' : `我们一起完成这道题，答案是 ${evaluation.correctValue}。` } : {}),
        combat: { damage: evaluation.isCorrect ? 1 : 0 },
        runProgress,
      };
      db.prepare(`
        INSERT INTO answer_events(id, attempt_id, selected_option_id, client_elapsed_ms, correct, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.responseId, attempt.id, option.id, input.clientElapsedMs, evaluation.isCorrect ? 1 : 0, JSON.stringify(result), now);
      if (isFinal) result.skillUpdate = buildSkillUpdate(db, req.player.id, attempt.skill_name);
      return result;
    });
    return res.json(transaction());
  });

  app.post('/api/v1/runs/:runId/finish', requirePlayer(db, errorResponse), (req, res) => {
    const run = db.prepare('SELECT * FROM game_runs WHERE id = ? AND player_id = ?').get(req.params.runId, req.player.id);
    if (!run) return errorResponse(res, req.requestId, 404, 'RUN_NOT_FOUND', '没有找到这个关卡。');
    if (run.status === 'COMPLETED') {
      const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.player.id);
      return res.json({ runId: run.id, rewards: { exp: run.reward_exp, coins: run.reward_gold }, player: playerDto(player), replayed: true });
    }
    if (run.answered_count < run.target_question_count) return errorResponse(res, req.requestId, 409, 'RUN_INCOMPLETE', '完成 5 道题后才能领取奖励。');
    const now = Date.now();
    const completionReward = calculateReward({ completedRun: true });
    const result = db.transaction(() => {
      const current = db.prepare('SELECT * FROM players WHERE id = ?').get(req.player.id);
      let exp = current.exp + completionReward.experience;
      let level = current.level;
      while (exp >= level * 100) { exp -= level * 100; level += 1; }
      db.prepare(`
        UPDATE players SET exp = ?, gold = gold + ?, level = ?, completed_run_count = completed_run_count + 1, updated_at = ? WHERE id = ?
      `).run(exp, completionReward.coins, level, now, req.player.id);
      db.prepare(`
        UPDATE game_runs SET status = 'COMPLETED', reward_exp = ?, reward_gold = ?, completed_at = ? WHERE id = ?
      `).run(completionReward.experience, completionReward.coins, now, run.id);
      const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.player.id);
      let checkpoint = null;
      if (player.completed_run_count % 5 === 0) {
        const created = createCheckpointReport(db, player.id, player.completed_run_count / 5);
        checkpoint = { number: player.completed_run_count / 5, ...created };
      }
      return {
        runId: run.id,
        rewards: { exp: completionReward.experience, coins: completionReward.coins },
        player: playerDto(player),
        report: checkpoint ? { source: 'rules', ...checkpoint.report } : undefined,
        checkpoint,
      };
    })();
    if (result.checkpoint) {
      queueMicrotask(() => enrichReport(db, reporter, req.player.id, result.checkpoint.number, result.checkpoint.summaries)
        .catch((error) => console.error('Unable to enrich learning report', error)));
    }
    delete result.checkpoint;
    return res.json(result);
  });

  app.get('/api/v1/reports/latest', requirePlayer(db, errorResponse), (req, res) => {
    const stored = db.prepare('SELECT * FROM ai_reports WHERE player_id = ? ORDER BY checkpoint_no DESC LIMIT 1').get(req.player.id);
    if (!stored) return errorResponse(res, req.requestId, 404, 'REPORT_NOT_FOUND', '完成 5 个小关卡后就能看到学习报告。');
    const report = parseJson(stored.report_json);
    return res.json({ id: stored.id, source: stored.source, report, parentAdvice: renderParentAdvice(report.parentAdviceCodes) });
  });

  app.use('/api/v1', (req, res) => errorResponse(res, req.requestId, 404, 'NOT_FOUND', '没有找到这个服务。'));
  app.use(express.static(path.resolve(__dirname, '../public')));
  app.get('*splat', (_req, res) => res.sendFile(path.resolve(__dirname, '../public/index.html')));
  app.use((error, req, res, _next) => {
    if (error instanceof ZodError) return errorResponse(res, req.requestId, 422, 'INVALID_INPUT', error.issues[0]?.message ?? '提交内容不正确。');
    console.error(`[${req.requestId}]`, error);
    return errorResponse(res, req.requestId, 500, 'INTERNAL_ERROR', '小英雄的背包整理中，请稍后再试。', true);
  });
  return app;
}
