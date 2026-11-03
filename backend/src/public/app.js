const state = {
  tokens: {},
  qr: null,
  qrExpiresAt: 0,
  qrRefreshAt: 0,
  qrIntervalSeconds: 10,
  qrRefreshing: false,
  venue: null,
  currentView: 'overview'
};

const users = [
  'host-demo', 'reviewer-demo', 'demo-honest', 'demo-accuracy', 'demo-mock',
  'demo-far', 'demo-emulator', 'demo-root'
];

const scenarioUsers = {
  honest: 'demo-honest',
  accuracy: 'demo-accuracy',
  mock: 'demo-mock',
  far: 'demo-far',
  emulator: 'demo-emulator',
  root: 'demo-root'
};

const actionLabels = {
  QR_ISSUED: 'Выдан динамический QR',
  ATTENDANCE_EVALUATED: 'Проверена отметка',
  ATTENDANCE_REVIEWED: 'Ручное решение',
  VENUE_RULES_UPDATED: 'Изменены правила места проведения',
  APP_ATTEST_KEY_REGISTERED: 'Зарегистрирован App Attest'
};

const pageLabels = {
  overview: 'Центр контроля', host: 'QR ведущего', participant: 'Отметка участника',
  review: 'Ручная проверка', settings: 'Параметры места', audit: 'Журнал безопасности'
};

function el(id) { return document.getElementById(id); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function formatTime(value) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}
function initials(value) {
  return String(value ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}
function showToast(message, error = false) {
  const toast = el('toast');
  toast.textContent = message;
  toast.className = `toast visible${error ? ' error' : ''}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.className = 'toast'; }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.code = data?.error?.code;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

function auth(userId) { return { authorization: `Bearer ${state.tokens[userId]}` }; }

async function loginDemoUsers() {
  await Promise.all(users.map(async (userId) => {
    const result = await api('/api/v1/demo/token', { method: 'POST', body: JSON.stringify({ userId }) });
    state.tokens[userId] = result.token;
  }));
}

function navigate(view, updateHash = true) {
  if (!pageLabels[view]) view = 'overview';
  state.currentView = view;
  document.querySelectorAll('.view').forEach((node) => node.classList.toggle('active', node.id === `view-${view}`));
  document.querySelectorAll('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
  el('page-name').textContent = pageLabels[view];
  document.querySelector('.sidebar').classList.remove('open');
  if (updateHash && window.location.hash !== `#${view}`) window.history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'overview') void loadOverview();
  if (view === 'host') void ensureQr(true);
  if (view === 'review') void loadQueue();
  if (view === 'settings') void loadVenue();
  if (view === 'audit') void loadAudit();
}

async function ensureQr(force = false) {
  if (state.qrRefreshing) return;
  const now = Date.now();
  if (!force && state.qr && state.qrExpiresAt - now > 2500 && state.qrRefreshAt - now > 300) return;
  state.qrRefreshing = true;
  try {
    const venue = state.venue || { latitude: 43.238293, longitude: 76.945465 };
    const result = await api('/api/v1/sessions/session-live/qr', {
      method: 'POST', headers: auth('host-demo'), body: JSON.stringify({
        latitude: Number(venue.latitude), longitude: Number(venue.longitude), accuracyM: 7,
        recordedAt: new Date().toISOString(), isMocked: false
      })
    });
    state.qr = result.token;
    state.qrExpiresAt = Date.parse(result.expiresAt);
    state.qrRefreshAt = Date.parse(result.refreshAt);
    state.qrIntervalSeconds = result.intervalSeconds;
    el('qr-box').innerHTML = result.qrSvg;
  } catch (error) {
    el('qr-box').innerHTML = `<div class="qr-placeholder"><span>!</span><small>${escapeHtml(error.message)}</small></div>`;
    showToast(error.message, true);
  } finally {
    state.qrRefreshing = false;
  }
}

function updateCountdown() {
  const remaining = Math.max(0, state.qrRefreshAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  el('countdown-value').textContent = state.qr ? `${seconds} сек` : '—';
  const ratio = Math.max(0, Math.min(1, remaining / (state.qrIntervalSeconds * 1000)));
  el('countdown-bar').style.width = `${ratio * 100}%`;
  if (state.qr && remaining <= 0) void ensureQr(true);
}

async function loadOverview() {
  try {
    const result = await api('/api/v1/admin/overview', { headers: auth('reviewer-demo') });
    el('metric-accepted').textContent = result.counts.accepted;
    el('metric-suspicious').textContent = result.counts.suspicious;
    el('metric-rejected').textContent = result.counts.rejected;
    el('recent-list').innerHTML = result.recent.length ? result.recent.map((item) => `
      <div class="recent-item">
        <div class="recent-avatar">${escapeHtml(initials(item.participant_name))}</div>
        <div class="recent-copy"><strong>${escapeHtml(item.participant_name)}</strong><small>${escapeHtml(item.session_title)} · ${escapeHtml(formatTime(item.marked_at))}</small></div>
        <span class="status-badge ${escapeHtml(item.status)}">${item.status === 'accepted' ? 'Принято' : item.status === 'suspicious' ? 'Проверка' : 'Отклонено'}</span>
      </div>`).join('') : '<div class="empty-inline">Проведите первую отметку в демо</div>';
  } catch (error) { showToast(error.message, true); }
}

function selectedScenario() {
  return document.querySelector('input[name="scenario"]:checked')?.value || 'honest';
}

async function runCheckIn() {
  const button = el('scan-button');
  button.disabled = true;
  button.textContent = 'Проверяем на сервере…';
  try {
    await ensureQr(false);
    const scenario = selectedScenario();
    const userId = scenarioUsers[scenario];
    const installationIdHash = ({ honest: '1', accuracy: '2', mock: '3', far: '4', emulator: '5', root: '6' }[scenario]).repeat(64);
    const challenge = await api('/api/v1/integrity/challenge', {
      method: 'POST', headers: auth(userId), body: JSON.stringify({
        sessionId: 'session-live', installationIdHash, platform: 'web-demo'
      })
    });
    const location = {
      latitude: scenario === 'far' ? 43.35 : 43.238293,
      longitude: scenario === 'far' ? 76.70 : 76.945465,
      accuracyM: scenario === 'accuracy' ? 140 : 8,
      recordedAt: new Date().toISOString(),
      isMocked: scenario === 'mock'
    };
    const device = {
      installationIdHash, platform: 'web-demo',
      isEmulator: scenario === 'emulator', isRooted: scenario === 'root', isJailbroken: false
    };
    const result = await api('/api/v1/attendance/check-in', {
      method: 'POST', headers: auth(userId), body: JSON.stringify({
        qrToken: state.qr, location, device,
        integrity: { provider: 'demo', challenge: challenge.challenge, token: `DEMO_VALID:${challenge.challenge}` }
      })
    });
    renderResult(result.attendance || result.result);
    await Promise.all([loadOverview(), updateQueueBadge()]);
  } catch (error) {
    if (error.details?.reasons) renderResult({ status: 'rejected', reasons: error.details.reasons, riskScore: 100 });
    else showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Сканировать текущий QR';
  }
}

function renderResult(result) {
  const status = result.status;
  const config = {
    accepted: { icon: 'check', title: result.idempotent ? 'Отметка уже существует' : 'Отметка принята', copy: 'Сервер подтвердил QR, время, место и устройство.' },
    suspicious: { icon: 'accuracy', title: 'Требуется ручная проверка', copy: 'Отметка сохранена вместе с причинами и доступна ведущему и администратору.' },
    rejected: { icon: 'close', title: 'Отметка отклонена', copy: 'Сервер зафиксировал попытку и указал причины отказа.' }
  }[status];
  const icon = el('result-icon');
  icon.innerHTML = `<svg class="result-svg" aria-hidden="true"><use href="/icons.svg#${config.icon}"></use></svg>`;
  icon.style.background = status === 'accepted' ? '#e5fbdc' : status === 'suspicious' ? '#fff0ce' : '#ffe2df';
  icon.style.color = status === 'accepted' ? '#1f9d68' : status === 'suspicious' ? '#d68a1e' : '#e2524a';
  el('result-title').textContent = config.title;
  el('result-copy').textContent = config.copy;
  el('result-reasons').innerHTML = (result.reasons || []).map((item) => `
    <div class="result-reason"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div>
  `).join('') || '<div class="result-reason"><strong>Все проверки пройдены</strong><small>QR, расписание, геолокация и устройство подтверждены.</small></div>';
  el('scan-screen').classList.add('hidden');
  el('result-screen').classList.remove('hidden');
}

function resetScanner() {
  el('scan-screen').classList.remove('hidden');
  el('result-screen').classList.add('hidden');
}

async function loadQueue() {
  try {
    const result = await api('/api/v1/review/queue', { headers: auth('reviewer-demo') });
    const queue = el('review-queue');
    if (!result.items.length) {
      queue.innerHTML = '<div class="empty-state"><div><svg class="empty-icon"><use href="/icons.svg#check"></use></svg></div><h3>Подозрительных отметок нет</h3><p>Для проверки интерфейса выберите сценарий со слабым GPS или root.</p></div>';
    } else {
      queue.innerHTML = result.items.map((item) => `
        <article class="review-card">
          <div class="review-person"><div class="recent-avatar">${escapeHtml(initials(item.participant_name))}</div><div><strong>${escapeHtml(item.participant_name)}</strong><small>${escapeHtml(item.session_title)} · ${escapeHtml(formatTime(item.marked_at))}</small></div></div>
          <div><div class="reason-tags">${item.reasons.map((reason) => `<span class="reason-tag">${escapeHtml(reason.title)}</span>`).join('')}</div><div class="review-score">Оценка риска: ${escapeHtml(item.risk_score)} / 100 · ${escapeHtml(item.venue_name)}</div></div>
          <div class="review-actions"><button class="decision-button reject" data-review="reject" data-id="${escapeHtml(item.id)}" title="Отклонить"><svg class="ui-icon"><use href="/icons.svg#close"></use></svg></button><button class="decision-button accept" data-review="accept" data-id="${escapeHtml(item.id)}" title="Принять"><svg class="ui-icon"><use href="/icons.svg#check"></use></svg></button></div>
        </article>`).join('');
    }
    updateQueueBadge(result.items.length);
  } catch (error) { showToast(error.message, true); }
}

async function reviewAttendance(id, decision) {
  const fallback = decision === 'accept' ? 'Подтверждено проверяющим по данным ведущего' : 'Отклонено после ручной проверки доказательств';
  const note = window.prompt('Комментарий попадёт в неизменяемую историю:', fallback);
  if (!note) return;
  try {
    await api(`/api/v1/review/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: auth('reviewer-demo'), body: JSON.stringify({ decision, note })
    });
    showToast(decision === 'accept' ? 'Отметка подтверждена' : 'Отметка отклонена');
    await Promise.all([loadQueue(), loadOverview()]);
  } catch (error) { showToast(error.message, true); }
}

async function updateQueueBadge(value) {
  let count = value;
  if (typeof count !== 'number') {
    try { count = (await api('/api/v1/review/queue', { headers: auth('reviewer-demo') })).items.length; }
    catch { return; }
  }
  const badge = el('queue-badge');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

async function loadVenue() {
  try {
    const result = await api('/api/v1/admin/venues', { headers: auth('reviewer-demo') });
    state.venue = result.items[0];
    const form = el('venue-form');
    const values = {
      name: state.venue.name, address: state.venue.address, latitude: state.venue.latitude,
      longitude: state.venue.longitude, radiusM: state.venue.radius_m, hostRadiusM: state.venue.host_radius_m,
      qrIntervalS: state.venue.qr_interval_s, qrTtlS: state.venue.qr_ttl_s,
      checkinBeforeMin: state.venue.checkin_before_min, checkinAfterMin: state.venue.checkin_after_min,
      gpsAccuracyWarnM: state.venue.gps_accuracy_warn_m, timezone: state.venue.timezone
    };
    Object.entries(values).forEach(([name, value]) => { if (form.elements[name]) form.elements[name].value = value; });
    el('map-radius').textContent = `${state.venue.radius_m} м`;
    el('map-coordinates').textContent = `${Number(state.venue.latitude).toFixed(6)}, ${Number(state.venue.longitude).toFixed(6)}`;
  } catch (error) { showToast(error.message, true); }
}

async function saveVenue(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const numeric = ['latitude', 'longitude', 'radiusM', 'hostRadiusM', 'qrIntervalS', 'qrTtlS', 'checkinBeforeMin', 'checkinAfterMin', 'gpsAccuracyWarnM'];
  const payload = Object.fromEntries(data.entries());
  numeric.forEach((key) => { payload[key] = Number(payload[key]); });
  el('settings-state').textContent = 'Сохраняем…';
  try {
    state.venue = await api('/api/v1/admin/venues/venue-main', {
      method: 'PATCH', headers: auth('reviewer-demo'), body: JSON.stringify(payload)
    });
    el('settings-state').textContent = 'Сохранено';
    el('map-radius').textContent = `${state.venue.radius_m} м`;
    showToast('Параметры места проведения обновлены');
  } catch (error) {
    el('settings-state').textContent = 'Ошибка';
    showToast(error.message, true);
  }
}

async function loadAudit() {
  try {
    const result = await api('/api/v1/admin/audit?limit=80', { headers: auth('reviewer-demo') });
    el('audit-list').innerHTML = result.items.length ? result.items.map((item) => `
      <div class="audit-row"><time>${escapeHtml(formatTime(item.created_at))}<br>${escapeHtml(new Date(item.created_at).toLocaleDateString('ru-RU'))}</time><span class="audit-action">${escapeHtml(actionLabels[item.action] || item.action)}</span><span class="audit-entity">${escapeHtml(item.entity_type)} · ${escapeHtml(item.entity_id)}</span><span class="audit-actor"><i>${escapeHtml(initials(item.actor_name || 'Сервер'))}</i>${escapeHtml(item.actor_name || 'Сервер')}</span></div>
    `).join('') : '<div class="empty-inline">Событий пока нет</div>';
  } catch (error) { showToast(error.message, true); }
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
  document.querySelectorAll('.scenario').forEach((label) => label.addEventListener('click', () => {
    document.querySelectorAll('.scenario').forEach((node) => node.classList.remove('active'));
    label.classList.add('active');
    resetScanner();
  }));
  el('scan-button').addEventListener('click', runCheckIn);
  el('scan-again').addEventListener('click', resetScanner);
  el('refresh-queue').addEventListener('click', loadQueue);
  el('venue-form').addEventListener('submit', saveVenue);
  el('venue-form').elements.radiusM.addEventListener('input', (event) => { el('map-radius').textContent = `${event.target.value} м`; });
  el('review-queue').addEventListener('click', (event) => {
    const button = event.target.closest('[data-review]');
    if (button) void reviewAttendance(button.dataset.id, button.dataset.review);
  });
  el('menu-toggle').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
}

async function init() {
  bindEvents();
  try {
    await loginDemoUsers();
    await loadVenue();
    await ensureQr(true);
    await Promise.all([loadOverview(), updateQueueBadge()]);
    const requestedView = window.location.hash.slice(1);
    if (pageLabels[requestedView] && requestedView !== 'overview') navigate(requestedView, false);
    window.setInterval(updateCountdown, 200);
    window.setInterval(() => { if (state.qr && Date.now() >= state.qrRefreshAt) void ensureQr(true); }, 1000);
  } catch (error) {
    showToast(`Демо не запущено: ${error.message}`, true);
  }
}

void init();
