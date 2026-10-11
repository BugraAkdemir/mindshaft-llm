/*
 * The control panel.
 *
 * No build step and no framework: `fetch` for commands, `EventSource` for the
 * feed, and plain DOM calls. Everything the page knows comes from the agent.
 */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  paused: false,
  cycle: 0,
  /** Instructions sent but not yet folded into a cycle. */
  pending: [],
  /** True once the opening snapshot frame has been handled. */
  hydrated: false,
};

const notifications = { enabled: false };

/* ─────────────────────────────── plumbing ────────────────────────────── */

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || res.statusText);
  }
  return res.json();
}

const command = (type, text) => post('/api/command', { type, text });

function notify(title, body) {
  if (!notifications.enabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body });
  } catch {
    /* some browsers refuse construction outside a service worker */
  }
}

function setConnection(label, tone) {
  const el = $('connection');
  el.textContent = label;
  el.className = `pill pill--${tone}`;
}

function syncButtons() {
  $('start').disabled = state.running;
  $('start').textContent = state.running ? 'Running' : 'Start';
  $('pause').disabled = !state.running;
  $('stop').disabled = !state.running;
  $('pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('instruction').disabled = !state.running;
  $('instruct').querySelector('button').disabled = !state.running;
}

/* ──────────────────────────────── the feed ───────────────────────────── */

function scrollToEnd() {
  if ($('autoscroll').checked) {
    const feed = $('feed');
    feed.scrollTop = feed.scrollHeight;
  }
}

function addRow(classes, parts) {
  const li = document.createElement('li');
  for (const cls of classes) li.classList.add(cls);
  for (const [cls, text] of parts) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    li.appendChild(span);
    li.appendChild(document.createTextNode(' '));
  }
  $('feed').appendChild(li);
  scrollToEnd();
  return li;
}

function renderWorld(world) {
  $('health').textContent = world.health;
  $('food').textContent = world.food;
  $('pos').textContent = `${world.pos.x}, ${world.pos.y}, ${world.pos.z}`;
  $('time').textContent = world.timeOfDay;
  $('cycle').textContent = world.cycle;
  $('pos').title = (world.inventory || []).map((i) => `${i.item} ×${i.count}`).join('\n');
  markDelivered();
}

/**
 * Guidance sent during cycle N is folded into cycle N+1's prompt, so an item
 * goes green once a *later* world frame arrives.
 */
function markDelivered() {
  state.pending = state.pending.filter((item) => {
    if (item.sentAtCycle >= state.cycle) return true;
    item.el.classList.add('sent');
    item.el.textContent = `${item.text} → applied`;
    return false;
  });
}

function renderEvent(event) {
  switch (event.type) {
    case 'lifecycle':
      setConnection(
        event.status,
        event.status === 'connected' ? 'live' : event.status === 'connecting' ? 'idle' : 'down',
      );
      state.running = event.status !== 'stopped';
      syncButtons();
      if (event.status === 'stopped') {
        notify('Agent stopped', event.detail || '');
        addRow(['bad'], [['err', `stopped — ${event.detail || 'no detail'}`]]);
      }
      return;

    case 'world':
      renderWorld(event);
      return;

    case 'decision': {
      const args = JSON.stringify(event.arguments || {});
      const row = addRow(['ok'], [
        ['meta', `#${event.cycle}`],
        ['tool', event.tool],
        ['args', args === '{}' ? '' : args],
      ]);
      row.appendChild(
        Object.assign(document.createElement('div'), {
          className: 'reason',
          textContent: event.reason || '(no reason given)',
        }),
      );
      return;
    }

    case 'result': {
      const row = $('feed').lastElementChild;
      if (!row) return;
      row.classList.remove('ok');
      row.classList.add(event.success ? 'ok' : 'bad');
      row.appendChild(
        Object.assign(document.createElement('div'), {
          className: event.success ? 'meta' : 'err',
          textContent: event.success
            ? `done in ${event.durationMs}ms`
            : `${event.error}: ${event.details || ''}`,
        }),
      );
      return;
    }

    case 'cycle':
      if (event.kind === 'goal_complete') {
        notify('Goal complete', `after cycle ${event.cycle}`);
        addRow(['note'], [['tool', `goal reached at cycle ${event.cycle}`]]);
      }
      if (event.kind === 'llm_error') {
        addRow(['bad'], [['err', `the model could not decide (cycle ${event.cycle})`]]);
      }
      return;

    case 'notice':
      addRow(['note'], [[event.level === 'info' ? 'meta' : 'err', event.message]]);
      return;

    default:
  }
}

function resetFeed() {
  $('feed').replaceChildren();
  $('pending').replaceChildren();
  state.pending = [];
  state.hydrated = false;
}

/* ─────────────────────────────── instructions ────────────────────────── */

function queueGuidance(text) {
  const li = document.createElement('li');
  li.textContent = `${text} → waiting`;
  $('pending').appendChild(li);
  state.pending.push({ text, el: li, sentAtCycle: state.cycle });
}

/* ──────────────────────────────── controls ───────────────────────────── */

function readSettings() {
  return {
    host: $('host').value.trim(),
    port: Number($('mcport').value) || 25565,
    username: $('username').value.trim() || 'AI_Agent',
    auth: 'offline',
    version: $('version').value.trim() || undefined,
    goal: $('goalInput').value.trim() || 'Survive and gather resources.',
    provider: $('provider').value,
    apiKey: $('apikey').value,
    model: $('model').value.trim(),
    baseUrl: $('baseurl').value.trim(),
  };
}

$('start').addEventListener('click', async () => {
  resetFeed();
  setConnection('starting', 'idle');
  try {
    await post('/api/start', readSettings());
    state.running = true;
    $('goal').textContent = $('goalInput').value.trim();
    syncButtons();
  } catch (err) {
    setConnection('start failed', 'down');
    window.alert(String((err && err.message) || err));
  }
});

$('pause').addEventListener('click', async () => {
  try {
    await command(state.paused ? 'resume' : 'pause');
    state.paused = !state.paused;
    syncButtons();
  } catch (err) {
    window.alert(String((err && err.message) || err));
  }
});

$('stop').addEventListener('click', async () => {
  try {
    await command('stop');
  } catch (err) {
    window.alert(String((err && err.message) || err));
  }
});

$('instruct').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('instruction');
  const text = input.value.trim();
  if (text === '') return;
  try {
    await command('guidance', text);
    queueGuidance(text);
    input.value = '';
  } catch (err) {
    window.alert(String((err && err.message) || err));
  }
});

$('clear').addEventListener('click', resetFeed);

$('notify').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') {
    $('notify').textContent = 'Not supported here';
    return;
  }
  const permission = await Notification.requestPermission();
  notifications.enabled = permission === 'granted';
  $('notify').textContent = notifications.enabled ? 'Notifications on' : 'Notifications blocked';
});

const JEV_DEFAULTS = { model: 'jev-1.13-free', baseUrl: 'https://opencode.ai/zen/v1' };
const OPENROUTER_DEFAULTS = {
  model: 'respan/span-01-lite:free',
  baseUrl: 'https://openrouter.ai/api/v1',
};

$('provider').addEventListener('change', () => {
  const defaults = $('provider').value === 'jev' ? JEV_DEFAULTS : OPENROUTER_DEFAULTS;
  $('model').value = defaults.model;
  $('baseurl').value = defaults.baseUrl;
});

/* ──────────────────────────────── the stream ─────────────────────────── */

function hydrate(snapshot) {
  const settings = snapshot.settings || {};
  if (settings.host) $('host').value = settings.host;
  if (settings.port) $('mcport').value = settings.port;
  if (settings.username) $('username').value = settings.username;
  if (settings.goal) {
    $('goalInput').value = settings.goal;
    $('goal').textContent = settings.goal;
  }
  if (settings.provider) {
    $('provider').value = settings.provider;
    $('model').value = settings.model || $('model').value;
    $('baseurl').value = settings.baseUrl || $('baseurl').value;
  }
  state.running = Boolean(snapshot.running);
  syncButtons();

  for (const event of snapshot.recent || []) renderEvent(event);
  if (snapshot.lastWorld) renderWorld(snapshot.lastWorld);
  state.hydrated = true;
}

const stream = new EventSource('/api/events');

stream.addEventListener('message', (message) => {
  let payload;
  try {
    payload = JSON.parse(message.data);
  } catch {
    return;
  }
  // The opening frame is a snapshot, identified by its own shape.
  if (!state.hydrated && Array.isArray(payload.recent)) {
    hydrate(payload);
    return;
  }
  renderEvent(payload);
});

stream.addEventListener('open', () => {
  if (!state.hydrated) setConnection('connected', 'live');
});

stream.addEventListener('error', () => {
  if (!state.hydrated) setConnection('reconnecting', 'idle');
});

syncButtons();