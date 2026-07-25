/*
 * First playable technical slice: 5 blocks → add 3 → wind removes 2 → answer 6 → add 2.
 * QuantityModel is the numeric source of truth. CSS animations only visualize committed changes.
 */

const APP = document.querySelector('#app');
const MODULE_PATHS = {
  quantity: '/game/quantity-model.js?v=4',
  task: '/game/task-generator.js?v=4',
  audio: '/game/audio-manager.js?v=4',
  storage: '/game/storage.js?v=4'
};

class LocalQuantityModel {
  constructor(options = {}) { this.value = Number(typeof options === 'number' ? options : options.value) || 0; }
  add(amount) { this.value += Number(amount) || 0; return this.snapshot(); }
  remove(amount) { this.value = Math.max(0, this.value - (Number(amount) || 0)); return this.snapshot(); }
  snapshot() { return { value: this.value }; }
}

const LOCAL_TASK = Object.freeze({
  initialValue: 5,
  targetValue: 8,
  numberBlock: 3,
  dropCount: 2,
  restoreCount: 2,
  answerOptions: [5, 6, 7, 8]
});

const runtime = {
  QuantityModel: LocalQuantityModel,
  createTechnicalSliceTask: () => ({ ...LOCAL_TASK }),
  AudioManager: null,
  GameStorage: null,
  missingModules: [],
  audio: null,
  storage: null
};
let runtimeLoadPromise = Promise.resolve();
let eventWriteChain = Promise.resolve();
let syncInFlight = false;

const IDENTITY_KEYS = Object.freeze({
  deviceId: 'chick-number-blocks:device-id',
  profileId: 'chick-number-blocks:profile-id',
  clientSeq: 'chick-number-blocks:client-seq'
});

const state = {
  screen: 'welcome',
  task: null,
  model: null,
  phase: 'idle',
  expandedCount: 0,
  lastChange: null,
  feedback: '',
  feedbackTone: '',
  selectedAnswer: null,
  pendingDrop: false,
  fallingCount: 0,
  interactionLocked: false,
  audioUnlocked: false,
  scheduleId: 0,
  drag: null,
  lastPointerDrag: false
};

function sleep(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }
function safeNumber(value, fallback = 0) { const result = Number(value); return Number.isFinite(result) ? result : fallback; }
function currentValue() {
  const snapshot = typeof state.model?.snapshot === 'function' ? state.model.snapshot() : null;
  return safeNumber(state.model?.value ?? snapshot?.value, 0);
}
function normalizedTask(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const task = {
    initialValue: safeNumber(source.initialValue ?? source.initial ?? LOCAL_TASK.initialValue, LOCAL_TASK.initialValue),
    targetValue: safeNumber(source.targetValue ?? source.target ?? LOCAL_TASK.targetValue, LOCAL_TASK.targetValue),
    numberBlock: safeNumber(source.numberBlock ?? source.addBlock ?? LOCAL_TASK.numberBlock, LOCAL_TASK.numberBlock),
    dropCount: safeNumber(source.dropCount ?? source.windDrop ?? LOCAL_TASK.dropCount, LOCAL_TASK.dropCount),
    restoreCount: safeNumber(source.restoreCount ?? source.repairBlock ?? LOCAL_TASK.restoreCount, LOCAL_TASK.restoreCount),
    answerOptions: Array.isArray(source.answerOptions) ? source.answerOptions.map(option => safeNumber(option)).filter(Number.isFinite) : [...LOCAL_TASK.answerOptions]
  };
  const expectedAfterDrop = task.targetValue - task.dropCount;
  if (!task.answerOptions.includes(expectedAfterDrop)) task.answerOptions.push(expectedAfterDrop);
  return task;
}
function makeModel(initialValue) {
  try { return new runtime.QuantityModel({ value: initialValue }); }
  catch { try { return new runtime.QuantityModel(initialValue); } catch { return new LocalQuantityModel({ value: initialValue }); } }
}
function callModel(method, amount, meta) {
  if (!state.model || typeof state.model[method] !== 'function') throw new Error(`QuantityModel 缺少 ${method} 方法`);
  const before = currentValue();
  state.model[method](amount, meta);
  const after = currentValue();
  return { before, after };
}
function snapshotPayload() {
  return { phase: state.phase, value: currentValue(), task: state.task, completed: state.phase === 'done', savedAt: Date.now() };
}
function persist() {
  const payload = snapshotPayload();
  try { localStorage.setItem('chick-number-blocks-technical-slice', JSON.stringify(payload)); } catch {}
  const storage = runtime.storage;
  if (!storage) return;
  try {
    if (typeof storage.saveSnapshot === 'function') Promise.resolve(storage.saveSnapshot(payload)).catch(() => {});
  } catch { /* The local copy remains authoritative while optional storage is unavailable. */ }
}

function stableLocalId(key, prefix) {
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const identifier = globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(key, identifier);
    return identifier;
  } catch {
    return `${prefix}-temporary`;
  }
}

function nextClientSequence() {
  try {
    const previous = Number.parseInt(localStorage.getItem(IDENTITY_KEYS.clientSeq) || '0', 10);
    const next = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
    localStorage.setItem(IDENTITY_KEYS.clientSeq, String(next));
    return next;
  } catch {
    return Date.now();
  }
}

async function syncPendingEvents() {
  const storage = runtime.storage;
  if (
    syncInFlight ||
    !storage ||
    typeof storage.listPendingEvents !== 'function' ||
    typeof storage.markEventsSynced !== 'function' ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) return;

  syncInFlight = true;
  try {
    const events = await storage.listPendingEvents(50);
    if (!events.length) return;
    const response = await fetch('/api/v1/sync/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events })
    });
    if (!response.ok) return;
    const result = await response.json();
    const acceptedIds = [
      ...(Array.isArray(result.acceptedEventIds) ? result.acceptedEventIds : []),
      ...(Array.isArray(result.duplicateEventIds) ? result.duplicateEventIds : [])
    ];
    if (acceptedIds.length) await storage.markEventsSynced(acceptedIds);
  } catch {
    // Offline play remains fully usable. The pending Outbox is retried next time.
  } finally {
    syncInFlight = false;
  }
}

function appendEvent(type, detail = {}) {
  const now = Date.now();
  const event = {
    eventId: globalThis.crypto?.randomUUID?.() ?? `technical-slice-${Date.now()}-${Math.random()}`,
    profileId: stableLocalId(IDENTITY_KEYS.profileId, 'profile'),
    deviceId: stableLocalId(IDENTITY_KEYS.deviceId, 'device'),
    clientSeq: nextClientSequence(),
    eventType: String(type).toUpperCase(),
    schemaVersion: 1,
    rulesetVersion: '1.0.0',
    occurredAt: now,
    payload: {
      phase: state.phase,
      value: currentValue(),
      ...detail
    }
  };
  try {
    if (typeof runtime.storage?.appendEvent === 'function') {
      eventWriteChain = eventWriteChain
        .catch(() => {})
        .then(() => runtime.storage.appendEvent(event, snapshotPayload()))
        .then(() => syncPendingEvents())
        .catch(() => {});
    }
  } catch {}
}
function createAudioManager() {
  if (!runtime.AudioManager) return null;
  try { return new runtime.AudioManager(); } catch { return null; }
}
async function unlockAudio() {
  const audio = runtime.audio;
  try {
    if (typeof audio?.unlock === 'function') await audio.unlock();
    else if (typeof audio?.resume === 'function') await audio.resume();
  } catch {}
  state.audioUnlocked = true;
}
function stopSpeech() {
  try {
    if (typeof runtime.audio?.stopSpeech === 'function') runtime.audio.stopSpeech();
    else window.speechSynthesis?.cancel();
  } catch {}
}
function speak(text) {
  if (!text || !state.audioUnlocked) return;
  try {
    const audio = runtime.audio;
    if (typeof audio?.speak === 'function') { audio.speak(text); return; }
    if (typeof audio?.playVoice === 'function') { audio.playVoice(text); return; }
    if (!('speechSynthesis' in window)) return;
    stopSpeech();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = .86;
    window.speechSynthesis.speak(utterance);
  } catch {}
}
async function speakAndWait(text, options = {}) {
  if (!text || !state.audioUnlocked) return false;
  try {
    if (typeof runtime.audio?.speakAndWait === 'function') {
      return await runtime.audio.speakAndWait(text, options);
    }
  } catch {
    return false;
  }

  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
  stopSpeech();
  return await new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = options.lang || 'zh-CN';
    utterance.rate = options.rate ?? .86;
    utterance.pitch = options.pitch ?? 1.08;
    utterance.onend = () => resolve(true);
    utterance.onerror = () => resolve(false);
    try { window.speechSynthesis.speak(utterance); }
    catch { resolve(false); }
  });
}
function playEffect(name) {
  try {
    if (typeof runtime.audio?.playEffect === 'function') runtime.audio.playEffect(name);
  } catch {}
}
function readNumber(number) {
  if (!state.audioUnlocked) return;
  try {
    if (typeof runtime.audio?.readNumber === 'function') { runtime.audio.readNumber(number); return; }
  } catch {}
  speak(String(number));
}
function readTask(task, fallbackText) {
  if (!state.audioUnlocked) return;
  try {
    if (typeof runtime.audio?.readTask === 'function' && runtime.audio.readTask(task) !== false) return;
  } catch {}
  speak(fallbackText);
}
function scheduleSpeech(text, delay = 0) {
  const token = ++state.scheduleId;
  window.setTimeout(() => { if (token === state.scheduleId && state.screen === 'game') speak(text); }, delay);
}
function scheduleTaskRead(task, fallbackText, delay = 0) {
  const token = ++state.scheduleId;
  window.setTimeout(() => {
    if (token === state.scheduleId && state.screen === 'game') readTask(task, fallbackText);
  }, delay);
}
function roofBlocksMarkup(value, target) {
  return Array.from({ length: target }, (_, index) => {
    const filled = index < value;
    const added = filled && state.lastChange?.kind === 'add' && index >= state.lastChange.before;
    const layer = index < 5 ? 'bottom' : 'top';
    return `<i class="roof-block ${layer} ${filled ? 'filled' : 'missing'} ${added ? 'added' : ''}" aria-hidden="true"></i>`;
  }).join('');
}
function topBar() {
  return `<header class="topbar"><button class="brand" data-action="restart" aria-label="重新开始小鸡数字积木新家">小鸡数字积木新家</button><div class="top-actions"><button class="round-icon" data-action="repeat" aria-label="再听一次任务">🔊</button></div></header>`;
}
function technicalNotice() {
  if (!runtime.missingModules.length) return '';
  return `<p class="technical-notice" role="status">正在使用内置试玩模式；等待游戏模块接入：<code>${runtime.missingModules.join('、')}</code></p>`;
}
function welcomeMarkup() {
  return `<div class="app-shell">${topBar()}${technicalNotice()}<section class="welcome"><div class="welcome-scene" aria-hidden="true"><div class="welcome-chick">🐥</div><div class="tiny-house"></div></div><h1>帮小鸡搭新家</h1><p>数一数、搬积木。积木刚刚好，新家就会越来越大！</p><button class="primary-button" data-action="start">开始搭新家 ✨</button></section></div>`;
}
function phaseInstruction() {
  const { targetValue, numberBlock, dropCount, restoreCount } = state.task;
  if (state.phase === 'fill') return { title: `屋顶需要 ${targetValue} 块，选择数字 ${numberBlock} 积木补一补。`, sub: '点一下积木会展开；也可以拖到屋顶。' };
  if (state.phase === 'placing') return { title: '小鸡正在一块一块搬上去！', sub: '一起数一数。' };
  if (state.phase === 'wind') return { title: `呀！风吹掉了 ${dropCount} 块积木。`, sub: '看看还剩多少块。' };
  if (state.phase === 'answer') return { title: '现在还剩几块？', sub: '选一个数字告诉小鸡。' };
  if (state.phase === 'restore') return { title: `再补 ${restoreCount} 块，屋顶就修好啦！`, sub: '点一下积木，或把它拖到屋顶。' };
  if (state.phase === 'repairing') return { title: '小鸡正在修屋顶！', sub: '数一数最后的积木。' };
  return { title: '小鸡的新家完成啦！', sub: '你帮了大忙。' };
}
function sourceBlockMarkup(value, disabled) {
  return `<button class="number-block" data-draggable-block data-source-kind="number" data-block-amount="${value}" ${disabled ? 'disabled' : ''} aria-label="数字牌 ${value}，旁边预览 ${value} 块积木。点击展开，或拖到屋顶。"><span class="number-card-tag">数字牌</span><span class="number-symbol">${value}</span><span class="number-preview" aria-hidden="true">${Array.from({ length: value }, () => '<i></i>').join('')}</span><span class="number-caption">展开成 ${value} 块积木</span></button>`;
}
function unitBlockMarkup(index, disabled) {
  return `<button class="unit-source" data-draggable-block data-source-kind="unit" data-block-amount="1" data-unit-id="${index}" ${disabled ? 'disabled' : ''} aria-label="第 ${index + 1} 块积木，每块代表 1。点击或拖到屋顶。"><span class="unit-face">1</span><span class="unit-caption">一块积木</span></button>`;
}
function actionMarkup() {
  const info = phaseInstruction();
  const value = currentValue();
  let content = '';
  if (state.phase === 'fill' || state.phase === 'placing') {
    content = `<div class="block-tray">${sourceBlockMarkup(state.task.numberBlock, state.phase === 'placing')}</div>${state.expandedCount ? `<div class="expanded-units" aria-label="${state.expandedCount} 块积木正在搬运">${Array.from({ length: state.expandedCount }, () => '<i class="mini-unit"></i>').join('')}</div>` : ''}`;
  } else if (state.phase === 'answer') {
    content = `<div class="answer-tray" role="group" aria-label="选择还剩的积木数">${[...state.task.answerOptions].sort((a, b) => a - b).map(option => `<button class="answer-button ${state.selectedAnswer === option ? (option === value ? 'correct' : 'wrong') : ''}" data-answer="${option}" aria-label="${option} 块" ${state.interactionLocked ? 'disabled' : ''}>${option}</button>`).join('')}</div>`;
  } else if (state.phase === 'restore' || state.phase === 'repairing') {
    const remainingUnits = Math.max(0, state.task.targetValue - value);
    const restoredUnits = Math.max(0, value - (state.task.targetValue - state.task.dropCount));
    content = `<div class="block-tray unit-tray" aria-label="两块独立的单位积木">${Array.from({ length: remainingUnits }, (_, index) => unitBlockMarkup(restoredUnits + index, state.phase === 'repairing' || state.interactionLocked)).join('')}</div>`;
  } else if (state.phase === 'done') {
    content = `<div class="done-card"><div><b>屋顶修好啦！</b>你让 ${state.task.targetValue} 块积木变得刚刚好。<br><button class="secondary-button restart" data-action="restart">再玩一次</button></div></div>`;
  } else { content = '<div class="done-card">准备好和小鸡一起数积木了吗？</div>'; }
  return `<section class="action-panel" aria-label="任务操作区"><p class="instruction">${info.title}<small>${info.sub}</small></p>${content}<p class="feedback ${state.feedbackTone}" role="status">${state.feedback}</p><p class="source-hint">每块积木都代表 1；数字积木会展开成对应数量。</p></section>`;
}
function gameMarkup() {
  const value = currentValue();
  const { targetValue, dropCount } = state.task;
  const remaining = Math.max(0, targetValue - value);
  const roofClass = state.phase === 'done' ? 'finished' : state.phase === 'wind' || state.phase === 'answer' || state.phase === 'restore' || state.phase === 'repairing' ? 'shaking' : 'pending';
  const wind = state.phase === 'wind';
  return `<div class="app-shell">${topBar()}${technicalNotice()}<section class="game-card"><header class="level-header"><div class="level-copy"><strong>第一关 · 小鸡的屋顶</strong><span>第一个任务：补一补，修一修</span></div><div class="progress-wrap"><div class="progress-label"><span>新家进度</span><span>${state.phase === 'done' ? '完成！' : '1 / 5'}</span></div><div class="progress-rail"><span style="width:${state.phase === 'done' ? 100 : state.phase === 'restore' || state.phase === 'repairing' ? 82 : state.phase === 'answer' ? 63 : value >= targetValue ? 48 : 24}%"></span></div></div></header><section class="quantity-panel" aria-label="数量信息"><div class="quantity-card current"><span class="quantity-label">现在有</span><strong class="quantity-value">${value}</strong></div><div class="quantity-card target"><span class="quantity-label">屋顶需要</span><strong class="quantity-value">${targetValue}</strong></div><div class="quantity-card missing"><span class="quantity-label">还差</span><strong class="quantity-value">${remaining}</strong></div></section><section class="scene" aria-label="小鸡的新家和积木"><i class="cloud one"></i><i class="cloud two"></i><div class="house-zone"><span class="house-label">8 块积木屋顶</span><div class="roof-block-grid ${roofClass}" data-drop-zone aria-label="把积木拖到屋顶的发光位置">${roofBlocksMarkup(value, targetValue)}</div><div class="house-body"></div></div><div class="wind-lines ${wind ? 'active' : ''}" aria-hidden="true"><span></span><span></span><span></span></div>${state.pendingDrop ? `<div class="fallen-blocks" aria-label="风吹掉 ${state.fallingCount} 块积木">${Array.from({ length: state.fallingCount }, () => '<i class="fallen-block falling"></i>').join('')}</div>` : ''}<div class="chick-row" aria-hidden="true"><div class="chick ${state.phase === 'done' ? 'cheer' : ''}">🐥</div><div class="chick ${state.phase === 'done' ? 'cheer' : ''}">🐤</div></div></section>${actionMarkup()}</section></div>`;
}
function render() { APP.innerHTML = state.screen === 'welcome' ? welcomeMarkup() : gameMarkup(); }
function resetTechnicalSlice() {
  state.task = normalizedTask(runtime.createTechnicalSliceTask?.());
  state.model = makeModel(state.task.initialValue);
  state.phase = 'fill';
  state.expandedCount = 0;
  state.lastChange = null;
  state.feedback = '看看发光的空位，刚好还差 3 块。';
  state.feedbackTone = '';
  state.selectedAnswer = null;
  state.pendingDrop = false;
  state.fallingCount = 0;
  state.interactionLocked = false;
  state.scheduleId += 1;
  persist();
}
function changeQuantity(kind, amount, meta) {
  const { before, after } = callModel(kind === 'add' ? 'add' : 'remove', amount, meta);
  state.lastChange = { kind, count: Math.abs(after - before), before, after };
  persist();
  appendEvent('quantity_changed', { operation: kind, amount, before, after, meta });
  return { before, after };
}
async function useSourceBlock(amount) {
  if (!state.task || state.phase !== 'fill' || amount !== state.task.numberBlock) return;
  state.phase = 'placing';
  state.expandedCount = amount;
  state.feedback = `数字 ${amount} 变成 ${amount} 块小积木啦！`;
  state.feedbackTone = '';
  render();
  playEffect('ui.tap');
  readNumber(amount);
  appendEvent('number_block_opened', { amount });
  await sleep(320);
  for (let index = 0; index < amount; index += 1) {
    changeQuantity('add', 1, { source: 'number_block', amount, step: index + 1 });
    state.expandedCount = amount - index - 1;
    state.feedback = `放一块，是 ${currentValue()} 块。`;
    state.feedbackTone = 'good';
    render();
    playEffect('block.snap');
    playEffect('count.step');
    readNumber(currentValue());
    await sleep(480);
  }
  state.expandedCount = 0;
  state.phase = 'wind';
  state.pendingDrop = true;
  state.fallingCount = 0;
  state.feedback = '有 8 块啦！大风要来了。';
  state.feedbackTone = '';
  render();
  await speakAndWait('大风来了。', { rate: .92 });
  // Every removal commits to QuantityModel before its own falling frame.
  for (let index = 0; index < state.task.dropCount; index += 1) {
    changeQuantity('remove', 1, { source: 'wind', count: state.task.dropCount, step: index + 1 });
    state.fallingCount = index + 1;
    state.feedback = `风吹掉了 ${state.fallingCount} 块，看看还剩多少。`;
    state.feedbackTone = 'gentle';
    render();
    playEffect('block.drop');
    await sleep(430);
  }
  await sleep(420);
  state.phase = 'answer';
  state.pendingDrop = false;
  state.fallingCount = 0;
  state.interactionLocked = true;
  state.feedback = '风吹掉了两块积木。听完问题再回答。';
  state.feedbackTone = '';
  persist();
  render();
  await speakAndWait('掉了两块。还剩几块？', { rate: .92 });
  state.interactionLocked = false;
  state.feedback = '选一个数字，告诉小鸡现在还剩几块。';
  render();
}
async function useUnitBlock(unitId) {
  if (!state.task || state.interactionLocked || state.phase !== 'restore' || currentValue() >= state.task.targetValue) return;
  state.phase = 'repairing';
  state.feedback = '小鸡把这一块积木轻轻放到屋顶上。';
  state.feedbackTone = '';
  render();
  playEffect('ui.tap');
  appendEvent('unit_block_opened', { unitId });
  changeQuantity('add', 1, { source: 'unit_block', unitId });
  state.feedback = `补好一块，现在有 ${currentValue()} 块。`;
  state.feedbackTone = 'good';
  render();
  playEffect('block.snap');
  playEffect('count.step');
  readNumber(currentValue());
  await sleep(480);
  if (currentValue() >= state.task.targetValue) {
    state.phase = 'done';
    state.feedback = '刚刚好！屋顶牢牢地搭好啦！';
    state.feedbackTone = 'good';
    persist();
    render();
    playEffect('build.complete');
    speak('太棒啦，屋顶修好啦！');
  } else {
    state.phase = 'restore';
    state.feedback = '还有一块积木，再放上去吧。';
    state.feedbackTone = '';
    render();
  }
}
async function chooseAnswer(answer) {
  if (state.phase !== 'answer' || state.interactionLocked) return;
  const expected = currentValue();
  state.selectedAnswer = answer;
  state.interactionLocked = true;
  appendEvent('answer_selected', { answer, expected });
  if (answer === expected) {
    state.phase = 'restore';
    state.feedback = `对啦！还剩 ${expected} 块。再补 2 块就修好屋顶啦。`;
    state.feedbackTone = 'good';
    render();
    playEffect('answer.correct');
    await speakAndWait('对啦，还剩六块。请补回两块。', { rate: .92 });
    state.interactionLocked = false;
    render();
  } else {
    state.feedback = '差一点。看看屋顶上留下的积木，再数一数。';
    state.feedbackTone = 'gentle';
    render();
    playEffect('answer.retry');
    await speakAndWait('再数一次屋顶上的积木。', { rate: .92 });
    state.interactionLocked = false;
    render();
  }
}
function invalidDrop() {
  if (!['fill', 'restore'].includes(state.phase)) return;
  state.feedback = '积木回到托盘啦。把它靠近发光屋顶，或者点一下积木也可以。';
  state.feedbackTone = 'gentle';
  render();
  playEffect('block.return');
}
function pointerStart(event, button) {
  if (button.disabled || !['fill', 'restore'].includes(state.phase)) return;
  state.lastPointerDrag = false;
  state.drag = { button, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
  button.setPointerCapture?.(event.pointerId);
}
function pointerMove(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 8) state.lastPointerDrag = true;
  if (!state.lastPointerDrag) return;
  drag.button.classList.add('dragging');
  drag.button.style.transform = `translate(${dx}px, ${dy}px)`;
}
function pointerEnd(event) {
  const drag = state.drag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  state.drag = null;
  const button = drag.button;
  button.releasePointerCapture?.(event.pointerId);
  button.classList.remove('dragging');
  button.style.transform = '';
  if (!state.lastPointerDrag) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop-zone]');
  if (target) {
    if (button.dataset.sourceKind === 'unit') useUnitBlock(button.dataset.unitId);
    else useSourceBlock(safeNumber(button.dataset.blockAmount));
  }
  else invalidDrop();
}
async function startGame() {
  await runtimeLoadPromise;
  await unlockAudio();
  resetTechnicalSlice();
  state.screen = 'game';
  render();
  appendEvent('task_started', { taskId: 'roof-5-8' });
  scheduleTaskRead({ ...state.task, currentValue: state.task.initialValue, voiceText: '小鸡的屋顶需要 8 块积木。现在有 5 块，请找数字 3 的积木补一补。' }, '小鸡的屋顶需要 8 块积木。现在有 5 块，请找数字 3 的积木补一补。', 500);
}
function repeatInstruction() {
  if (state.screen !== 'game') return;
  const info = phaseInstruction();
  speak(info.title);
}
function restart() {
  stopSpeech();
  state.scheduleId += 1;
  state.screen = 'welcome';
  state.drag = null;
  render();
}
function instantiateStorage() {
  if (!runtime.GameStorage) return null;
  try { return new runtime.GameStorage(); } catch { return null; }
}
async function loadRuntimeModules() {
  const [quantity, task, audio, storage] = await Promise.allSettled([
    import(MODULE_PATHS.quantity), import(MODULE_PATHS.task), import(MODULE_PATHS.audio), import(MODULE_PATHS.storage)
  ]);
  if (quantity.status === 'fulfilled' && typeof quantity.value.QuantityModel === 'function') runtime.QuantityModel = quantity.value.QuantityModel;
  else runtime.missingModules.push('QuantityModel');
  if (task.status === 'fulfilled' && typeof task.value.createTechnicalSliceTask === 'function') runtime.createTechnicalSliceTask = task.value.createTechnicalSliceTask;
  else runtime.missingModules.push('createTechnicalSliceTask');
  if (audio.status === 'fulfilled' && (audio.value.audioManager || audio.value.default || typeof audio.value.AudioManager === 'function')) {
    runtime.AudioManager = audio.value.AudioManager ?? null;
    runtime.audio = audio.value.audioManager ?? audio.value.default ?? createAudioManager();
  } else runtime.missingModules.push('audioManager');
  if (storage.status === 'fulfilled' && (storage.value.gameStorage || storage.value.default || typeof storage.value.GameStorage === 'function')) {
    runtime.GameStorage = storage.value.GameStorage ?? null;
    runtime.storage = storage.value.gameStorage ?? storage.value.default ?? instantiateStorage();
  } else runtime.missingModules.push('gameStorage');
  render();
  void syncPendingEvents();
}

APP.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.action === 'start') startGame();
  else if (button.dataset.action === 'repeat') repeatInstruction();
  else if (button.dataset.action === 'restart') restart();
  else if (button.hasAttribute('data-draggable-block') && !state.lastPointerDrag) {
    if (button.dataset.sourceKind === 'unit') useUnitBlock(button.dataset.unitId);
    else useSourceBlock(safeNumber(button.dataset.blockAmount));
  }
  else if (button.dataset.answer) chooseAnswer(safeNumber(button.dataset.answer));
});
APP.addEventListener('pointerdown', event => { const button = event.target.closest('[data-draggable-block]'); if (button) pointerStart(event, button); });
window.addEventListener('pointermove', pointerMove, { passive: true });
window.addEventListener('pointerup', pointerEnd, { passive: true });
window.addEventListener('pointercancel', pointerEnd, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
window.addEventListener('online', () => { void syncPendingEvents(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

render();
runtimeLoadPromise = loadRuntimeModules();
