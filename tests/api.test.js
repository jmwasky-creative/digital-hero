import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, skillForLevel } from '../src/app.js';
import { openDatabase } from '../src/database.js';

function setup() {
  const db = openDatabase(':memory:');
  return { db, app: createApp({ db }) };
}

describe('game API vertical slice', () => {
  const resources = [];
  afterEach(() => resources.splice(0).forEach(({ db }) => db.close()));

  it('creates a player, serves five answer-safe questions, and rewards only once', async () => {
    const resource = setup(); resources.push(resource);
    const agent = request.agent(resource.app);
    const created = await agent.post('/api/v1/players').send({ clientRequestId: randomUUID(), nickname: '小勇士', avatarId: '🦊' }).expect(201);
    expect(created.body.player.level).toBe(1);
    const run = await agent.post('/api/v1/runs').send({ clientRequestId: randomUUID(), mapId: 'taoyuan', level: 1 }).expect(201);
    for (let index = 0; index < 5; index += 1) {
      const issued = await agent.post(`/api/v1/runs/${run.body.runId}/questions/next`).send({}).expect(201);
      expect(issued.body.question.answer).toBeUndefined();
      expect(issued.body.question.correctOptionId).toBeUndefined();
      const choice = issued.body.question.options[0];
      const first = await agent.post(`/api/v1/attempts/${issued.body.attemptId}/answers`).send({ responseId: randomUUID(), choice, clientElapsedMs: 1000 }).expect(200);
      if (!first.body.correct) {
        const retry = await agent.post(`/api/v1/attempts/${issued.body.attemptId}/answers`).send({ responseId: randomUUID(), choice: issued.body.question.options[1], clientElapsedMs: 1200 }).expect(200);
        expect(['CORRECT', 'GUIDED']).toContain(retry.body.state);
      }
    }
    const finished = await agent.post(`/api/v1/runs/${run.body.runId}/finish`).send({}).expect(200);
    const replay = await agent.post(`/api/v1/runs/${run.body.runId}/finish`).send({}).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.player.gold).toBe(finished.body.player.gold);
  });

  it('assigns a distinct learning focus to every 桃源村关卡', () => {
    expect([
      skillForLevel('taoyuan_01'),
      skillForLevel('taoyuan_02'),
      skillForLevel('taoyuan_03'),
      skillForLevel('taoyuan_04'),
      skillForLevel('taoyuan_05'),
    ]).toEqual([
      'number_basics',
      'addition_within_10',
      'subtraction_within_10',
      'addition_within_20_no_carry',
      'subtraction_within_20_no_borrow',
    ]);
  });
});
