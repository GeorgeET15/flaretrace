function getSessionId() {
  let id = sessionStorage.getItem('session_id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('session_id', id);
  }
  return id;
}

const messagesEl     = document.getElementById('messages');
const chatForm       = document.getElementById('chat-form');
const inputEl        = document.getElementById('message-input');
const sendBtn        = document.getElementById('send-btn');
const errorEl        = document.getElementById('error-banner');
const incidentBodyEl = document.getElementById('incident-body');
const newIncidentBtn = document.getElementById('new-incident-btn');

let currentIncident = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime() {
  return new Date().toLocaleTimeString('en', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function incidentHasData(incident) {
  if (!incident) return false;
  const c = incident.connectivity;
  const hasConnInfo = c && (
    c.gateway.status    !== 'unknown' ||
    c.internetIp.status !== 'unknown' ||
    c.dns.status        !== 'unknown'
  );
  return hasConnInfo
    || (incident.testsPerformed && incident.testsPerformed.length > 0)
    || (incident.hypotheses     && incident.hypotheses.length     > 0)
    || incident.nextStep;
}

// ── Session persistence ───────────────────────────────────────────────────────

function getSavedSessions() {
  try { return JSON.parse(localStorage.getItem('ft_sessions') || '[]'); } catch { return []; }
}

function saveSessions(list) {
  try { localStorage.setItem('ft_sessions', JSON.stringify(list)); } catch {}
}

function ensureSessionSaved(id) {
  const list = getSavedSessions();
  if (list.find(s => s.id === id)) return;
  list.unshift({ id, createdAt: Date.now() });
  if (list.length > 40) list.splice(40);
  saveSessions(list);
}

function formatSessionLabel(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === now.toDateString()
    ? time
    : d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' · ' + time;
}

function renderSessionsList() {
  const list      = getSavedSessions();
  const currentId = getSessionId();
  const ul        = document.getElementById('sessions-list');
  while (ul.lastChild) ul.removeChild(ul.lastChild);

  if (list.length > 0) {
    const lbl = document.createElement('li');
    lbl.className = 'sessions-section-label';
    lbl.setAttribute('aria-hidden', 'true');
    lbl.textContent = 'Recent';
    ul.appendChild(lbl);
  }

  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.id === currentId ? ' active' : '');

    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    iconSvg.setAttribute('class', 'session-item__icon');
    iconSvg.setAttribute('width', '14');
    iconSvg.setAttribute('height', '14');
    iconSvg.setAttribute('viewBox', '0 0 14 14');
    iconSvg.setAttribute('fill', 'none');
    iconSvg.setAttribute('aria-hidden', 'true');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute('d', 'M7 1C3.686 1 1 3.238 1 6c0 1.41.638 2.677 1.664 3.582C2.52 10.7 2 12 2 12s1.56-.44 2.7-1.148A7.16 7.16 0 0 0 7 11c3.314 0 6-2.238 6-5s-2.686-5-6-5z');
    iconPath.setAttribute('stroke', 'currentColor');
    iconPath.setAttribute('stroke-width', '1.1');
    iconPath.setAttribute('stroke-linejoin', 'round');
    iconSvg.appendChild(iconPath);

    const label = document.createElement('span');
    label.className = 'session-item__label';
    label.textContent = formatSessionLabel(s.createdAt);

    const del = document.createElement('button');
    del.className = 'session-item__del';
    del.setAttribute('aria-label', 'Delete session');
    del.setAttribute('title', 'Delete session');
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.id); });

    li.appendChild(iconSvg);
    li.appendChild(label);
    li.appendChild(del);
    li.addEventListener('click', () => { if (s.id !== getSessionId()) switchSession(s.id); });
    ul.appendChild(li);
  }
}

function deleteSession(id) {
  const updated = getSavedSessions().filter(s => s.id !== id);
  saveSessions(updated);

  if (id === getSessionId()) {
    if (updated.length > 0) {
      switchSession(updated[0].id);
    } else {
      newIncident();
    }
  } else {
    renderSessionsList();
  }
}

async function switchSession(id) {
  sessionStorage.setItem('session_id', id);
  while (messagesEl.lastChild) messagesEl.removeChild(messagesEl.lastChild);
  resetIncidentPanel();
  renderSessionsList();
  await loadHistory();
  inputEl.focus();
}

// ── Sidebar toggles ───────────────────────────────────────────────────────────

function initSidebars() {
  const sessionsPanel   = document.getElementById('sessions-panel');
  const inspectorPanel  = document.getElementById('incident-panel');

  if (localStorage.getItem('ft_sessions_collapsed')  === 'true') sessionsPanel.classList.add('collapsed');
  if (localStorage.getItem('ft_inspector_collapsed') === 'true') inspectorPanel.classList.add('collapsed');

  document.getElementById('toggle-sessions-btn').addEventListener('click', () => {
    const c = sessionsPanel.classList.toggle('collapsed');
    localStorage.setItem('ft_sessions_collapsed', String(c));
  });

  document.getElementById('toggle-inspector-btn').addEventListener('click', () => {
    const c = inspectorPanel.classList.toggle('collapsed');
    localStorage.setItem('ft_inspector_collapsed', String(c));
  });
}

// ── Theme toggle ──────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('ft_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);

  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ft_theme', next);
  });
}

// ── Chat UI ───────────────────────────────────────────────────────────────────

function buildMessageContent(text) {
  const fragment = document.createDocumentFragment();
  const parts = text.split(/(```[\w]*\n?[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      const pre = document.createElement('pre');
      pre.className = 'message__code-block';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'message__code-copy';
      copyBtn.textContent = 'copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = 'copied';
          setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
        }).catch(() => {});
      });
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      pre.appendChild(copyBtn);
      pre.appendChild(codeEl);
      fragment.appendChild(pre);
    } else if (part) {
      const span = document.createElement('span');
      span.textContent = part;
      fragment.appendChild(span);
    }
  }
  return fragment;
}

function appendMessage(role, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `message message--${role}`;

  const frame = document.createElement('div');
  frame.className = 'message__frame';
  const arrow = document.createElement('span');
  arrow.className = 'message__frame-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = role === 'user' ? '→' : '←';
  const meta = document.createElement('span');
  meta.textContent = `${role === 'user' ? 'you' : 'clara'} · ${formatTime()}`;
  frame.appendChild(arrow);
  frame.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'message__body';
  body.appendChild(buildMessageContent(text));

  wrapper.appendChild(frame);
  wrapper.appendChild(body);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendWelcomeMessage() {
  const wrapper = document.createElement('div');
  wrapper.id = 'welcome-message';
  wrapper.className = 'message message--assistant';

  const frame = document.createElement('div');
  frame.className = 'message__frame';
  const arrow = document.createElement('span');
  arrow.className = 'message__frame-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '←';
  const meta = document.createElement('span');
  meta.textContent = 'clara · ready';
  frame.appendChild(arrow);
  frame.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'message__body';
  body.innerHTML = 'Hi, I\'m Clara. Describe the network problem you\'re seeing and I\'ll work through it with you step by step. You can paste output from commands like <code>ping</code>, <code>traceroute</code>, <code>ipconfig</code>, or <code>nslookup</code> at any point.';

  wrapper.appendChild(frame);
  wrapper.appendChild(body);
  messagesEl.appendChild(wrapper);
}

function showLoading() {
  const el = document.createElement('div');
  el.id = 'loading-msg';
  el.className = 'message message--assistant message--loading';

  const frame = document.createElement('div');
  frame.className = 'message__frame';
  const arrow = document.createElement('span');
  arrow.className = 'message__frame-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '←';
  const meta = document.createElement('span');
  meta.textContent = `clara · ${formatTime()}`;
  frame.appendChild(arrow);
  frame.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'message__body';
  const dots = document.createElement('span');
  dots.className = 'loading-dots';
  dots.setAttribute('aria-label', 'Thinking');
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
  body.appendChild(dots);

  el.appendChild(frame);
  el.appendChild(body);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideLoading() {
  document.getElementById('loading-msg')?.remove();
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  setTimeout(() => { errorEl.hidden = true; }, 6000);
}

// ── Incident inspector ────────────────────────────────────────────────────────

function renderIncident(incident) {
  if (!incident) return;
  currentIncident = incident;

  while (incidentBodyEl.lastChild) incidentBodyEl.removeChild(incidentBodyEl.lastChild);

  const badge = document.createElement('span');
  badge.className = `incident-status incident-status--${incident.status}`;
  badge.textContent = incident.status.toUpperCase();
  incidentBodyEl.appendChild(badge);

  if (incident.connectivity) {
    const c = incident.connectivity;
    const section = makeSection('Connectivity');
    const list = document.createElement('ul');
    list.className = 'conn-list';
    addConnRow(list, 'Gateway',  c.gateway.address,    c.gateway.status,    'reach');
    addConnRow(list, 'Internet', c.internetIp.address, c.internetIp.status, 'reach');
    addConnRow(list, 'DNS',      null,                 c.dns.status,        'dns');
    section.appendChild(list);
    incidentBodyEl.appendChild(section);
  }

  if (incident.testsPerformed && incident.testsPerformed.length > 0) {
    const section = makeSection('Tests Run');
    const list = document.createElement('ul');
    list.className = 'incident-section__list';
    for (const t of incident.testsPerformed) {
      const li = document.createElement('li');
      li.textContent = `${t.type}${t.target ? ' ' + t.target : ''} - ${t.summary}`;
      list.appendChild(li);
    }
    section.appendChild(list);
    incidentBodyEl.appendChild(section);
  }

  if (incident.observations && incident.observations.length > 0) addSection('Observations', incident.observations, 'observations');
  if (incident.hypotheses    && incident.hypotheses.length    > 0) addSection('Possible Causes', incident.hypotheses, 'causes');

  if (incident.nextStep) {
    const ns    = document.createElement('div');
    ns.className = 'incident-next-step-section';
    const lbl   = document.createElement('p');
    lbl.className = 'incident-next-step-label';
    lbl.textContent = 'Next Step';
    const box   = document.createElement('p');
    box.className = 'incident-next-step';
    box.textContent = incident.nextStep;
    ns.appendChild(lbl);
    ns.appendChild(box);
    incidentBodyEl.appendChild(ns);
  }

  if (incidentHasData(incident)) {
    const btn = document.createElement('button');
    btn.className = 'incident-summary-btn';
    btn.setAttribute('aria-label', 'Generate incident summary');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '11'); icon.setAttribute('height', '11');
    icon.setAttribute('viewBox', '0 0 12 12'); icon.setAttribute('fill', 'none');
    icon.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M1 2.5h10M1 5.5h7M1 8.5h9');
    p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.3');
    p.setAttribute('stroke-linecap', 'round');
    icon.appendChild(p);
    const lbl = document.createElement('span');
    lbl.textContent = 'Generate Summary';
    btn.appendChild(icon); btn.appendChild(lbl);
    btn.addEventListener('click', () => generateSummary(btn, lbl));
    incidentBodyEl.appendChild(btn);
  }
}

function addConnRow(list, label, address, status, kind) {
  const li  = document.createElement('li');
  li.className = `conn-row conn-row--${status}`;
  const sym = document.createElement('span');
  sym.className = 'conn-sym';
  sym.setAttribute('aria-hidden', 'true');
  sym.textContent = kind === 'dns'
    ? (status === 'working' ? '✓' : status === 'failing' ? '✗' : '?')
    : (status === 'reachable' ? '✓' : status === 'unreachable' ? '✗' : '?');
  const labelEl = document.createElement('span');
  labelEl.className = 'conn-label';
  labelEl.textContent = address ? `${label} (${address})` : label;
  const valEl = document.createElement('span');
  valEl.className = 'conn-val';
  valEl.textContent = status;
  li.appendChild(sym);
  li.appendChild(labelEl);
  li.appendChild(valEl);
  list.appendChild(li);
}

function makeSection(title) {
  const section = document.createElement('div');
  section.className = 'incident-section';
  const lbl = document.createElement('p');
  lbl.className = 'incident-section__label';
  lbl.textContent = title;
  section.appendChild(lbl);
  return section;
}

function addSection(title, items, key) {
  if (!items || items.length === 0) return;
  const section = makeSection(title);
  section.classList.add(`incident-section--${key}`);
  const list = document.createElement('ul');
  list.className = 'incident-section__list';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
  section.appendChild(list);
  incidentBodyEl.appendChild(section);
}

function resetIncidentPanel() {
  currentIncident = null;
  while (incidentBodyEl.lastChild) incidentBodyEl.removeChild(incidentBodyEl.lastChild);
  const empty = document.createElement('div');
  empty.className = 'incident-empty';
  empty.textContent = '// no incident · send a message to begin';
  incidentBodyEl.appendChild(empty);
}

// ── Session controls ──────────────────────────────────────────────────────────

function newIncident() {
  const newId = crypto.randomUUID();
  sessionStorage.setItem('session_id', newId);
  ensureSessionSaved(newId);
  while (messagesEl.lastChild) messagesEl.removeChild(messagesEl.lastChild);
  appendWelcomeMessage();
  resetIncidentPanel();
  renderSessionsList();
  inputEl.focus();
}

async function generateSummary(btn, lbl) {
  if (!incidentHasData(currentIncident)) return;
  btn.disabled = true;
  lbl.textContent = '…';
  try {
    const res = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getSessionId() }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    if (data.summary) appendMessage('assistant', data.summary);
  } catch (err) {
    showError(err.message || 'Could not generate summary.');
  } finally {
    btn.disabled = false;
    lbl.textContent = 'Generate Summary';
  }
}

// ── History / load ────────────────────────────────────────────────────────────

async function loadHistory() {
  const sessionId = getSessionId();
  ensureSessionSaved(sessionId);
  renderSessionsList();

  try {
    const res = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const data = await res.json();

    if (!data.messages || data.messages.length === 0) {
      if (!document.getElementById('welcome-message')) appendWelcomeMessage();
      return;
    }

    document.getElementById('welcome-message')?.remove();
    for (const msg of data.messages) {
      appendMessage(msg.role === 'user' ? 'user' : 'assistant', msg.content);
    }
    if (data.incident) renderIncident(data.incident);

  } catch {
    if (!document.getElementById('welcome-message')) appendWelcomeMessage();
  }
}

// ── Network request ───────────────────────────────────────────────────────────

async function sendMessage(text) {
  sendBtn.disabled = true;
  inputEl.disabled = true;
  errorEl.hidden   = true;

  appendMessage('user', text);
  showLoading();

  try {
    const res = await fetch('/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: text, sessionId: getSessionId() }),
    });
    hideLoading();
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }
    const data = await res.json();
    appendMessage('assistant', data.message);
    if (data.incident) renderIncident(data.incident);
  } catch (err) {
    hideLoading();
    showError(err.message || 'Request failed. Check your connection and try again.');
  } finally {
    sendBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  sendMessage(text);
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

newIncidentBtn?.addEventListener('click', () => newIncident());

// ── Initialise ────────────────────────────────────────────────────────────────

initTheme();
initSidebars();
loadHistory();
inputEl.focus();
