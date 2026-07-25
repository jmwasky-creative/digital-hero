const STORAGE_KEY = 'digital-hero-ui-state-v1';
const avatars = ['🦊', '🐼', '🐯', '🦄'];
const names = ['小勇士', '星星侠', '闪电仔', '智慧宝'];

const fallbackQuestions = [
  [2, '+', 3, '小松鼠找到了 2 颗松果，又找到了 3 颗。', 5],
  [7, '-', 2, '树上有 7 只小鸟，飞走了 2 只。', 5],
  [4, '+', 4, '4 朵花和 4 朵花在一起。', 8],
  [9, '-', 3, '9 个苹果，送给朋友 3 个。', 6],
  [6, '+', 3, '6 颗星星又飞来了 3 颗。', 9]
].map(([a, operator, b, story, answer], index) => ({ id: `local-${index + 1}`, a, operator, b, story, answer, options: makeOptions(answer, index) }));

function makeOptions(answer, salt = 0) {
  const candidates = [answer, Math.max(0, answer - (salt % 2 ? 2 : 1)), Math.min(20, answer + (salt % 3 ? 2 : 1))];
  return [...new Set(candidates)].sort(() => (salt % 2 ? 1 : -1)).slice(0, 3);
}

const safeJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const initial = () => ({ player: null, completed: 0, level: 1, exp: 0, coins: 0, useMock: false });
let state = { ...initial(), ...safeJson(STORAGE_KEY, {}) };
let game = null;
const app = document.querySelector('#app');

function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function escapeHtml(value = '') { const el = document.createElement('div'); el.textContent = String(value); return el.innerHTML; }
function id() { return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }
function toast(message) { document.querySelector('.notice')?.remove(); const el = document.createElement('div'); el.className = 'notice'; el.textContent = message; document.body.append(el); setTimeout(() => el.remove(), 2600); }

async function request(path, options = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`/api/v1${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error('api unavailable');
    return await response.json();
  } finally { clearTimeout(timer); }
}

const api = {
  async createPlayer(player) { return request('/players', { method: 'POST', body: JSON.stringify({ ...player, clientRequestId: id() }) }); },
  async startRun(level) { return request('/runs', { method: 'POST', body: JSON.stringify({ mapId: 'taoyuan', level, clientRequestId: id() }) }); },
  async nextQuestion(runId) { return request(`/runs/${encodeURIComponent(runId)}/questions/next`, { method: 'POST' }); },
  async hint(attemptId) { return request(`/attempts/${encodeURIComponent(attemptId)}/hint`, { method: 'POST', body: JSON.stringify({ clientRequestId: id() }) }); },
  async answer(attemptId, choice) { return request(`/attempts/${encodeURIComponent(attemptId)}/answers`, { method: 'POST', body: JSON.stringify({ choice, responseId: id() }) }); },
  async finish(runId) { return request(`/runs/${encodeURIComponent(runId)}/finish`, { method: 'POST', body: JSON.stringify({ clientRequestId: id() }) }); }
};

function normalizeQuestion(raw, index) {
  const question = raw?.question ?? raw ?? {};
  const text = question.text ?? question.prompt ?? `${question.a ?? fallbackQuestions[index].a} ${question.operator ?? fallbackQuestions[index].operator} ${question.b ?? fallbackQuestions[index].b}`;
  const match = text.match(/(\d+)\s*([+＋\-－])\s*(\d+)/);
  const a = Number(question.a ?? match?.[1] ?? fallbackQuestions[index].a);
  const operator = question.operator ?? match?.[2]?.replace('＋', '+').replace('－', '-') ?? fallbackQuestions[index].operator;
  const b = Number(question.b ?? match?.[3] ?? fallbackQuestions[index].b);
  return { id: question.id ?? question.questionId ?? `remote-${index}`, attemptId: raw?.attemptId ?? question.attemptId, a, operator, b, story: question.story ?? question.hintText ?? fallbackQuestions[index].story, options: question.options ?? fallbackQuestions[index].options, answer: question.answer };
}

function chrome(content) { return `<div class="shell"><header class="topbar"><button class="brand" data-action="home" aria-label="回到桃源村">数 字 小 英 雄</button>${state.player ? `<div class="stat-row"><span class="stat" aria-label="经验值">⚡ ${state.exp} EXP</span><span class="stat" aria-label="金币">🪙 ${state.coins}</span></div>` : ''}</header>${content}</div>`; }

function renderWelcome() { app.innerHTML = chrome(`<section class="hero"><div class="mascot" aria-hidden="true"><span></span></div><h1>一起守护数字王国！</h1><p>动动小脑袋，成为最勇敢的数字小英雄。</p><button class="primary wide" data-action="setup">开始冒险 ✨</button></section>`); }
function renderSetup() { const selectedAvatar = state.draft?.avatar ?? avatars[0]; const selectedName = state.draft?.nickname ?? names[0]; app.innerHTML = chrome(`<section class="panel setup"><h1>选一位小英雄</h1><p class="muted">不用告诉我们真实名字哦。</p><h2>我的伙伴</h2><div class="avatar-row">${avatars.map(a => `<button class="avatar" aria-pressed="${a === selectedAvatar}" data-avatar="${a}" aria-label="选择${a}">${a}</button>`).join('')}</div><h2>英雄称号</h2><div class="name-row">${names.map(n => `<button class="name" aria-pressed="${n === selectedName}" data-name="${n}">${n}</button>`).join('')}</div><button class="primary wide" data-action="create">出发去桃源村！</button><p class="muted" style="font-size:.86rem">只保存游戏进度，不收集真实个人信息。</p></section>`); }
function levelButton(n, icon, title, unlocked) { const done = state.completed >= n; return `<button class="level" ${unlocked ? `data-level="${n}"` : 'disabled'}><span class="level-icon">${icon}</span><span><strong>第 ${n} 关 · ${title}</strong><small>${done ? '已完成，随时再练一次' : unlocked ? '开始挑战' : '完成前一关后开启'}</small></span><span class="stars">${done ? '★★★' : unlocked ? '☆ ☆ ☆' : '🔒'}</span></button>`; }
function renderMap() { const next = Math.min(state.completed + 1, 5); app.innerHTML = chrome(`<section class="map"><h1 class="map-title">桃源村</h1><p class="muted map-subtitle">跟着小狐狸，找回被捣乱的数字能量！</p><div class="island"><i class="cloud c1"></i><i class="cloud c2"></i><div class="level-path">${levelButton(1, '🌻', '松果小径', next >= 1)}${levelButton(2, '🐸', '荷叶池塘', next >= 2)}${levelButton(3, '🌳', '果园寻宝', next >= 3)}${levelButton(4, '🌈', '彩虹桥头', next >= 4)}${levelButton(5, '🏰', '村庄庆典', next >= 5)}</div></div><p class="muted" style="text-align:center">每关有 5 道题，答错也没关系，我们一起想办法！</p></section>`); }

function drawStage(canvas, health) {
  const ctx = canvas.getContext('2d'); const ratio = devicePixelRatio || 1; const width = canvas.clientWidth; const height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio; ctx.scale(ratio, ratio);
  ctx.clearRect(0,0,width,height); const y = height - 48;
  ctx.fillStyle = '#f6c34c'; ctx.beginPath(); ctx.arc(width * .2, y - 29, 29, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f7a84b'; ctx.beginPath(); ctx.ellipse(width * .21, y - 20, 25, 18, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#312b57'; ctx.beginPath(); ctx.arc(width*.19,y-35,4,0,Math.PI*2); ctx.arc(width*.24,y-35,4,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#312b57';ctx.lineWidth=3;ctx.beginPath();ctx.arc(width*.215,y-23,8,0,Math.PI);ctx.stroke();
  const mx=width*.74, my=y-38; ctx.fillStyle=health <= 1 ? '#b5a1e8' : '#8b64d9';ctx.beginPath();ctx.arc(mx,my,36,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(mx-13,my-6,10,0,Math.PI*2);ctx.arc(mx+13,my-6,10,0,Math.PI*2);ctx.fill();ctx.fillStyle='#302751';ctx.beginPath();ctx.arc(mx-11,my-5,4,0,Math.PI*2);ctx.arc(mx+15,my-5,4,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#302751';ctx.lineWidth=4;ctx.beginPath();ctx.arc(mx+2,my+9,12,0,Math.PI);ctx.stroke();
}

function renderBattle() { const q = game.questions[game.index]; const health = 5 - game.index; const hint = game.hintShown ? `<div class="hintbox">${game.guided ? '我们一起数：' : '小提示：把数字放进十格框里，慢慢数一数。'}<div class="tenframe">${Array.from({length:10}, (_,i) => `<i class="dot ${i < Math.min(q.a + (q.operator === '+' ? q.b : 0), 10) ? 'on' : ''}"></i>`).join('')}</div></div>` : '';
  app.innerHTML = chrome(`<section class="battle"><div class="battle-head"><span class="round">第 ${game.index + 1} / 5 题</span><div class="progress" aria-label="答题进度"><span style="width:${game.index * 20}%"></span></div><span class="round">怪物能量 ${'❤️'.repeat(health)}</span></div><div class="stage"><i class="spark"></i><canvas class="canvas-decor" aria-hidden="true"></canvas><span class="monster-energy">捣蛋怪</span></div><article class="panel question-card"><p class="story">${escapeHtml(q.story)}</p><div class="question" aria-label="题目：${q.a}${q.operator}${q.b}等于多少">${q.a} ${q.operator} ${q.b} = ?</div><div class="choices" role="group" aria-label="选择答案">${q.options.map(option => `<button class="answer" data-answer="${option}">${option}</button>`).join('')}</div>${hint}<div class="feedback ${game.feedbackKind || ''}">${game.feedback || ''}</div><div class="battle-actions"><button class="secondary hint" data-action="speak" aria-label="朗读题目">🔊 读一遍</button><button class="secondary hint" data-action="hint" ${game.hintShown ? 'disabled' : ''}>💡 给我提示</button></div></article></section>`);
  drawStage(document.querySelector('.canvas-decor'), health);
}

function renderResult() { const stars = game.firstTryCorrect === 5 ? 3 : game.firstTryCorrect === 4 ? 2 : 1; const reward = game.firstTryCorrect * 10 + 20; const coins = game.firstTryCorrect * 5 + 10; app.innerHTML = chrome(`<section class="panel result"><div class="mascot" aria-hidden="true" style="transform:scale(.7);margin-bottom:-16px"><span></span></div><h1>太棒啦，任务完成！</h1><div class="result-stars" aria-label="${stars}星">${'★'.repeat(stars)}${'☆'.repeat(3-stars)}</div><p class="muted">你第一次就答对了 ${game.firstTryCorrect} 道题！</p><div class="reward-grid"><div class="reward"><b>+${reward}</b>⚡ 经验</div><div class="reward"><b>+${coins}</b>🪙 金币</div></div><button class="primary wide" data-action="map">回到桃源村</button></section>`); }

async function createHero() { const player = state.draft ?? { avatar: avatars[0], nickname: names[0] }; let remote = null; try { if (!state.useMock) remote = await api.createPlayer(player); } catch { state.useMock = true; toast('现在使用离线试玩模式，进度会保存在这台设备。'); }
  state.player = { ...player, ...(remote?.player ?? remote ?? {}) }; state.exp = Number(state.player.exp ?? state.exp ?? 0); state.coins = Number(state.player.coins ?? state.coins ?? 0); persist(); renderMap(); }
async function startLevel(level) { game = { level, runId: null, questions: [], index: 0, attempts: 0, firstTryCorrect: 0, hintShown:false, guided:false, feedback:'', feedbackKind:'', startedAt:Date.now() };
  try { if (!state.useMock) { const run = await api.startRun(level); game.runId = run.runId ?? run.id ?? run.run?.id; } } catch { state.useMock = true; toast('服务器暂时不可用，继续离线练习吧！'); }
  if (game.runId) await loadRemoteQuestion(); else { game.questions = fallbackQuestions.map(q => ({...q})); renderBattle(); }
}
async function loadRemoteQuestion() { try { const payload = await api.nextQuestion(game.runId); game.questions.push(normalizeQuestion(payload, game.index)); renderBattle(); } catch { state.useMock = true; game.questions = fallbackQuestions.map(q => ({...q})); renderBattle(); toast('切换到离线练习题。'); } }
async function giveHint() { if (!game || game.hintShown) return; game.hintShown = true; if (game.runId && game.questions[game.index].attemptId) { try { await api.hint(game.questions[game.index].attemptId); } catch {} } renderBattle(); }
function currentAnswer(q) { return q.answer ?? (q.operator === '+' ? q.a + q.b : q.a - q.b); }
async function chooseAnswer(value, button) { if (!game || button.disabled) return; const q=game.questions[game.index]; const correct = Number(value) === Number(currentAnswer(q)); game.attempts += 1; document.querySelectorAll('.answer').forEach(b => b.disabled = true); button.classList.add(correct ? 'correct' : 'wrong');
  let response = null; if (game.runId && q.attemptId) { try { response = await api.answer(q.attemptId, Number(value)); } catch { state.useMock = true; } }
  const wasCorrect = response?.correct ?? response?.isCorrect ?? correct;
  if (wasCorrect) { if (game.attempts === 1 && !game.hintShown) game.firstTryCorrect += 1; game.feedback='答对啦！数字能量击中了捣蛋怪！'; game.feedbackKind='good'; setTimeout(nextQuestion, 900); return; }
  if (game.attempts === 1) { game.feedback='再想一想，数一数就能找到答案！'; game.feedbackKind='bad'; game.hintShown=true; setTimeout(() => { game.feedback=''; renderBattle(); }, 850); return; }
  game.guided=true; game.hintShown=true; game.feedback=`没关系，我们一起完成：${q.a} ${q.operator} ${q.b} = ${currentAnswer(q)}。`; game.feedbackKind='good'; setTimeout(nextQuestion, 1650);
}
async function nextQuestion() { if (!game) return; if (game.index >= 4) { await finishLevel(); return; } game.index += 1; game.attempts=0; game.hintShown=false;game.guided=false;game.feedback='';game.feedbackKind=''; if (game.runId) await loadRemoteQuestion(); else renderBattle(); }
async function finishLevel() { let finish=null; if (game.runId) { try { finish=await api.finish(game.runId); } catch { state.useMock=true; } }
  const reward = finish?.rewards ?? finish?.reward; const expGain = Number(reward?.exp ?? reward?.experience ?? game.firstTryCorrect * 10 + 20); const coinGain = Number(reward?.coins ?? game.firstTryCorrect * 5 + 10); state.exp = Number(finish?.player?.exp ?? state.exp + expGain); state.coins=Number(finish?.player?.coins ?? state.coins + coinGain); state.completed=Math.max(state.completed,game.level); state.level=Number(finish?.player?.level ?? state.level); persist(); renderResult(); }
function speakQuestion() { const q=game?.questions[game.index]; if (!q) return; if (!('speechSynthesis' in window)) return toast('这台设备暂时不能朗读，看看题目和小提示吧。'); speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(`${q.story} ${q.a} ${q.operator === '+' ? '加' : '减'} ${q.b} 等于多少？`); utterance.lang='zh-CN'; utterance.rate=.82; speechSynthesis.speak(utterance); }
function speakNumber(value) { if (!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(String(value)); utterance.lang='zh-CN'; utterance.rate=.82; speechSynthesis.speak(utterance); }

app.addEventListener('click', event => { const button=event.target.closest('button'); if (!button) return; const action=button.dataset.action; if (action==='setup') renderSetup(); if(action==='home'||action==='map') { game=null; renderMap(); } if(action==='create') createHero(); if(action==='hint') giveHint(); if(action==='speak') speakQuestion(); if(button.dataset.avatar) { state.draft={...(state.draft||{}),avatar:button.dataset.avatar}; renderSetup(); } if(button.dataset.name) { state.draft={...(state.draft||{}),nickname:button.dataset.name}; renderSetup(); } if(button.dataset.level) startLevel(Number(button.dataset.level)); if(button.dataset.answer) { speakNumber(button.dataset.answer); chooseAnswer(button.dataset.answer,button); } });
if (state.player) renderMap(); else renderWelcome();
