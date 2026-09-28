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
let db = load();

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d) return d;
  } catch (e) { /* пусто */ }
  return { prod: [], recipes: [], qc: [], norms: DEFAULT_NORMS.slice(), kb: [] };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { alert('Не удалось сохранить: ' + e.message); }
  renderAll();
  schedulePush();
}

/* ---------- Синхронизация с GitHub ---------- */
const GH_KEY = 'yerevan-production-gh';
const GH_DEFAULT = { owner: 'philhovhannisyan-sudo', repo: 'Claude-projects', branch: 'main', path: 'data/production.json', token: '' };
let gh = loadGh(), ghSha = null, pushTimer = null, pushing = false, pushAgain = false;

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

function status(text, bad) {
  $('#ghStatus').textContent = text;
  $('#ghStatus').className = bad ? 'bad' : 'hint';
  $('#syncBadge').textContent = !ghOn() ? '' : bad ? '⚠ нет синхронизации' : '☁ ' + text;
}

async function ghPull() {
  status('загрузка…');
  const r = await fetch(`${ghUrl()}?ref=${encodeURIComponent(gh.branch)}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) { ghSha = null; status('файла ещё нет — будет создан'); return null; }
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
  const j = await r.json();
  ghSha = j.sha;
  const remote = JSON.parse(b64dec(j.content));
  db = remote;
  localStorage.setItem(KEY, JSON.stringify(db));
  renderAll();
  status('загружено ' + new Date().toLocaleTimeString('ru-RU'));
  return remote;
}

async function ghPush() {
  pushTimer = null;
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    status('сохранение…');
    const body = { message: 'Обновление данных производства', content: b64enc(JSON.stringify(db, null, 1)), branch: gh.branch };
    if (ghSha) body.sha = ghSha;
    const r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) {
      // Файл изменили с другого устройства
      status('данные изменены на другом устройстве', true);
      if (confirm('Данные на GitHub изменены с другого устройства.\nОК — загрузить их (ваше последнее изменение будет потеряно).\nОтмена — перезаписать их вашими данными.')) {
        await ghPull();
      } else {
        const cur = await fetch(`${ghUrl()}?ref=${encodeURIComponent(gh.branch)}&t=${Date.now()}`, { headers: ghHeaders(), cache: 'no-store' });
        ghSha = cur.ok ? (await cur.json()).sha : null;
        pushAgain = true;
      }
      return;
    }
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || ''}`);
    ghSha = (await r.json()).content.sha;
    status('сохранено ' + new Date().toLocaleTimeString('ru-RU'));
  } catch (e) {
    status('ошибка: ' + e.message, true);
  } finally {
    pushing = false;
    if (pushAgain) { pushAgain = false; ghPush(); }
  }
}

function schedulePush() {
  if (!ghOn()) return;
  clearTimeout(pushTimer);
  status('есть несохранённые изменения…');
  pushTimer = setTimeout(ghPush, 1500);
}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmt = n => (n == null || n === '' || isNaN(n)) ? '' : (+n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const formData = f => Object.fromEntries(new FormData(f));

// Вкладки
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button, .tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#' + b.dataset.tab).classList.add('active');
});

// Списки направлений
document.querySelectorAll('.catSelect').forEach(s => {
  s.innerHTML = (s.dataset.all ? '<option value="">Все</option>' : '') +
    CATS.map(c => `<option>${c}</option>`).join('');
});
document.querySelectorAll('input[type=date]').forEach(i => i.value = today());
$('#dashMonth').value = today().slice(0, 7);

function table(el, head, rows) {
  el.innerHTML = `<thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="hint">Нет данных</td></tr>`}</tbody>`;
}

function inNorm(cat, param, value) {
  const n = db.norms.find(x => x.cat === cat && x.param === param);
  if (!n) return { ok: true, n: null };
  const bad = (n.min != null && n.min !== '' && value < n.min) || (n.max != null && n.max !== '' && value > n.max);
  return { ok: !bad, n };
}
const normText = n => !n ? '' : [n.min != null && n.min !== '' ? '≥ ' + fmt(n.min) : '', n.max != null && n.max !== '' ? '≤ ' + fmt(n.max) : ''].filter(Boolean).join(', ') + (n.unit ? ' ' + n.unit : '');

/* ---------- Учёт выпуска ---------- */
$('#prodForm').onsubmit = e => {
  e.preventDefault();
  const d = formData(e.target);
  db.prod.push({ id: uid(), ...d, plan: d.plan === '' ? null : +d.plan, fact: +d.fact });
  e.target.reset(); e.target.date.value = today();
  save();
};
$('#prodFilter').onchange = $('#prodSearch').oninput = renderProd;

function renderProd() {
  const cat = $('#prodFilter').value, q = $('#prodSearch').value.toLowerCase();
  const rows = db.prod
    .filter(r => (!cat || r.cat === cat) && (!q || (r.product + ' ' + r.batch).toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(r => {
      const pct = r.plan ? r.fact / r.plan * 100 : null;
      return `<tr><td>${r.date}</td><td>${esc(r.cat)}</td><td>${esc(r.product)}</td><td>${esc(r.batch)}</td><td>${esc(r.shift)}</td>
        <td class="num">${fmt(r.plan)}</td><td class="num">${fmt(r.fact)}</td><td>${esc(r.unit)}</td>
        <td class="num ${pct != null && pct < 95 ? 'bad' : ''}">${pct == null ? '' : fmt(pct) + '%'}</td><td>${esc(r.note)}</td>
        <td><button class="small" onclick="del('prod','${r.id}')">✕</button></td></tr>`;
    });
  table($('#prodTable'), ['Дата', 'Направление', 'Продукт', 'Партия', 'Смена', 'План', 'Факт', 'Ед.', 'Выполн.', 'Примечание', ''], rows);
  const names = new Set([...db.prod.map(r => r.product), ...db.recipes.map(r => r.product)]);
  $('#productList').innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
}

window.del = (coll, id) => {
  if (!confirm('Удалить запись?')) return;
  db[coll] = db[coll].filter(r => r.id !== id);
  save();
};

/* ---------- Сводка ---------- */
$('#dashMonth').onchange = renderDash;
function renderDash() {
  const m = $('#dashMonth').value;
  const rows = CATS.map(c => {
    const list = db.prod.filter(r => r.cat === c && r.date.startsWith(m));
    const byUnit = {};
    list.forEach(r => {
      const u = byUnit[r.unit] ||= { plan: 0, fact: 0 };
      u.plan += r.plan || 0; u.fact += r.fact || 0;
    });
    const units = Object.entries(byUnit);
    if (!units.length) return `<tr><td>${c}</td><td class="num">0</td><td colspan="4" class="hint">—</td></tr>`;
    return units.map(([u, v], i) => {
      const pct = v.plan ? v.fact / v.plan * 100 : null;
      return `<tr>${i ? '<td></td><td></td>' : `<td rowspan="1">${c}</td><td class="num">${list.length}</td>`}
        <td class="num">${fmt(v.plan)}</td><td class="num">${fmt(v.fact)}</td><td>${u}</td>
        <td class="num ${pct != null && pct < 95 ? 'bad' : 'ok'}">${pct == null ? '' : fmt(pct) + '%'}</td></tr>`;
    }).join('');
  });
  table($('#dashTable'), ['Направление', 'Партий', 'План', 'Факт', 'Ед.', 'Выполнение'], rows);

  const bad = db.qc.filter(r => !inNorm(r.cat, r.param, r.value).ok)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
    .map(r => `<tr class="bad"><td>${r.date}</td><td>${esc(r.cat)}</td><td>${esc(r.batch)}</td><td>${esc(r.param)}</td><td class="num">${fmt(r.value)}</td><td>${normText(inNorm(r.cat, r.param, r.value).n)}</td></tr>`);
  table($('#dashQc'), ['Дата', 'Направление', 'Партия', 'Показатель', 'Значение', 'Норма'], bad);
}

/* ---------- Рецептуры ---------- */
function ingRow(i = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="i-name" value="${esc(i.name)}" required></td>
    <td><input class="i-qty" type="number" step="any" value="${i.qty ?? ''}" required></td>
    <td><select class="i-unit">${['кг', 'г', 'л', 'шт', 'т'].map(u => `<option ${u === i.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></td>
    <td><input class="i-price" type="number" step="any" value="${i.price ?? ''}"></td>
    <td><button type="button" class="small">✕</button></td>`;
  tr.querySelector('button').onclick = () => tr.remove();
  $('#ingTable tbody').appendChild(tr);
}
$('#addIng').onclick = () => ingRow();
$('#recReset').onclick = () => { $('#recForm').reset(); $('#recForm').id.value = ''; $('#ingTable tbody').innerHTML = ''; ingRow(); };
ingRow();

$('#recForm').onsubmit = e => {
  e.preventDefault();
  const d = formData(e.target);
  const ings = [...$('#ingTable tbody').rows].map(tr => ({
    name: tr.querySelector('.i-name').value.trim(),
    qty: +tr.querySelector('.i-qty').value,
    unit: tr.querySelector('.i-unit').value,
    price: tr.querySelector('.i-price').value === '' ? null : +tr.querySelector('.i-price').value,
  })).filter(i => i.name);
  const rec = { id: d.id || uid(), product: d.product, cat: d.cat, base: +d.base, unit: d.unit, ings };
  const idx = db.recipes.findIndex(r => r.id === rec.id);
  idx >= 0 ? db.recipes[idx] = rec : db.recipes.push(rec);
  $('#recReset').onclick();
  save();
};

const recCost = r => r.ings.reduce((s, i) => s + (i.price || 0) * i.qty, 0);

window.editRec = id => {
  const r = db.recipes.find(x => x.id === id), f = $('#recForm');
  f.id.value = r.id; f.product.value = r.product; f.cat.value = r.cat; f.base.value = r.base; f.unit.value = r.unit;
  $('#ingTable tbody').innerHTML = '';
  r.ings.forEach(ingRow);
  f.scrollIntoView({ behavior: 'smooth' });
};

function renderRec() {
  table($('#recTable'), ['Продукт', 'Направление', 'Базовый объём', 'Позиций сырья', 'Себест. сырья', 'На ед.', ''],
    db.recipes.map(r => {
      const c = recCost(r);
      return `<tr><td>${esc(r.product)}</td><td>${esc(r.cat)}</td><td>${fmt(r.base)} ${esc(r.unit)}</td><td class="num">${r.ings.length}</td>
        <td class="num">${fmt(c)}</td><td class="num">${fmt(c / r.base)} / ${esc(r.unit)}</td>
        <td><button class="small" onclick="editRec('${r.id}')">✎</button><button class="small" onclick="del('recipes','${r.id}')">✕</button></td></tr>`;
    }));
  const sel = $('#calcRec'), cur = sel.value;
  sel.innerHTML = '<option value="">— рецептура —</option>' + db.recipes.map(r => `<option value="${r.id}">${esc(r.product)}</option>`).join('');
  sel.value = cur;
  renderCalc();
}

$('#calcRec').onchange = $('#calcVol').oninput = renderCalc;
function renderCalc() {
  const r = db.recipes.find(x => x.id === $('#calcRec').value);
  if (!r) { $('#calcTable').innerHTML = ''; return; }
  const vol = +$('#calcVol').value || r.base, k = vol / r.base;
  const rows = r.ings.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${fmt(i.qty * k)}</td><td>${esc(i.unit)}</td><td class="num">${fmt(i.price)}</td><td class="num">${fmt((i.price || 0) * i.qty * k)}</td></tr>`);
  const total = recCost(r) * k;
  rows.push(`<tr><th colspan="4">Итого на ${fmt(vol)} ${esc(r.unit)}</th><th class="num">${fmt(total)}</th></tr>`);
  rows.push(`<tr><td colspan="4">Себестоимость сырья на 1 ${esc(r.unit)}</td><td class="num">${fmt(total / vol)}</td></tr>`);
  table($('#calcTable'), ['Сырьё', 'Кол-во', 'Ед.', 'Цена', 'Сумма'], rows);
}

/* ---------- Качество ---------- */
function fillParams() {
  const f = $('#qcForm');
  f.param.innerHTML = db.norms.filter(n => n.cat === f.cat.value).map(n => `<option>${esc(n.param)}</option>`).join('');
}
$('#qcForm').cat.onchange = fillParams;

$('#qcForm').onsubmit = e => {
  e.preventDefault();
  const d = formData(e.target);
  db.qc.push({ id: uid(), ...d, value: +d.value });
  e.target.value.value = '';
  save();
};

$('#normForm').onsubmit = e => {
  e.preventDefault();
  const d = formData(e.target);
  const n = { cat: d.cat, param: d.param.trim(), min: d.min === '' ? null : +d.min, max: d.max === '' ? null : +d.max, unit: d.unit };
  const i = db.norms.findIndex(x => x.cat === n.cat && x.param === n.param);
  i >= 0 ? db.norms[i] = n : db.norms.push(n);
  e.target.reset();
  save();
};
window.delNorm = i => { if (confirm('Удалить норму?')) { db.norms.splice(i, 1); save(); } };

function renderQc() {
  fillParams();
  table($('#qcTable'), ['Дата', 'Направление', 'Партия', 'Показатель', 'Значение', 'Норма', 'Итог', 'Лаборант', ''],
    db.qc.slice().sort((a, b) => b.date.localeCompare(a.date)).map(r => {
      const { ok, n } = inNorm(r.cat, r.param, r.value);
      return `<tr class="${ok ? '' : 'bad'}"><td>${r.date}</td><td>${esc(r.cat)}</td><td>${esc(r.batch)}</td><td>${esc(r.param)}</td>
        <td class="num">${fmt(r.value)}</td><td>${normText(n)}</td><td>${ok ? '<span class="ok">норма</span>' : 'откл.'}</td><td>${esc(r.who)}</td>
        <td><button class="small" onclick="del('qc','${r.id}')">✕</button></td></tr>`;
    }));
  table($('#normTable'), ['Направление', 'Показатель', 'Мин', 'Макс', 'Ед.', ''],
    db.norms.map((n, i) => `<tr><td>${esc(n.cat)}</td><td>${esc(n.param)}</td><td class="num">${fmt(n.min)}</td><td class="num">${fmt(n.max)}</td><td>${esc(n.unit)}</td>
      <td><button class="small" onclick="delNorm(${i})">✕</button></td></tr>`));
}

/* ---------- База знаний ---------- */
$('#kbForm').onsubmit = e => {
  e.preventDefault();
  const d = formData(e.target);
  const doc = { ...d, id: d.id || uid(), updated: today() };
  const i = db.kb.findIndex(x => x.id === doc.id);
  i >= 0 ? db.kb[i] = doc : db.kb.push(doc);
  e.target.reset(); e.target.id.value = '';
  save();
};
$('#kbSearch').oninput = renderKb;
window.editKb = id => {
  const d = db.kb.find(x => x.id === id), f = $('#kbForm');
  ['id', 'title', 'cat', 'type', 'link', 'text'].forEach(k => f[k].value = d[k] || '');
  f.scrollIntoView({ behavior: 'smooth' });
};
function renderKb() {
  const q = $('#kbSearch').value.toLowerCase();
  const docs = db.kb.filter(d => !q || [d.title, d.text, d.type, d.cat].join(' ').toLowerCase().includes(q));
  $('#kbList').innerHTML = docs.map(d => `<div class="doc"><h4>${esc(d.title)}</h4>
    <div class="hint">${esc(d.type)}${d.cat ? ' · ' + esc(d.cat) : ''} · обновлено ${d.updated}</div>
    ${d.link ? `<a href="${esc(d.link)}" target="_blank" rel="noopener">Открыть ссылку</a>` : ''}
    ${d.text ? `<pre>${esc(d.text)}</pre>` : ''}
    <button class="small" onclick="editKb('${d.id}')">✎</button><button class="small" onclick="del('kb','${d.id}')">✕</button></div>`).join('')
    || '<p class="hint">Документов пока нет</p>';
}

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
    if (confirm('Заменить текущие данные данными из файла?')) { db = d; save(); }
  }).catch(err => alert('Ошибка загрузки: ' + err.message));
  e.target.value = '';
};
$('#exportCsv').onclick = () => download(`vypusk-${today()}.csv`, csv([
  ['Дата', 'Направление', 'Продукт', 'Партия', 'Смена', 'План', 'Факт', 'Ед.', 'Примечание'],
  ...db.prod.map(r => [r.date, r.cat, r.product, r.batch, r.shift, r.plan, r.fact, r.unit, r.note]),
]), 'text/csv');
$('#exportQcCsv').onclick = () => download(`analizy-${today()}.csv`, csv([
  ['Дата', 'Направление', 'Партия', 'Показатель', 'Значение', 'Норма', 'Итог', 'Лаборант'],
  ...db.qc.map(r => { const { ok, n } = inNorm(r.cat, r.param, r.value); return [r.date, r.cat, r.batch, r.param, r.value, normText(n), ok ? 'норма' : 'отклонение', r.who]; }),
]), 'text/csv');

/* ---------- Настройки GitHub ---------- */
const ghForm = $('#ghForm');
['owner', 'repo', 'branch', 'path', 'token'].forEach(k => ghForm[k].value = gh[k]);
ghForm.onsubmit = async e => {
  e.preventDefault();
  gh = formData(ghForm);
  try { localStorage.setItem(GH_KEY, JSON.stringify(gh)); } catch (err) { /* пусто */ }
  if (!ghOn()) { status('введите токен', true); return; }
  try {
    const hasLocal = db.prod.length || db.recipes.length || db.qc.length || db.kb.length;
    const local = db;
    const remote = await ghPull();
    if (!remote && hasLocal) { db = local; await ghPush(); }
    else if (remote && hasLocal && JSON.stringify(remote) !== JSON.stringify(local) &&
      !confirm('На GitHub уже есть данные — они загружены.\nОК — оставить данные с GitHub.\nОтмена — заменить их данными из этого браузера.')) {
      db = local; save();
    }
  } catch (err) { status('ошибка: ' + err.message, true); }
};
$('#ghPull').onclick = () => ghOn() && ghPull().catch(err => status('ошибка: ' + err.message, true));
$('#ghOff').onclick = () => {
  gh = { ...gh, token: '' }; ghForm.token.value = '';
  try { localStorage.setItem(GH_KEY, JSON.stringify(gh)); } catch (err) { /* пусто */ }
  status('синхронизация отключена');
};

function renderAll() { renderDash(); renderProd(); renderRec(); renderQc(); renderKb(); }
renderAll();

// Подтягиваем свежие данные при открытии и при возврате на вкладку
if (ghOn()) ghPull().catch(err => status('ошибка: ' + err.message, true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ghOn() && !pushTimer && !pushing) ghPull().catch(() => {});
});
