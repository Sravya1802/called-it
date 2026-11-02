const overlay = document.body.classList.contains('overlay');
const $ = (id) => document.getElementById(id);
const escape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state,
  offset = 0;
async function demo(body) {
  try {
    const res = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Demo action failed');
  } catch (e) {
    alert(e.message);
  }
}
function card(c) {
  const el = document.createElement('article');
  el.className = 'call-card';
  el.dataset.id = c.id;
  el.innerHTML = `<div class="card-inner"><div class="card-top"><span class="avatar">${escape(c.username.slice(0, 2).toUpperCase())}</span><strong>${escape(c.username)}</strong>${c.onFire ? `<span class="flame-badge" title="${escape(c.username)} is on fire" aria-label="${escape(c.username)} is on fire">🔥<span>${escape(c.username)} is on fire</span></span>` : ''}<span class="call-id">#${c.id}</span><span class="countdown"></span></div><p class="prediction">${escape(c.text)}</p><div class="card-bottom"><span class="vote">↗ <b class="back-count"></b><code>!back ${c.id}</code></span><span class="vote doubt">↘ <b class="doubt-count"></b><code>!doubt ${c.id}</code></span>${!overlay && state.demo ? '<div class="resolve-controls"><button data-action="yes">✓ Yes</button><button data-action="no">✕ No</button><button data-action="expire">◷ Expire</button></div>' : '<small>PICK A SIDE</small>'}</div></div><div class="timer-track"><div class="timer-bar"></div></div>`;
  el.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => demo({ action: b.dataset.action, id: c.id })),
  );
  return el;
}
function render(data) {
  if (overlay) updateBattle(data);
  state = data;
  offset = data.now - Date.now();
  if ($('connection')) {
    $('connection').textContent = data.connection;
    $('mode').textContent = data.demo ? 'DEMO MODE · 1 MINUTE = 15 SECONDS' : 'LOCAL STREAM COMPANION';
  }
  for (const [key, val] of Object.entries(data.stats)) if ($('stat-' + key)) $('stat-' + key).textContent = val;
  if ($('call-count')) $('call-count').textContent = String(data.stats.active).padStart(2, '0');
  // Keep live cards first and cap the board at five, including outgoing animations.
  const visible = [
    ...data.calls.filter((c) => c.status === 'active'),
    ...data.calls.filter((c) => c.status !== 'active'),
  ].slice(0, 5);
  for (const el of $('cards').children) if (!visible.some((c) => c.id === el.dataset.id)) el.remove();
  visible.forEach((c) => {
    let el = Array.from($('cards').children).find((el) => el.dataset.id === c.id);
    if (!el) {
      el = card(c);
      $('cards').append(el);
    }
    el.querySelector('.back-count').textContent = c.backers;
    el.querySelector('.doubt-count').textContent = c.doubters;
    if (c.status !== 'active' && !el.querySelector('.result')) {
      el.classList.add(c.status);
      const result = document.createElement('div');
      result.className = 'result';
      const titles = { yes: 'CALLED IT.', no: 'BUSTED.', unresolved: 'UNRESOLVED' };
      result.innerHTML = `<strong>${titles[c.status]}</strong><span>${c.status === 'yes' ? 'CALLER +100 · BACKERS +25' : c.status === 'no' ? 'DOUBTERS +25 · THE RECEIPTS ARE IN' : 'TIME’S UP · NO POINTS AWARDED'}</span>`;
      el.append(result);
      if (c.status === 'yes')
        for (let i = 0; i < 30; i++) {
          const p = document.createElement('i');
          p.className = 'confetti';
          p.style.cssText = `left:${Math.random() * 100}%;background:${['#d4ff63', '#a9dc8e', '#ef9eac', '#ffffff'][i % 4]};--drift:${Math.random() * 200 - 100}px;animation-delay:${Math.random() * 0.8}s`;
          el.append(p);
        }
    }
  });
  $('empty').hidden = visible.length > 0;
  if ($('leaderboard'))
    $('leaderboard').innerHTML = data.leaderboard.length
      ? data.leaderboard
          .map(
            (p, i) =>
              `<div class="rank"><span>${String(i + 1).padStart(2, '0')}</span><div class="avatar">${escape(p.name.slice(0, 2).toUpperCase())}</div><strong>${escape(p.name)}</strong><b>${p.points}<small>PT</small></b></div>`,
          )
          .join('')
      : '<p class="subtle">NO ORACLES YET. YOUR MOVE, CHAT.</p>';
  if ($('messages')) {
    const list = $('messages');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 50;
    list.innerHTML = data.messages
      .map(
        (m) =>
          `<div class="message ${m.bot ? 'bot' : ''}"><strong>${escape(m.name)}</strong><span>${escape(m.text)}</span></div>`,
      )
      .join('');
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  if ($('chat-form')) {
    $('chat-form').hidden = !data.demo;
    $('seed').hidden = !data.demo;
  }
  updateTimers();
}
const seenResults = new Set();
const moments = [];
let initializedResults = false,
  playingMoment = false,
  audio;
function updateBattle(data) {
  if (data.battle) {
    $('battle-fill').style.width = `${data.battle.chatPercent}%`;
    $('battle-meter').setAttribute('aria-valuenow', data.battle.chatPercent);
    $('streamer-wins').textContent = data.battle.streamerWins;
    $('chat-wins').textContent = data.battle.chatWins;
  }
  for (const c of data.calls) {
    if (!['yes', 'no'].includes(c.status) || seenResults.has(c.id)) continue;
    seenResults.add(c.id);
    // A reload restores the board without replaying old audio or celebrations.
    if (initializedResults) moments.push(c);
  }
  initializedResults = true;
  playNextMoment();
}
async function resultSound(win) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audio ??= new AudioContext();
    await audio.resume();
    if (audio.state !== 'running') return;
    const start = audio.currentTime;
    const notes = win ? [523.25, 659.25, 783.99, 1046.5] : [220, 164.81, 110];
    notes.forEach((frequency, i) => {
      const oscillator = audio.createOscillator(),
        gain = audio.createGain();
      oscillator.type = win ? 'sine' : 'triangle';
      oscillator.frequency.setValueAtTime(frequency, start + i * 0.13);
      gain.gain.setValueAtTime(0, start + i * 0.13);
      gain.gain.linearRampToValueAtTime(0.12, start + i * 0.13 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + i * 0.13 + 0.4);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(start + i * 0.13);
      oscillator.stop(start + i * 0.13 + 0.42);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    });
  } catch (error) {
    console.warn('Result audio unavailable:', error.message);
  }
}
function playNextMoment() {
  if (playingMoment || !moments.length) return;
  playingMoment = true;
  const c = moments.shift(),
    el = $('result-moment');
  el.className = `result-moment ${c.status}`;
  el.innerHTML = `<div class="moment-content"><span>${escape(c.username)} · #${c.id}</span><strong>${c.status === 'yes' ? 'CALLED IT.' : 'BUSTED.'}</strong><p>${escape(c.text)}</p></div>`;
  el.hidden = false;
  if (c.status === 'yes')
    for (let i = 0; i < 60; i++) {
      const p = document.createElement('i');
      p.className = 'confetti';
      p.style.cssText = `left:${Math.random() * 100}%;background:${['#d4ff63', '#ef9eac', '#fff'][i % 3]};--drift:${Math.random() * 600 - 300}px;animation-delay:${Math.random()}s`;
      el.append(p);
    }
  void resultSound(c.status === 'yes');
  setTimeout(() => {
    el.hidden = true;
    el.replaceChildren();
    playingMoment = false;
    playNextMoment();
  }, 3200);
}
// Browsers may require a gesture; OBS browser sources normally allow autoplay.
if (overlay)
  window.addEventListener('pointerdown', () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        audio ??= new AC();
        void audio.resume();
      }
    } catch {}
  });
function updateTimers() {
  if (!state) return;
  state.calls.forEach((c) => {
    const el = Array.from($('cards').children).find((el) => el.dataset.id === c.id);
    if (!el) return;
    const remaining = Math.max(0, c.expiresAt - (Date.now() + offset));
    el.querySelector('.countdown').textContent =
      `${Math.floor(Math.ceil(remaining / 1000) / 60)}:${String(Math.ceil(remaining / 1000) % 60).padStart(2, '0')}`;
    el.querySelector('.timer-bar').style.width =
      `${Math.max(0, Math.min(100, (remaining / (c.expiresAt - c.createdAt)) * 100))}%`;
  });
}
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  ws.onmessage = (e) => {
    try {
      render(JSON.parse(e.data));
    } catch (error) {
      console.error(error);
    }
  };
  ws.onclose = () => {
    if ($('connection')) $('connection').textContent = 'Connection lost · reconnecting…';
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
}
$('chat-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  demo({ action: 'chat', user: Number($('viewer').value), text: $('command').value });
  $('command').value = '';
});
$('seed')?.addEventListener('click', () => demo({ action: 'seed' }));
if (overlay) {
  const resize = () => {
    $('overlay-stage').style.transform = `scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`;
  };
  window.addEventListener('resize', resize);
  resize();
}
setInterval(updateTimers, 250);
connect();
