'use strict';

const CATS = ['Пиво', 'Лимонады', 'Минеральная вода', 'Соки', 'Варенье и джемы'];

// Примерные нормы — пользователь должен сверить с ТУ/ГОСТ
const DEFAULT_NORMS = [
  { cat: 'Пиво', param: 'Спирт', min: 4.0, max: 5.5, unit: '% об.' },
  { cat: 'Пиво', param: 'Экстрактивность начального сусла', min: 11, max: 13, unit: '%' },
  { cat: 'Пиво', param: 'Диоксид углерода', min: 0.40, max: 0.55, unit: '% масс.' },
  { cat: 'Пиво', param: 'pH', min: 4.0, max: 4.6, unit: '' },
  { cat: 'Пиво', param: 'Цвет', min: 0.4, max: 2.0, unit: 'ц.ед.' },
  { cat: 'Лимонады', param: 'Сухие вещества', min: 6, max: 12, unit: '%' },
  { cat: 'Лимонады', param: 'Диоксид углерода', min: 0.30, max: 0.50, unit: '% масс.' },
  { cat: 'Лимонады', param: 'Кислотность', min: 1.5, max: 4.0, unit: 'см³/100 см³' },
  { cat: 'Минеральная вода', param: 'Диоксид углерода', min: 0.20, max: 0.40, unit: '% масс.' },
  { cat: 'Минеральная вода', param: 'Минерализация', min: null, max: null, unit: 'г/дм³' },
  { cat: 'Соки', param: 'Сухие вещества', min: 10, max: null, unit: '%' },
  { cat: 'Соки', param: 'pH', min: 3.0, max: 4.0, unit: '' },
  { cat: 'Варенье и джемы', param: 'Сухие вещества', min: 60, max: null, unit: '%' },
  { cat: 'Варенье и джемы', param: 'pH', min: 2.8, max: 3.5, unit: '' },
];

const KEY = 'yerevan-production-v1';
const DIRTY_KEY = KEY + '-dirty';
const COLLS = ['prod', 'recipes', 'qc', 'norms', 'kb'];
const normId = (cat, param) => 'n-' + cat + '-' + param;

// Приводит данные любой версии к текущему формату
function migrate(d) {
  d = d || {};
  COLLS.forEach(c => { if (!Array.isArray(d[c])) d[c] = []; });
  if (!d.deleted || typeof d.deleted !== 'object') d.deleted = {};
  d.norms.forEach(n => { if (!n.id) n.id = normId(n.cat, n.param); });
  COLLS.forEach(c => d[c].forEach(r => { if (r.upd == null) r.upd = 0; }));
  // Анализы старого формата: фиксируем норму, действовавшую на момент перехода
  d.qc.forEach(r => {
    if (r.norm === undefined) {
      const n = d.norms.find(x => x.cat === r.cat && x.param === r.param);
      r.norm = n ? { min: n.min, max: n.max, unit: n.unit } : null;
    }
  });
  return d;
}

function freshDb() {
  return migrate({ norms: DEFAULT_NORMS.map(n => ({ ...n })) });
}

let db = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d) return migrate(d);
  } catch (e) { /* пусто */ }
  return freshDb();
}

// Объединение двух версий: по каждой записи побеждает более позднее изменение,
// удаления переносятся через список deleted
function merge(a, b) {
  const out = { deleted: { ...a.deleted } };
  for (const [id, t] of Object.entries(b.deleted)) out.deleted[id] = Math.max(out.deleted[id] || 0, t);
  for (const c of COLLS) {
    const m = new Map();
    for (const r of [...a[c], ...b[c]]) {
      const cur = m.get(r.id);
      if (!cur || (r.upd || 0) > (cur.upd || 0)) m.set(r.id, r);
    }
    out[c] = [...m.values()].filter(r => !(out.deleted[r.id] >= (r.upd || 0)));
  }
  return out;
}

const touch = r => { r.upd = Date.now(); return r; };

function isDirty() { try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { return false; } }
function setDirty(v) { try { v ? localStorage.setItem(DIRTY_KEY, '1') : localStorage.removeItem(DIRTY_KEY); } catch (e) { /* пусто */ } }

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { alert('Не удалось сохранить: ' + e.message); }
}
function save() {
  persist();
  setDirty(true);
  editVer++;
  renderAll();
  scheduleSync();
}

/* ---------- Синхронизация с GitHub ---------- */
const GH_KEY = 'yerevan-production-gh';
const GH_DEFAULT = { owner: 'philhovhannisyan-sudo', repo: 'Claude-projects', branch: 'main', path: 'data/production.json', token: '' };
let gh = loadGh(), syncTimer = null, syncing = false, syncAgain = false, lastSync = null, editVer = 0;

function loadGh() {
  try { return { ...GH_DEFAULT, ...JSON.parse(localStorage.getItem(GH_KEY)) }; } catch (e) { return { ...GH_DEFAULT }; }
}
const ghOn = () => !!gh.token;
const ghUrl = () => `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${gh.path}`;
const ghHeaders = () => ({ Authorization: 'Bearer ' + gh.token, Accept: 'application/vnd.github+json' });
const b64enc = s => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
const hhmm = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// state: off | ok | busy | pending | error
function status(state, text) {
  const badge = $('#syncBadge');
  const labels = {
    off: '○ Только это устройство',
    ok: '✓ Сохранено' + (lastSync ? ' ' + lastSync : ''),
    busy: '⟳ Синхронизация…',
    pending: '⏳ Есть неотправленные изменения',
    error: '⚠ Не отправлено — нажмите, чтобы повторить',
  };
  badge.textContent = labels[state];
  badge.className = 'sync sync-' + state;
  badge.title = text || '';
  $('#ghStatus').textContent = text || labels[state];
  $('#ghStatus').className = state === 'error' ? 'bad' : 'hint';
}

async function ghGet() {
  const r = await fetch(`${ghUrl()}?ref=${encodeURIComponent(gh.branch)}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
  const j = await r.json();
  return { sha: j.sha, data: migrate(JSON.parse(b64dec(j.content))) };
}

// Загрузить → объединить с локальными → при необходимости отправить.
// Локальные изменения никогда не затираются: они всегда входят в объединение.
async function sync() {
  if (!ghOn()) { status('off'); return; }
  clearTimeout(syncTimer); syncTimer = null;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  status('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ver = editVer;
      const { sha, data: remote } = await ghGet();
      const merged = remote ? merge(db, remote) : db;
      db = merged;
      persist();
      renderAll();
      const needPush = !remote || JSON.stringify(merged) !== JSON.stringify(remote);
      if (!needPush) { if (ver === editVer) setDirty(false); break; }
      const body = { message: 'Обновление данных производства', content: b64enc(JSON.stringify(merged, null, 1)), branch: gh.branch };
      if (sha) body.sha = sha;
      const r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) continue; // файл успели изменить — объединяем ещё раз
      if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
      if (ver === editVer) setDirty(false);
      break;
    }
    lastSync = hhmm();
    status(isDirty() ? 'pending' : 'ok');
  } catch (e) {
    status('error', 'Ошибка синхронизации: ' + e.message + '. Данные сохранены на этом устройстве и будут отправлены позже.');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

function scheduleSync() {
  if (!ghOn()) { status('off'); return; }
  clearTimeout(syncTimer);
  status('pending');
  syncTimer = setTimeout(sync, 1500);
}

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmt = n => (n == null || n === '' || isNaN(n)) ? '' : (+n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
// Дата по местному времени (toISOString дал бы UTC — в Ереване до 4 утра это вчера)
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => isoDate(new Date());
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d); };
const fmtDate = s => s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '';
const formData = f => Object.fromEntries(new FormData(f));
const num = v => v === '' || v == null ? null : +v;
const CAT_COLOR = { 'Пиво': '#c98a1a', 'Лимонады': '#3f9b4a', 'Минеральная вода': '#2f86c9', 'Соки': '#e0772a', 'Варенье и джемы': '#9b2f4a' };
const catTag = c => c ? `<span class="cat"><i style="background:${CAT_COLOR[c] || '#999'}"></i>${esc(c)}</span>` : '';
const normBatch = s => String(s || '').trim().toUpperCase();

/* ---------- Настройки пользователя (запоминаем последние значения) ---------- */
const PREF_KEY = 'yerevan-production-prefs';
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { /* пусто */ }
function setPref(k, v) { prefs[k] = v; try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* пусто */ } }

/* ---------- Навигация ---------- */
function go(tab) {
  $$('#tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#moreBtn').classList.toggle('active', tab === 'kb' || tab === 'data');
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === tab));
  $('#moreMenu').hidden = true;
  setPref('tab', tab);
  window.scrollTo(0, 0);
}
$$('#tabs button[data-tab]').forEach(b => b.onclick = () => go(b.dataset.tab));
$('#moreBtn').onclick = e => { e.stopPropagation(); $('#moreMenu').hidden = !$('#moreMenu').hidden; };
$$('#moreMenu [data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
document.addEventListener('click', e => { if (!e.target.closest('#moreMenu')) $('#moreMenu').hidden = true; });

// Списки направлений
$$('.catSelect').forEach(s => {
  s.innerHTML = (s.dataset.all ? '<option value="">Все направления</option>' : '') + CATS.map(c => `<option>${c}</option>`).join('');
});
$('#dashMonth').value = today().slice(0, 7);

/* ---------- Фильтр периода ---------- */
const PERIODS = [['day', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё']];
const period = { prod: prefs.period_prod || 'week', qc: prefs.period_qc || 'week' };
$$('.seg[data-period]').forEach(el => {
  const key = el.dataset.period;
  el.innerHTML = PERIODS.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('');
  const mark = () => el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === period[key]));
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    period[key] = b.dataset.v; setPref('period_' + key, b.dataset.v); mark(); renderAll();
  };
  mark();
});
function inPeriod(date, p) {
  if (p === 'day') return date === today();
  if (p === 'week') return date >= daysAgo(6);
  if (p === 'month') return date >= daysAgo(29);
  return true;
}

/* ---------- Таблицы ---------- */
function table(el, head, rows, empty = 'Нет данных') {
  el.innerHTML = `<thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr class="empty"><td colspan="${head.length}" class="hint">${empty}</td></tr>`}</tbody>`;
  // Подписи колонок для карточного вида на телефоне
  for (const tr of el.tBodies[0].rows) {
    let col = 0;
    for (const td of tr.cells) { if (td.colSpan === 1 && head[col]) td.dataset.label = head[col]; col += td.colSpan; }
  }
}
// Нажатие на строку открывает запись
function rowClicks(el, fn) {
  el.onclick = e => {
    if (e.target.closest('button, a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) fn(tr.dataset.id);
  };
}

/* ---------- Нормы и статус анализа ---------- */
const hasVal = v => v != null && v !== '';
const findNorm = (cat, param) => db.norms.find(x => x.cat === cat && x.param === param);
// Статус считается по норме, зафиксированной в записи на момент ввода
function qcStatus(r) {
  const n = r.norm;
  if (!n || (!hasVal(n.min) && !hasVal(n.max))) return { st: 'none', n };
  const bad = (hasVal(n.min) && r.value < n.min) || (hasVal(n.max) && r.value > n.max);
  return { st: bad ? 'bad' : 'ok', n };
}
const QC_LABEL = { ok: 'норма', bad: 'отклонение', none: 'нет нормы' };
const stTag = st => `<span class="st st-${st}">${QC_LABEL[st]}</span>`;
const normText = n => !n || (!hasVal(n.min) && !hasVal(n.max)) ? '—' : [hasVal(n.min) ? '≥ ' + fmt(n.min) : '', hasVal(n.max) ? '≤ ' + fmt(n.max) : ''].filter(Boolean).join(', ') + (n.unit ? ' ' + n.unit : '');
const qcOfBatch = b => db.qc.filter(q => normBatch(q.batch) === normBatch(b));
function batchQuality(b) {
  const list = qcOfBatch(b);
  if (!list.length) return '<span class="st st-none">нет анализов</span>';
  const bad = list.filter(q => qcStatus(q).st === 'bad').length;
  return bad ? `<span class="st st-bad">⚠ ${bad} откл.</span>` : `<span class="st st-ok">✓ ${list.length}</span>`;
}

/* ---------- Уведомление с отменой ---------- */
let toastTimer = null, flashId = null;
function toast(text, undo) {
  $('#toastText').textContent = text;
  $('#toastUndo').hidden = !undo;
  $('#toastUndo').onclick = () => { undo(); hideToast(); };
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 7000 : 3000);
}
function hideToast() { $('#toast').hidden = true; }

function removeRecord(coll, id, label) {
  const i = db[coll].findIndex(r => r.id === id);
  if (i < 0) return;
  const [rec] = db[coll].splice(i, 1);
  db.deleted[id] = Date.now();
  save();
  toast(label + ' удалено', () => {
    delete db.deleted[id];
    db[coll].splice(Math.min(i, db[coll].length), 0, touch(rec));
    save();
  });
}

/* ---------- Окна ---------- */
function openDlg(dlg) { dlg.showModal(); const f = dlg.querySelector('input:not([type=hidden]):not([readonly])'); if (f && matchMedia('(min-width:601px)').matches) f.focus(); }
$$('dialog').forEach(d => {
  d.querySelectorAll('[data-close]').forEach(b => b.onclick = () => d.close());
  d.addEventListener('click', e => { if (e.target === d) d.close(); }); // клик по фону
});
$$('[data-new]').forEach(b => b.onclick = () => ({ prod: () => openProd(), qc: () => openQc(), rec: () => openRec(), kb: () => openKb() })[b.dataset.new]());

/* ---------- Выпуск ---------- */
const prodForm = $('#prodForm');
function openProd(id) {
  const r = id && db.prod.find(x => x.id === id);
  prodForm.reset();
  prodForm.id.value = r ? r.id : '';
  if (r) {
    ['product', 'batch', 'cat', 'date', 'shift', 'unit', 'note'].forEach(k => prodForm[k].value = r[k] ?? '');
    prodForm.plan.value = r.plan ?? ''; prodForm.fact.value = r.fact ?? '';
  } else {
    prodForm.date.value = today();
    prodForm.cat.value = prefs.cat || CATS[0];
    prodForm.shift.value = prefs.shift || '1';
    prodForm.unit.value = prefs.unit || 'дал';
  }
  $('#prodDlgTitle').textContent = r ? `Партия ${r.batch}` : 'Новая партия';
  $('#prodSubmit').textContent = r ? 'Сохранить' : 'Добавить';
  prodForm.querySelector('[data-del]').hidden = !r;
  $('#prodQcBox').hidden = !r;
  if (r) renderProdQc(r);
  openDlg($('#prodDlg'));
}
function renderProdQc(r) {
  table($('#prodQc'), ['Дата', 'Показатель', 'Значение', 'Норма', 'Итог'],
    qcOfBatch(r.batch).sort((a, b) => b.date.localeCompare(a.date)).map(q => {
      const { st, n } = qcStatus(q);
      return `<tr class="${st === 'bad' ? 'bad' : ''}"><td>${fmtDate(q.date)}</td><td>${esc(q.param)}</td><td class="num">${fmt(q.value)}</td><td>${normText(n)}</td><td>${stTag(st)}</td></tr>`;
    }), 'Анализов по этой партии пока нет');
}
// Выбор продукта подставляет направление и единицу из рецептуры
prodForm.product.addEventListener('change', () => {
  const rec = db.recipes.find(r => r.product.toLowerCase() === prodForm.product.value.trim().toLowerCase());
  if (rec && !prodForm.id.value) { prodForm.cat.value = rec.cat; prodForm.unit.value = rec.unit; }
});
prodForm.onsubmit = e => {
  e.preventDefault();
  const d = formData(prodForm);
  const rec = touch({ ...d, id: d.id || uid(), product: d.product.trim(), batch: d.batch.trim(), plan: num(d.plan), fact: num(d.fact) });
  const i = db.prod.findIndex(x => x.id === rec.id);
  i >= 0 ? db.prod[i] = rec : db.prod.push(rec);
  setPref('cat', d.cat); setPref('shift', d.shift); setPref('unit', d.unit);
  flashId = rec.id;
  $('#prodDlg').close();
  save();
  toast(i >= 0 ? `Партия ${rec.batch} сохранена` : `Партия ${rec.batch} добавлена`);
};
prodForm.querySelector('[data-del]').onclick = () => {
  const id = prodForm.id.value, r = db.prod.find(x => x.id === id);
  $('#prodDlg').close();
  removeRecord('prod', id, `Партия ${r.batch}`);
};
$('#prodAddQc').onclick = () => {
  const b = prodForm.batch.value, c = prodForm.cat.value;
  $('#prodDlg').close();
  openQc(null, { batch: b, cat: c });
};
$('#prodFilter').onchange = $('#prodSearch').oninput = renderProd;
rowClicks($('#prodTable'), openProd);

function renderProd() {
  const cat = $('#prodFilter').value, q = $('#prodSearch').value.trim().toLowerCase();
  const list = db.prod
    .filter(r => inPeriod(r.date, period.prod) && (!cat || r.cat === cat) && (!q || (r.product + ' ' + r.batch).toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.upd || 0) - (a.upd || 0));
  $('#prodCount').textContent = list.length ? `${list.length} ${plural(list.length, 'партия', 'партии', 'партий')}` : '';
  table($('#prodTable'), ['Дата', 'Продукт', 'Партия', 'Направление', 'Смена', 'План', 'Факт', 'Выполн.', 'Качество', 'Примечание'],
    list.map(r => {
      const pct = r.plan ? r.fact / r.plan * 100 : null;
      return `<tr data-id="${r.id}" class="${r.id === flashId ? 'flash' : ''}"><td>${fmtDate(r.date)}</td><td><b>${esc(r.product)}</b></td><td>${esc(r.batch)}</td><td>${catTag(r.cat)}</td><td>${esc(r.shift)}</td>
        <td class="num">${r.plan == null ? '' : fmt(r.plan) + ' ' + esc(r.unit)}</td><td class="num">${fmt(r.fact)} ${esc(r.unit)}</td>
        <td class="num ${pct != null && pct < 95 ? 'bad' : ''}">${pct == null ? '' : fmt(pct) + '%'}</td><td>${batchQuality(r.batch)}</td><td>${esc(r.note)}</td></tr>`;
    }), emptyText(period.prod, 'Партий', '«+ Партия»'));
  const names = new Set([...db.prod.map(r => r.product), ...db.recipes.map(r => r.product)]);
  $('#productList').innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
  $('#batchList').innerHTML = [...new Map(db.prod.map(r => [normBatch(r.batch), r])).values()]
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200)
    .map(r => `<option value="${esc(r.batch)}">${esc(r.product)} · ${fmtDate(r.date)}</option>`).join('');
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
function emptyText(p, what, btn) {
  const per = { day: 'за сегодня', week: 'за неделю', month: 'за месяц', all: '' }[p];
  return `${what} ${per} нет. Нажмите ${btn}, чтобы добавить${p !== 'all' ? ', или выберите период «Всё»' : ''}.`;
}

/* ---------- Качество ---------- */
const qcForm = $('#qcForm');
function openQc(id, preset = {}) {
  const r = id && db.qc.find(x => x.id === id);
  qcForm.reset();
  qcForm.id.value = r ? r.id : '';
  if (r) ['batch', 'cat', 'param', 'date', 'who'].forEach(k => qcForm[k].value = r[k] ?? '');
  else {
    qcForm.date.value = today();
    qcForm.cat.value = preset.cat || prefs.qcCat || prefs.cat || CATS[0];
    qcForm.who.value = prefs.who || '';
    if (preset.batch) qcForm.batch.value = preset.batch;
  }
  if (r) qcForm.value.value = r.value;
  $('#qcDlgTitle').textContent = r ? `Анализ · партия ${r.batch}` : 'Новый анализ';
  $('#qcSubmit').textContent = r ? 'Сохранить' : 'Добавить';
  qcForm.querySelector('[data-del]').hidden = !r;
  fillParams(); checkBatch();
  openDlg($('#qcDlg'));
  if (preset.batch) qcForm.param.focus();
}
function fillParams() {
  const list = db.norms.filter(n => n.cat === qcForm.cat.value);
  $('#paramList').innerHTML = list.map(n => `<option value="${esc(n.param)}">`).join('');
  $('#paramHint').textContent = list.length ? '' : 'Для этого направления нет норм — впишите показатель вручную или добавьте норму в разделе «Нормы показателей».';
  showNormFor();
}
function showNormFor() {
  const p = qcForm.param.value.trim(), n = findNorm(qcForm.cat.value, p);
  let text = '';
  if (p) text = n ? 'Норма: ' + normText(n) : 'Нормы для этого показателя нет — итог будет «нет нормы».';
  if (p && n && qcForm.value.value !== '') {
    const st = qcStatus({ value: +qcForm.value.value, norm: n }).st;
    text += st === 'bad' ? '  ⚠ Значение вне нормы' : st === 'ok' ? '  ✓ В норме' : '';
  }
  $('#normHint').textContent = text;
}
// Партия из журнала выпуска подставляет направление; неизвестная — предупреждение
function checkBatch() {
  const b = normBatch(qcForm.batch.value);
  const p = b && db.prod.find(r => normBatch(r.batch) === b);
  if (p && !qcForm.id.value) { qcForm.cat.value = p.cat; }
  $('#batchHint').textContent = b && !p ? 'Такой партии нет в журнале выпуска — проверьте номер (латиница/кириллица).' : '';
}
qcForm.cat.onchange = fillParams;
qcForm.param.oninput = showNormFor;
qcForm.value.oninput = showNormFor;
qcForm.batch.addEventListener('input', () => { checkBatch(); fillParams(); });
qcForm.onsubmit = e => {
  e.preventDefault();
  const d = formData(qcForm);
  const param = d.param.trim(), old = d.id && db.qc.find(x => x.id === d.id);
  // Норма фиксируется при вводе; при правке сохраняем прежнюю, если показатель не менялся
  let norm;
  if (old && old.param === param && old.cat === d.cat) norm = old.norm;
  else { const n = findNorm(d.cat, param); norm = n ? { min: n.min, max: n.max, unit: n.unit } : null; }
  const rec = touch({ ...d, id: d.id || uid(), batch: d.batch.trim(), param, value: +d.value, norm });
  const i = db.qc.findIndex(x => x.id === rec.id);
  i >= 0 ? db.qc[i] = rec : db.qc.push(rec);
  setPref('qcCat', d.cat); setPref('who', d.who);
  flashId = rec.id;
  $('#qcDlg').close();
  save();
  const st = qcStatus(rec).st;
  toast(`${param}: ${fmt(rec.value)} — ${QC_LABEL[st]}`);
};
qcForm.querySelector('[data-del]').onclick = () => {
  const id = qcForm.id.value;
  $('#qcDlg').close();
  removeRecord('qc', id, 'Анализ');
};
$('#qcFilter').onchange = $('#qcStatusFilter').onchange = renderQc;
rowClicks($('#qcTable'), openQc);

// Нормы: нажатие на строку — правка в форме над таблицей
const normForm = $('#normForm');
let normEditId = null;
function resetNormForm() {
  normForm.reset(); normEditId = null;
  $('#normSave').textContent = 'Добавить норму'; $('#normCancel').hidden = true;
  normForm.classList.remove('editing');
}
rowClicks($('#normTable'), id => {
  const n = db.norms.find(x => x.id === id); if (!n) return;
  normEditId = id;
  ['cat', 'param', 'unit'].forEach(k => normForm[k].value = n[k] ?? '');
  normForm.min.value = n.min ?? ''; normForm.max.value = n.max ?? '';
  $('#normSave').textContent = 'Сохранить норму'; $('#normCancel').hidden = false;
  normForm.classList.add('editing');
  normForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#normCancel').onclick = resetNormForm;
$('#normTable').addEventListener('click', e => {
  const b = e.target.closest('[data-del-norm]'); if (!b) return;
  const n = db.norms.find(x => x.id === b.dataset.delNorm);
  if (normEditId === n.id) resetNormForm();
  removeRecord('norms', n.id, `Норма «${n.param}»`);
});
normForm.onsubmit = e => {
  e.preventDefault();
  const d = formData(normForm), param = d.param.trim();
  const edited = normEditId && db.norms.find(x => x.id === normEditId);
  const same = findNorm(d.cat, param);
  if (same && same !== edited && !confirm(`Норма «${param}» для «${d.cat}» уже есть. Заменить её?`)) return;
  const n = touch({ id: edited ? edited.id : same ? same.id : normId(d.cat, param), cat: d.cat, param, min: num(d.min), max: num(d.max), unit: d.unit });
  db.norms = db.norms.filter(x => x !== edited && x !== same);
  if (same && edited && same !== edited) db.deleted[same.id] = Date.now();
  db.norms.push(n);
  resetNormForm();
  save();
  toast(`Норма «${param}» сохранена`);
};

function renderQc() {
  const cat = $('#qcFilter').value, stf = $('#qcStatusFilter').value;
  const list = db.qc
    .filter(r => inPeriod(r.date, period.qc) && (!cat || r.cat === cat) && (!stf || qcStatus(r).st === stf))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.upd || 0) - (a.upd || 0));
  const bad = list.filter(r => qcStatus(r).st === 'bad').length;
  $('#qcCount').textContent = list.length ? `${list.length} ${plural(list.length, 'анализ', 'анализа', 'анализов')}${bad ? ` · ${bad} ${plural(bad, 'отклонение', 'отклонения', 'отклонений')}` : ''}` : '';
  table($('#qcTable'), ['Дата', 'Партия', 'Показатель', 'Значение', 'Норма', 'Итог', 'Направление', 'Лаборант'],
    list.map(r => {
      const { st, n } = qcStatus(r);
      return `<tr data-id="${r.id}" class="${st === 'bad' ? 'bad' : ''} ${r.id === flashId ? 'flash' : ''}"><td>${fmtDate(r.date)}</td><td><b>${esc(r.batch)}</b></td><td>${esc(r.param)}</td>
        <td class="num">${fmt(r.value)}</td><td>${normText(n)}</td><td>${stTag(st)}</td><td>${catTag(r.cat)}</td><td>${esc(r.who)}</td></tr>`;
    }), emptyText(period.qc, 'Анализов', '«+ Анализ»'));
  const norms = db.norms.slice().sort((a, b) => CATS.indexOf(a.cat) - CATS.indexOf(b.cat) || a.param.localeCompare(b.param));
  $('#normCount').textContent = `(${norms.length})`;
  table($('#normTable'), ['Направление', 'Показатель', 'Норма', ''],
    norms.map(n => `<tr data-id="${n.id}" class="${n.id === normEditId ? 'flash' : ''}"><td>${catTag(n.cat)}</td><td>${esc(n.param)}</td><td>${normText(n)}</td>
      <td><button type="button" class="icon-btn" data-del-norm="${n.id}" aria-label="Удалить норму">🗑</button></td></tr>`));
}

/* ---------- Рецептуры ---------- */
const recForm = $('#recForm');
function ingRow(i = {}) {
  const div = document.createElement('div');
  div.className = 'ing';
  div.innerHTML = `<label>Сырьё <input class="i-name" value="${esc(i.name)}" required></label>
    <label>Кол-во <input class="i-qty" type="number" step="any" min="0" inputmode="decimal" value="${i.qty ?? ''}" required></label>
    <label>Ед. <select class="i-unit">${['кг', 'г', 'л', 'шт', 'т'].map(u => `<option ${u === i.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    <label>Цена за ед. <input class="i-price" type="number" step="any" min="0" inputmode="decimal" value="${i.price ?? ''}"></label>
    <button type="button" class="icon-btn" aria-label="Убрать сырьё">🗑</button>`;
  div.querySelector('button').onclick = () => { div.remove(); recTotal(); };
  div.oninput = recTotal;
  $('#ingList').appendChild(div);
}
function readIngs() {
  return [...$('#ingList').children].map(el => ({
    name: el.querySelector('.i-name').value.trim(),
    qty: +el.querySelector('.i-qty').value,
    unit: el.querySelector('.i-unit').value,
    price: num(el.querySelector('.i-price').value),
  })).filter(i => i.name);
}
function recTotal() {
  const c = recCost({ ings: readIngs() }), base = +recForm.base.value;
  $('#recTotal').textContent = c ? `Стоимость сырья: ${fmt(c)}${base ? ` · на 1 ${recForm.unit.value}: ${fmt(c / base)}` : ''}` : '';
}
recForm.base.oninput = recForm.unit.onchange = recTotal;
$('#addIng').onclick = () => { ingRow(); $('#ingList').lastChild.querySelector('input').focus(); };
function openRec(id) {
  const r = id && db.recipes.find(x => x.id === id);
  recForm.reset();
  recForm.id.value = r ? r.id : '';
  $('#ingList').innerHTML = '';
  if (r) { ['product', 'cat', 'base', 'unit'].forEach(k => recForm[k].value = r[k]); r.ings.forEach(ingRow); }
  else { recForm.cat.value = prefs.cat || CATS[0]; ingRow(); }
  $('#recDlgTitle').textContent = r ? `Рецептура: ${r.product}` : 'Новая рецептура';
  recForm.querySelector('[data-del]').hidden = !r;
  recTotal();
  openDlg($('#recDlg'));
}
recForm.onsubmit = e => {
  e.preventDefault();
  const d = formData(recForm);
  const rec = touch({ id: d.id || uid(), product: d.product.trim(), cat: d.cat, base: +d.base, unit: d.unit, ings: readIngs() });
  const i = db.recipes.findIndex(r => r.id === rec.id);
  i >= 0 ? db.recipes[i] = rec : db.recipes.push(rec);
  flashId = rec.id;
  $('#recDlg').close();
  save();
  toast(`Рецептура «${rec.product}» сохранена`);
};
recForm.querySelector('[data-del]').onclick = () => {
  const id = recForm.id.value, r = db.recipes.find(x => x.id === id);
  $('#recDlg').close();
  removeRecord('recipes', id, `Рецептура «${r.product}»`);
};
const recCost = r => r.ings.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
rowClicks($('#recTable'), openRec);
$('#recTable').addEventListener('click', e => {
  const b = e.target.closest('[data-calc]'); if (!b) return;
  const r = db.recipes.find(x => x.id === b.dataset.calc);
  $('#calcRec').value = r.id; $('#calcVol').value = r.base;
  renderCalc();
  $('#calcCard').scrollIntoView({ behavior: 'smooth' });
  $('#calcVol').focus({ preventScroll: true });
});

function renderRec() {
  $('#recCount').textContent = db.recipes.length ? `${db.recipes.length}` : '';
  table($('#recTable'), ['Продукт', 'Направление', 'Базовый объём', 'Сырьё', 'Себест. сырья', 'На ед.', ''],
    db.recipes.slice().sort((a, b) => a.product.localeCompare(b.product)).map(r => {
      const c = recCost(r);
      return `<tr data-id="${r.id}" class="${r.id === flashId ? 'flash' : ''}"><td><b>${esc(r.product)}</b></td><td>${catTag(r.cat)}</td><td>${fmt(r.base)} ${esc(r.unit)}</td><td class="num">${r.ings.length} поз.</td>
        <td class="num">${fmt(c)}</td><td class="num">${fmt(c / r.base)} / ${esc(r.unit)}</td>
        <td><button type="button" class="btn-secondary btn-sm" data-calc="${r.id}">Рассчитать</button></td></tr>`;
    }), 'Рецептур пока нет. Нажмите «+ Рецептура», чтобы добавить.');
  const sel = $('#calcRec'), cur = sel.value;
  sel.innerHTML = '<option value="">— выберите —</option>' + db.recipes.map(r => `<option value="${r.id}">${esc(r.product)}</option>`).join('');
  sel.value = cur;
  renderCalc();
}
$('#calcRec').onchange = () => { const r = db.recipes.find(x => x.id === $('#calcRec').value); if (r) $('#calcVol').value = r.base; renderCalc(); };
$('#calcVol').oninput = renderCalc;
function renderCalc() {
  const r = db.recipes.find(x => x.id === $('#calcRec').value);
  $('#calcHint').hidden = !!r;
  if (!r) { $('#calcTable').innerHTML = ''; return; }
  const vol = +$('#calcVol').value || r.base, k = vol / r.base;
  const rows = r.ings.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${fmt(i.qty * k)} ${esc(i.unit)}</td><td class="num">${fmt(i.price)}</td><td class="num">${fmt((i.price || 0) * i.qty * k)}</td></tr>`);
  const total = recCost(r) * k;
  rows.push(`<tr class="total"><td>Итого на ${fmt(vol)} ${esc(r.unit)}</td><td></td><td></td><td class="num"><b>${fmt(total)}</b></td></tr>`);
  rows.push(`<tr class="total"><td>На 1 ${esc(r.unit)}</td><td></td><td></td><td class="num">${fmt(total / vol)}</td></tr>`);
  table($('#calcTable'), ['Сырьё', 'Количество', 'Цена', 'Сумма'], rows);
}

/* ---------- База знаний ---------- */
const kbForm = $('#kbForm');
function openKb(id) {
  const d = id && db.kb.find(x => x.id === id);
  kbForm.reset();
  ['id', 'title', 'cat', 'type', 'link', 'text'].forEach(k => kbForm[k].value = d ? d[k] || '' : '');
  if (!d) kbForm.type.selectedIndex = 0;
  $('#kbDlgTitle').textContent = d ? 'Документ' : 'Новый документ';
  kbForm.querySelector('[data-del]').hidden = !d;
  openDlg($('#kbDlg'));
}
kbForm.onsubmit = e => {
  e.preventDefault();
  const d = formData(kbForm);
  const doc = touch({ ...d, id: d.id || uid(), updated: today() });
  const i = db.kb.findIndex(x => x.id === doc.id);
  i >= 0 ? db.kb[i] = doc : db.kb.push(doc);
  flashId = doc.id;
  $('#kbDlg').close();
  save();
  toast(`Документ «${doc.title}» сохранён`);
};
kbForm.querySelector('[data-del]').onclick = () => {
  const id = kbForm.id.value, d = db.kb.find(x => x.id === id);
  $('#kbDlg').close();
  removeRecord('kb', id, `Документ «${d.title}»`);
};
$('#kbSearch').oninput = $('#kbFilter').onchange = renderKb;
$('#kbList').onclick = e => {
  if (e.target.closest('a')) return;
  const el = e.target.closest('[data-id]'); if (el) openKb(el.dataset.id);
};
function renderKb() {
  const q = $('#kbSearch').value.trim().toLowerCase(), cat = $('#kbFilter').value;
  const docs = db.kb.filter(d => (!cat || d.cat === cat) && (!q || [d.title, d.text, d.type, d.cat].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  $('#kbCount').textContent = db.kb.length ? `${db.kb.length}` : '';
  $('#kbList').innerHTML = docs.map(d => `<div class="doc ${d.id === flashId ? 'flash' : ''}" data-id="${d.id}"><h4>${esc(d.title)}</h4>
    <div class="hint">${esc(d.type)}${d.cat ? ' · ' + catTag(d.cat) : ''} · обновлено ${fmtDate(d.updated)}</div>
    ${d.link ? `<a href="${esc(d.link)}" target="_blank" rel="noopener">Открыть ссылку ↗</a>` : ''}
    ${d.text ? `<pre>${esc(d.text.length > 400 ? d.text.slice(0, 400) + '…' : d.text)}</pre>` : ''}</div>`).join('')
    || `<p class="empty-note">${db.kb.length ? 'Ничего не найдено.' : 'Документов пока нет. Нажмите «+ Документ», чтобы добавить инструкцию, ГОСТ или регламент.'}</p>`;
}

/* ---------- Сводка ---------- */
$('#dashMonth').onchange = renderDash;
function renderDash() {
  const m = $('#dashMonth').value;
  $('#kpis').innerHTML = CATS.map(c => {
    const list = db.prod.filter(r => r.cat === c && r.date.startsWith(m));
    const byUnit = {};
    list.forEach(r => { const u = byUnit[r.unit] ||= { plan: 0, fact: 0 }; u.plan += r.plan || 0; u.fact += r.fact || 0; });
    const qcBad = db.qc.filter(q => q.cat === c && q.date.startsWith(m) && qcStatus(q).st === 'bad').length;
    const lines = Object.entries(byUnit).map(([u, v]) => {
      const pct = v.plan ? v.fact / v.plan * 100 : null;
      return `<div class="kpi-val">${fmt(v.fact)} <small>${esc(u)}</small></div>
        ${pct == null ? '<div class="hint">план не задан</div>' : `<div class="bar"><i class="${pct < 95 ? 'low' : ''}" style="width:${Math.min(pct, 100)}%"></i></div>
        <div class="kpi-sub"><span class="${pct < 95 ? 'bad' : 'ok'}">${fmt(pct)}% плана</span> · план ${fmt(v.plan)}</div>`}`;
    }).join('');
    return `<button type="button" class="kpi" data-cat="${c}" style="--c:${CAT_COLOR[c]}">
      <div class="kpi-name">${esc(c)}</div>
      ${lines || '<div class="kpi-val muted">—</div><div class="hint">нет выпуска</div>'}
      <div class="kpi-foot">${list.length} ${plural(list.length, 'партия', 'партии', 'партий')}${qcBad ? ` · <span class="bad">⚠ ${qcBad} откл.</span>` : ''}</div>
    </button>`;
  }).join('');
  const bad = db.qc.filter(r => r.date.startsWith(m) && qcStatus(r).st === 'bad').sort((a, b) => b.date.localeCompare(a.date));
  $('#dashQcTitle').innerHTML = `Отклонения по качеству за месяц ${bad.length ? `<span class="st st-bad">${bad.length}</span>` : '<span class="st st-ok">нет</span>'}`;
  table($('#dashQc'), ['Дата', 'Партия', 'Показатель', 'Значение', 'Норма', 'Направление'],
    bad.slice(0, 15).map(r => `<tr class="bad"><td>${fmtDate(r.date)}</td><td><b>${esc(r.batch)}</b></td><td>${esc(r.param)}</td><td class="num">${fmt(r.value)}</td><td>${normText(r.norm)}</td><td>${catTag(r.cat)}</td></tr>`),
    'Отклонений нет');
  $('#syncBanner').hidden = ghOn() || !!prefs.bannerDismissed;
}
// Карточка направления открывает журнал выпуска с этим фильтром
$('#kpis').onclick = e => {
  const k = e.target.closest('.kpi'); if (!k) return;
  $('#prodFilter').value = k.dataset.cat; period.prod = 'month';
  $$('.seg[data-period=prod] button').forEach(b => b.classList.toggle('on', b.dataset.v === 'month'));
  go('prod'); renderProd();
};
$('#bannerGo').onclick = () => { go('data'); $('#ghForm').token.focus(); };
$('#bannerLater').onclick = () => { setPref('bannerDismissed', true); renderDash(); };

/* ---------- Данные ---------- */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
}
const csv = rows => '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');

$('#exportJson').onclick = () => download(`production-${today()}.json`, JSON.stringify(db, null, 2), 'application/json');
$('#importJson').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  f.text().then(t => {
    const d = JSON.parse(t);
    if (!d.prod || !d.norms) throw new Error('неверный формат');
    if (confirm('Добавить данные из файла к текущим? Совпадающие записи обновятся на более свежие.')) { db = merge(db, migrate(d)); save(); toast('Данные из файла добавлены'); }
  }).catch(err => alert('Ошибка загрузки: ' + err.message));
  e.target.value = '';
};
$('#exportCsv').onclick = () => download(`vypusk-${today()}.csv`, csv([
  ['Дата', 'Направление', 'Продукт', 'Партия', 'Смена', 'План', 'Факт', 'Ед.', 'Примечание'],
  ...db.prod.map(r => [fmtDate(r.date), r.cat, r.product, r.batch, r.shift, r.plan, r.fact, r.unit, r.note]),
]), 'text/csv');
$('#exportQcCsv').onclick = () => download(`analizy-${today()}.csv`, csv([
  ['Дата', 'Направление', 'Партия', 'Показатель', 'Значение', 'Норма', 'Итог', 'Лаборант'],
  ...db.qc.map(r => { const { st, n } = qcStatus(r); return [fmtDate(r.date), r.cat, r.batch, r.param, r.value, normText(n), QC_LABEL[st], r.who]; }),
]), 'text/csv');

/* ---------- Настройки GitHub ---------- */
const ghForm = $('#ghForm');
['owner', 'repo', 'branch', 'path', 'token'].forEach(k => ghForm[k].value = gh[k]);
ghForm.onsubmit = e => {
  e.preventDefault();
  gh = formData(ghForm);
  try { localStorage.setItem(GH_KEY, JSON.stringify(gh)); } catch (err) { /* пусто */ }
  if (!ghOn()) { status('off', 'Введите токен, чтобы включить синхронизацию.'); return; }
  // Локальные данные и данные на GitHub объединяются — ничего не теряется
  setDirty(true);
  sync();
  renderDash();
};
$('#ghPull').onclick = () => sync();
$('#ghOff').onclick = () => {
  if (!confirm('Отключить синхронизацию на этом устройстве? Данные останутся здесь, но перестанут отправляться на GitHub.')) return;
  gh = { ...gh, token: '' }; ghForm.token.value = '';
  try { localStorage.setItem(GH_KEY, JSON.stringify(gh)); } catch (err) { /* пусто */ }
  status('off', 'Синхронизация отключена. Данные остаются на этом устройстве.');
};
$('#syncBadge').onclick = () => { if (ghOn()) sync(); else go('data'); };

function renderAll() {
  renderDash(); renderProd(); renderRec(); renderQc(); renderKb();
  flashId = null;
}
renderAll();
if (prefs.tab && $('#' + prefs.tab)) go(prefs.tab);

// Синхронизация при открытии, при возврате в приложение, при появлении сети и раз в минуту, если есть неотправленное
if (ghOn()) sync(); else status('off');
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ghOn()) sync(); });
window.addEventListener('online', () => ghOn() && sync());
setInterval(() => { if (ghOn() && isDirty() && !syncing) sync(); }, 60000);
