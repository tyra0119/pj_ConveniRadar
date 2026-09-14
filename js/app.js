// 画面: 保存データ・地図・描画・イベント（組み立ては lawson/app.js にならう）
import { ODPT_SOURCES } from './config.js?v=4352e1d6';
import { dayProfile, loadNetwork, operatorTitle, railwayTitle, stationName, trainTypeTitle } from './odpt.js?v=4352e1d6';
import { WALK_FACTOR, WALK_SPEED, buildPlan, commonRailways } from './plan.js?v=4352e1d6';
import { CHAINS, STATUSES, fetchStoresAround } from './stores.js?v=4352e1d6';
import { $, esc, fmtDist, fmtDur, fmtMin, haversine, nowHHMM, parseHHMM, toast, todayISO, walkNavUrl, withBusy } from './util.js?v=4352e1d6';

// ===== 設定 =====
const STORAGE_KEY = 'conveniradar:v1';
const NO_NAME_CAMPAIGN = '(名称未設定)';
const STATION_MIN_ZOOM = 12; // 駅は数千あるので、ここまで拡大したら表示する
const SEARCH_LIMIT = 20;

// ===== 保存データ =====
const DEFAULTS = {
  settings: { radius: 600, chains: ['lawson', 'seven', 'ministop'], dwell: 5, transfer: 3, skipRecorded: true, campaign: '' },
  trip: [], // [{ id: 駅ID }] 回る順
  stores: [], // 直近の検索結果
  searchedAt: null,
  searchedStations: [],
  searchedRadius: 0,
  excluded: {}, // { storeId: true }
  records: {}, // { くじ名: { storeId: { status, note, at } } }
  plan: null,
};

const db = load();
let net = null; // 駅・路線データ（読み込み後に入る）

function load() {
  const base = structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...base, ...raw, settings: { ...base.settings, ...raw.settings } };
  } catch {
    return base;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    console.warn('保存に失敗しました', e);
  }
}

function campaignKey() {
  return db.settings.campaign.trim() || NO_NAME_CAMPAIGN;
}

function currentRecords() {
  return (db.records[campaignKey()] ||= {});
}

const walkMinutes = (m) => Math.max(1, Math.round((m * WALK_FACTOR) / WALK_SPEED));

function railwayLabel(id) {
  const rw = net?.railwayById.get(id);
  return rw ? `${operatorTitle(rw.operator)} ${rw.title}` : railwayTitle(id);
}

const railwayColor = (id) => net?.railwayById.get(id)?.color || '#0b7285';

// ===== 操作 =====
function markPlanStale() {
  if (db.plan) db.plan.stale = true;
}

function addStations(ids) {
  let added = 0;
  for (const id of ids) {
    if (db.trip.at(-1)?.id === id) continue;
    db.trip.push({ id });
    added++;
  }
  if (!added) return toast('同じ駅が続くため追加しませんでした');
  markPlanStale();
  save();
  renderAll();
  toast(added === 1 ? `「${stationName(ids.at(-1))}」を追加しました` : `${added}駅を追加しました`);
}

function moveTrip(i, delta) {
  const k = i + delta;
  if (k < 0 || k >= db.trip.length) return;
  [db.trip[i], db.trip[k]] = [db.trip[k], db.trip[i]];
  markPlanStale();
  save();
  renderAll();
}

function removeTrip(i) {
  db.trip.splice(i, 1);
  markPlanStale();
  save();
  renderAll();
}

// 店舗を、いちばん近い行程の駅に割り当てる。同じ駅が 2 回出てくるときは最初の方に付ける
function assignStores() {
  const groups = db.trip.map(() => []);
  if (!net) return groups;
  const first = new Map();
  db.trip.forEach((t, i) => { if (!first.has(t.id)) first.set(t.id, i); });
  const limit = db.settings.radius * 1.1;
  for (const s of db.stores) {
    if (!db.settings.chains.includes(s.chain)) continue;
    let best = -1;
    let bestD = Infinity;
    for (const [id, i] of first) {
      const st = net.stationById.get(id);
      const d = st ? haversine(st, s) : Infinity;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD <= limit) groups[best].push({ ...s, distance: bestD });
  }
  groups.forEach((g) => g.sort((a, b) => a.distance - b.distance));
  return groups;
}

async function searchStores() {
  if (!net) throw new Error('駅データを読み込み中です。少し待ってください');
  if (!db.trip.length) throw new Error('先に回る駅を追加してください');
  const stations = [...new Set(db.trip.map((t) => t.id))].map((id) => net.stationById.get(id)).filter(Boolean);
  db.stores = await fetchStoresAround(stations, db.settings.radius);
  db.searchedAt = Date.now();
  db.searchedStations = stations.map((s) => s.id);
  db.searchedRadius = db.settings.radius;
  markPlanStale();
  save();
  renderAll();
  fitTrip();
  const n = assignStores().reduce((k, g) => k + g.length, 0);
  toast(n ? `${n}店舗見つかりました` : '見つかりませんでした。半径を広げて再検索してください', 4000);
}

async function computePlan(fromIndex = 0, useNow = false) {
  if (!net) throw new Error('駅データを読み込み中です。少し待ってください');
  if (!db.trip.length) throw new Error('先に回る駅を追加してください');
  if (useNow) {
    $('#plan-date').value = todayISO();
    $('#plan-start').value = nowHHMM();
  }
  const date = $('#plan-date').value || todayISO();
  const startTime = $('#plan-start').value || nowHHMM();
  let startMin = parseHHMM(startTime);
  if (startMin < 4 * 60) startMin += 24 * 60; // 0〜4 時は前日の運行日の続き（時刻表の数え方に合わせる）

  const records = currentRecords();
  const skip = useNow || db.settings.skipRecorded;
  const groups = assignStores().map((g) => g.filter((s) => !db.excluded[s.id] && !(skip && records[s.id]?.status)));

  const plan = await buildPlan({
    trip: db.trip.slice(fromIndex),
    storesByStop: groups.slice(fromIndex),
    startMin,
    dwell: db.settings.dwell,
    transfer: db.settings.transfer,
    day: await dayProfile(date),
  });
  db.plan = { ...plan, fromIndex, date, startTime, stale: false };
  save();
  renderAll();
  fitPlan();
  toast(plan.complete ? `${plan.visited}店舗・${plan.stops.length}駅の計画を作りました` : '途中までしか計画できませんでした（巡回の ⚠ を見てください）', 5000);
}

function toggleExcluded(id) {
  if (db.excluded[id]) delete db.excluded[id];
  else db.excluded[id] = true;
  markPlanStale();
  save();
  renderAll();
}

function setStatus(id, status) {
  const records = currentRecords();
  const rec = (records[id] ||= {});
  rec.status = rec.status === status ? undefined : status;
  rec.at = Date.now();
  if (!rec.status && !rec.note) delete records[id];
  save();
  renderAll();
}

function setNote(id, note) {
  const records = currentRecords();
  const rec = (records[id] ||= {});
  rec.note = note.trim() || undefined;
  if (!rec.status && !rec.note) delete records[id];
  save();
}

// ===== 地図 =====
const map = L.map('map', { keyboard: false, preferCanvas: true }).setView([35.681, 139.767], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

const layers = {
  stations: L.layerGroup(),
  trip: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  stores: L.layerGroup().addTo(map),
};
const storeMarkers = new Map();

const pinIcon = (color, text) => L.divIcon({
  className: 'pin-wrap',
  html: `<div class="pin" style="--c:${color}">${esc(text)}</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14],
});

// 店舗マーカー: チェーンのアイコン＋右上に巡回順（訪問済みは ✓）
const storeIcon = (chain, badge, { done = false, faded = false } = {}) => L.divIcon({
  className: 'pin-wrap',
  html: `<div class="store-pin${done ? ' done' : ''}${faded ? ' faded' : ''}">${CHAINS[chain].icon}${badge ? `<span class="pin-badge">${esc(badge)}</span>` : ''}</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
  popupAnchor: [0, -17],
});

function syncStationLayer() {
  const show = map.getZoom() >= STATION_MIN_ZOOM;
  if (show && !map.hasLayer(layers.stations)) layers.stations.addTo(map);
  if (!show && map.hasLayer(layers.stations)) map.removeLayer(layers.stations);
}
map.on('zoomend', syncStationLayer);

function buildStationLayer() {
  layers.stations.clearLayers();
  for (const st of net.stations) {
    L.circleMarker([st.lat, st.lng], {
      radius: 6, color: '#fff', weight: 1.5, fillColor: railwayColor(st.railways[0]), fillOpacity: 0.95,
    })
      .bindTooltip(st.name, { direction: 'top', offset: [0, -6] })
      .bindPopup(() => stationPopup(st))
      .addTo(layers.stations);
  }
  syncStationLayer();
}

function stationPopup(st) {
  const pos = db.trip.map((t, i) => (t.id === st.id ? i + 1 : 0)).filter(Boolean);
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <b>${esc(st.name)}</b>
    <div class="muted small">${esc(st.railways.map(railwayLabel).join('、'))}</div>
    ${pos.length ? `<div class="small">行程の ${pos.join('・')} 番目</div>` : ''}
    <button class="btn small primary block" type="button">＋ 行程の最後に追加</button>`;
  div.querySelector('button').onclick = () => {
    map.closePopup();
    addStations([st.id]);
  };
  return div;
}

function storePopup(s) {
  const excluded = !!db.excluded[s.id];
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <b>${esc(s.name)}</b>
    <div class="muted small">${CHAINS[s.chain].label}</div>
    <div class="row">
      <a class="btn small primary" href="${esc(walkNavUrl(s))}" target="_blank" rel="noopener">徒歩ナビ</a>
      <button class="btn small" type="button">${excluded ? '計画に含める' : '計画から外す'}</button>
    </div>`;
  div.querySelector('button').onclick = () => {
    map.closePopup();
    toggleExcluded(s.id);
  };
  return div;
}

function tripBounds() {
  const pts = db.trip.map((t) => net?.stationById.get(t.id)).filter(Boolean).map((s) => [s.lat, s.lng]);
  return pts.length ? L.latLngBounds(pts) : null;
}

function fitTrip() {
  const b = tripBounds();
  if (!b) return;
  if (db.trip.length === 1) map.setView(b.getCenter(), 15);
  else map.fitBounds(b.pad(0.15));
}

function fitPlan() {
  const b = tripBounds();
  if (!b) return;
  for (const s of db.plan?.stops ?? []) for (const v of s.visits) b.extend([v.store.lat, v.store.lng]);
  map.fitBounds(b, { padding: [30, 30] });
}

// ===== 描画 =====
function renderAll() {
  renderTrip();
  renderStores();
  renderPlan();
  renderRecordSummary();
  renderAttribution();
}

function renderTrip() {
  layers.trip.clearLayers();
  $('#trip-count').textContent = db.trip.length ? `${db.trip.length}駅` : '';
  const list = $('#trip-list');
  if (!db.trip.length) {
    list.innerHTML = '<li class="empty">まだ駅がありません</li>';
    return;
  }

  list.innerHTML = db.trip.map((t, i) => {
    const next = db.trip[i + 1];
    let link = '';
    if (next && net && next.id !== t.id) {
      const rws = commonRailways(net, t.id, next.id);
      link = rws.length
        ? `<div class="trip-link">↓ ${esc(rws.map((r) => r.title).join(' / '))}</div>`
        : '<div class="trip-link warn">↓ 乗り換えなしで行ける路線がありません</div>';
    }
    return `
      <li class="trip-item" data-index="${i}">
        <div class="row">
          <span class="num" style="--c:var(--primary)">${i + 1}</span>
          <span class="grow store-name">${esc(stationName(t.id))}</span>
          <button class="icon-btn" type="button" data-action="up" title="上へ"${i === 0 ? ' disabled' : ''}>↑</button>
          <button class="icon-btn" type="button" data-action="down" title="下へ"${i === db.trip.length - 1 ? ' disabled' : ''}>↓</button>
          <button class="icon-btn" type="button" data-action="remove" title="外す">✕</button>
        </div>
        ${link}
      </li>`;
  }).join('');

  if (!net) return;
  const labels = new Map();
  db.trip.forEach((t, i) => labels.set(t.id, [...(labels.get(t.id) ?? []), i + 1]));
  for (const [id, nums] of labels) {
    const st = net.stationById.get(id);
    if (!st) continue;
    L.circle([st.lat, st.lng], {
      radius: db.settings.radius, color: '#0b7285', weight: 1, fillOpacity: 0.05, interactive: false,
    }).addTo(layers.trip);
    L.marker([st.lat, st.lng], { icon: pinIcon('#0b7285', nums.join('・')), zIndexOffset: 1000 })
      .bindTooltip(st.name, { direction: 'top', offset: [0, -14] })
      .bindPopup(() => stationPopup(st))
      .addTo(layers.trip);
  }
}

function renderStationResults() {
  const box = $('#station-results');
  const norm = (s) => s.replace(/駅$/, '').replace(/[\s　]/g, '').toLowerCase();
  const q = norm($('#station-search').value);
  if (!q) {
    box.innerHTML = '';
    return;
  }
  if (!net) {
    box.innerHTML = '<li class="empty">駅データを読み込み中です…</li>';
    return;
  }
  const hits = net.stations
    .filter((s) => norm(s.name).includes(q))
    .sort((a, b) => (norm(b.name) === q) - (norm(a.name) === q) || a.name.length - b.name.length)
    .slice(0, SEARCH_LIMIT);
  box.innerHTML = hits.length
    ? hits.map((s) => `
      <li><button type="button" class="result" data-id="${esc(s.id)}">
        <b>${esc(s.name)}</b>
        <span class="muted small">${esc(s.railways.map(railwayLabel).join('、'))}</span>
      </button></li>`).join('')
    : '<li class="empty">見つかりません（時刻表のある路線の駅だけを収録しています）</li>';
}

function fillRailwaySelect() {
  const groups = new Map();
  for (const rw of net.railways) {
    if (!rw.order || rw.order.length < 2) continue;
    const op = operatorTitle(rw.operator);
    groups.set(op, [...(groups.get(op) ?? []), rw]);
  }
  $('#rw-select').innerHTML = '<option value="">路線を選ぶ</option>' + [...groups].map(([op, rws]) => `
    <optgroup label="${esc(op)}">${rws.map((rw) => `<option value="${esc(rw.id)}">${esc(rw.title)}</option>`).join('')}</optgroup>`).join('');
  fillRangeSelects();
}

function fillRangeSelects() {
  const rw = net?.railwayById.get($('#rw-select').value);
  const opts = rw ? rw.order.map((id, i) => `<option value="${i}">${esc(stationName(id))}</option>`).join('') : '';
  $('#rw-from').innerHTML = opts;
  $('#rw-to').innerHTML = opts;
  if (rw) $('#rw-to').value = String(Math.min(rw.order.length - 1, 3));
  $('#btn-add-range').disabled = !rw;
}

function renderStores() {
  layers.stores.clearLayers();
  storeMarkers.clear();
  const groups = assignStores();
  const records = currentRecords();
  const planNo = new Map();
  let n = 0;
  for (const s of db.plan?.stops ?? []) for (const v of s.visits) planNo.set(v.store.id, ++n);

  const all = groups.flat();
  $('#store-count').textContent = all.length ? `${all.filter((s) => !db.excluded[s.id]).length} / ${all.length}` : '';
  const needsSearch = db.searchedAt && (db.trip.some((t) => !db.searchedStations.includes(t.id)) || db.settings.radius > db.searchedRadius);
  $('#store-hint').textContent = needsSearch ? '駅や半径を変えたので、再検索すると店舗が増えることがあります' : '';

  const list = $('#store-list');
  if (!db.trip.length || !db.searchedAt) {
    list.innerHTML = `<li class="empty">${db.trip.length ? '「店舗を検索」を押してください' : '回る駅を追加してから検索してください'}</li>`;
    return;
  }

  const firstIndex = (i) => db.trip.findIndex((t) => t.id === db.trip[i].id) === i;
  list.innerHTML = groups.map((g, i) => {
    if (!firstIndex(i)) return '';
    const allOff = g.length && g.every((s) => db.excluded[s.id]);
    const head = `
      <li class="group" data-index="${i}">
        <span class="num" style="--c:var(--primary)">${i + 1}</span>${esc(stationName(db.trip[i].id))}
        <span class="muted small">${g.length}店</span>
        ${g.length ? `<button class="btn small ghost" type="button" data-action="group">${allOff ? 'すべて含める' : 'すべて外す'}</button>` : ''}
      </li>`;
    return head + g.map((s) => {
      const excluded = !!db.excluded[s.id];
      const st = STATUSES[records[s.id]?.status];
      return `
        <li class="store${excluded ? ' off' : ''}" data-id="${esc(s.id)}">
          <label class="store-main">
            <input type="checkbox" data-action="toggle"${excluded ? '' : ' checked'}>
            <span class="chain-icon">${CHAINS[s.chain].icon}</span>
            <span class="store-name">${esc(s.name)}</span>
          </label>
          ${st ? `<span class="tag ${st.tone === 'ok' ? 'ok' : 'ng'}">${st.icon}${st.label}</span>` : ''}
          <span class="muted small">🚶${walkMinutes(s.distance)}分</span>
          <button class="icon-btn" type="button" data-action="focus" title="地図で見る">🗺</button>
        </li>`;
    }).join('');
  }).join('');

  for (const s of all) {
    const done = !!records[s.id]?.status;
    const marker = L.marker([s.lat, s.lng], {
      icon: storeIcon(s.chain, done ? '✓' : planNo.get(s.id), { done, faded: !!db.excluded[s.id] }),
    }).bindPopup(() => storePopup(s)).addTo(layers.stores);
    storeMarkers.set(s.id, marker);
  }
}

const destLabel = (dest) => (dest?.length ? `${dest.map(stationName).join('・')}行` : '');

function renderPlan() {
  layers.route.clearLayers();
  const p = db.plan;
  $('#nav-card').hidden = !p;
  if (!p) {
    $('#plan-summary').innerHTML = '';
    return;
  }

  const records = currentRecords();
  const rides = p.stops.map((s) => s.ride).filter(Boolean);
  const usesChallenge = rides.some((r) => net?.railwayById.get(r.railway)?.src === 'chl');
  const firstName = stationName(p.stops[0]?.stationId);

  $('#plan-summary').innerHTML = `
    <div class="summary">
      <div><span class="big">${p.visited}</span><span class="label">店舗</span></div>
      <div><span class="big">${fmtDur(p.walkMin * 60)}</span><span class="label">歩く時間</span></div>
      <div><span class="big">${p.endMin != null ? fmtMin(p.endMin) : '—'}</span><span class="label">終了</span></div>
    </div>
    <p class="small">${esc(p.date)} ${fmtMin(p.startMin)} ${esc(firstName)}から ${p.stops.length}駅・乗車${rides.length}回</p>
    ${rides.some((r) => r.estimated) ? '<p class="small muted">「推定」の着時刻は、次の駅の時刻表や距離から見積もったものです</p>' : ''}
    ${usesChallenge ? `<p class="small muted">公共交通オープンデータチャレンジの時刻表を含みます（${ODPT_SOURCES.chl.until} まで）</p>` : ''}
    ${!p.complete ? '<p class="small warn">⚠ 途中までしか計画できませんでした</p>' : ''}
    ${p.stale ? '<p class="small warn">⚠ 駅・店舗・設定が変わりました。計画を作り直してください</p>' : ''}`;

  // 地図: 駅から店を回る徒歩は破線、駅間の乗車は路線の色の実線
  p.stops.forEach((s, i) => {
    const st = net?.stationById.get(s.stationId);
    if (!st) return;
    if (s.visits.length) {
      L.polyline([[st.lat, st.lng], ...s.visits.map((v) => [v.store.lat, v.store.lng]), [st.lat, st.lng]], {
        color: '#c2255c', weight: 4, opacity: 0.75, dashArray: '6 8', interactive: false,
      }).addTo(layers.route);
    }
    const nx = s.ride && net.stationById.get(p.stops[i + 1]?.stationId);
    if (nx) {
      L.polyline([[st.lat, st.lng], [nx.lat, nx.lng]], { color: railwayColor(s.ride.railway), weight: 6, opacity: 0.8, interactive: false }).addTo(layers.route);
    }
  });

  const visits = p.stops.flatMap((s) => s.visits);
  const doneCount = visits.filter((v) => records[v.store.id]?.status).length;
  $('#progress').textContent = `${doneCount} / ${visits.length} 完了`;

  const next = visits.find((v) => !records[v.store.id]?.status);
  const btnNext = $('#btn-next');
  btnNext.textContent = next ? `▶ 次へ：${next.store.name}（${fmtMin(next.arrive)}着の予定）` : '🎉 全店舗まわりました';
  btnNext.classList.toggle('disabled', !next);
  if (next) btnNext.href = walkNavUrl(next.store);
  else btnNext.removeAttribute('href');

  let n = 0;
  $('#plan-list').innerHTML = p.stops.map((s, i) => {
    const tripIndex = p.fromIndex + i;
    const head = `
      <li class="tl-station">
        <span class="num" style="--c:var(--primary)">${tripIndex + 1}</span>
        <div class="stop-info">
          <div class="store-name">${esc(stationName(s.stationId))}</div>
          <div class="muted small">${fmtMin(s.arrive)}${i === 0 ? 'から' : '着'} ・ ${s.visits.length ? `${s.visits.length}店` : '店なし'}</div>
        </div>
        <button class="btn small" type="button" data-action="replan" data-index="${tripIndex}" title="この駅から、今の時刻で残りを組み直す">🔄 今からここで</button>
      </li>`;

    const stores = s.visits.map((v) => {
      n++;
      const rec = records[v.store.id];
      return `
        <li class="stop${rec?.status ? ' done' : ''}" data-id="${esc(v.store.id)}">
          <div class="stop-head">
            <span class="num" style="--c:${CHAINS[v.store.chain].color}">${n}</span>
            <div class="stop-info">
              <div class="store-name">${esc(v.store.name)}</div>
              <div class="muted small">${fmtMin(v.arrive)}着 ・ 🚶${fmtDur(v.walkMin * 60)} ・ ${fmtDist(v.walkDist)}</div>
            </div>
            <a class="btn small primary" href="${esc(walkNavUrl(v.store))}" target="_blank" rel="noopener">ナビ</a>
          </div>
          <div class="status-row">
            ${Object.entries(STATUSES).map(([key, st]) => `<button type="button" class="chip${rec?.status === key ? ` on ${st.tone}` : ''}" data-action="status" data-status="${key}">${st.icon} ${st.label}</button>`).join('')}
          </div>
          <input class="note" type="text" data-action="note" placeholder="メモ（残り枚数・購入数など）" value="${esc(rec?.note)}">
        </li>`;
    }).join('');

    const back = s.backLeg
      ? `<li class="tl-walk">🚶 駅へ戻る ${fmtDur(s.backLeg.min * 60)}（${fmtDist(s.backLeg.dist)}）→ ${fmtMin(s.ready)} 駅着</li>`
      : '';

    const ride = s.ride
      ? `<li class="tl-ride" style="--c:${railwayColor(s.ride.railway)}">
          <div><b>${fmtMin(s.ride.dep)}発</b> ${esc(trainTypeTitle(s.ride.type))} ${esc(destLabel(s.ride.dest))}</div>
          <div class="muted small">${esc(railwayTitle(s.ride.railway))} ・ 駅で${Math.max(0, Math.round(s.ride.dep - s.ready))}分待ち → <b>${fmtMin(s.ride.arr)}着</b>${s.ride.estimated ? '（推定）' : ''}</div>
        </li>`
      : '';

    const err = s.error ? `<li class="tl-error">⚠ ${esc(s.error)}</li>` : '';
    return head + stores + back + ride + err;
  }).join('') + (p.endMin != null ? `
      <li class="tl-station">
        <span class="num" style="--c:#495057">🏁</span>
        <div class="stop-info"><div class="store-name">終了</div><div class="muted small">${fmtMin(p.endMin)}</div></div>
      </li>` : '');
}

function renderRecordSummary() {
  const recs = Object.values(currentRecords()).filter((r) => r.status);
  $('#record-summary').textContent = recs.length
    ? `記録：${Object.entries(STATUSES).map(([k, st]) => `${st.icon}${st.label} ${recs.filter((r) => r.status === k).length}`).join('　')}`
    : '';
}

// 出典の「データの原典」は、いま行程に入っている路線の事業者にする
function renderAttribution() {
  const ops = new Set();
  for (const t of db.trip) for (const r of net?.stationById.get(t.id)?.railways ?? []) ops.add(net.railwayById.get(r)?.operator);
  const names = [...ops].filter(Boolean).map(operatorTitle);
  document.querySelectorAll('.odpt-owner').forEach((el) => { el.textContent = names.length ? names.join('・') : '各鉄道事業者'; });
  $('#data-date').textContent = net ? `駅・路線データは ${net.generatedAt} 取得。` : '';
}

function syncControls() {
  const s = db.settings;
  $('#radius').value = s.radius;
  $('#radius-out').textContent = s.radius;
  $('#radius-walk').textContent = walkMinutes(s.radius);
  document.querySelectorAll('input[name=chain]').forEach((el) => { el.checked = s.chains.includes(el.value); });
  $('#dwell').value = s.dwell;
  $('#transfer').value = s.transfer;
  $('#skip-recorded').checked = s.skipRecorded;
  $('#campaign').value = s.campaign;
  $('#plan-date').value = todayISO();
  $('#plan-start').value = nowHHMM();
}

// ===== イベント =====
$('#station-search').addEventListener('input', renderStationResults);

$('#station-results').addEventListener('click', (e) => {
  const id = e.target.closest('button[data-id]')?.dataset.id;
  if (!id) return;
  addStations([id]);
  $('#station-search').value = '';
  renderStationResults();
  fitTrip();
});

$('#rw-select').addEventListener('change', fillRangeSelects);

$('#btn-add-range').addEventListener('click', () => {
  const rw = net?.railwayById.get($('#rw-select').value);
  if (!rw) return;
  const a = Number($('#rw-from').value);
  const b = Number($('#rw-to').value);
  if (a === b) return toast('乗る駅と降りる駅を別にしてください');
  addStations(a < b ? rw.order.slice(a, b + 1) : rw.order.slice(b, a + 1).reverse());
  fitTrip();
});

$('#trip-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  const i = Number(btn?.closest('[data-index]')?.dataset.index);
  if (!btn || Number.isNaN(i)) return;
  if (btn.dataset.action === 'up') moveTrip(i, -1);
  else if (btn.dataset.action === 'down') moveTrip(i, 1);
  else if (btn.dataset.action === 'remove') removeTrip(i);
});

$('#btn-clear-trip').addEventListener('click', () => {
  if (!db.trip.length || !confirm('行程の駅をすべて外しますか？（記録は消えません）')) return;
  db.trip = [];
  db.plan = null;
  save();
  renderAll();
});

$('#radius').addEventListener('input', (e) => {
  db.settings.radius = Number(e.target.value);
  $('#radius-out').textContent = db.settings.radius;
  $('#radius-walk').textContent = walkMinutes(db.settings.radius);
  markPlanStale();
  save();
  renderAll();
});

document.querySelectorAll('input[name=chain]').forEach((el) => el.addEventListener('change', () => {
  db.settings.chains = [...document.querySelectorAll('input[name=chain]:checked')].map((c) => c.value);
  markPlanStale();
  save();
  renderAll();
}));

$('#btn-search').addEventListener('click', (e) => withBusy(e.currentTarget, '検索中…', searchStores));
$('#btn-plan').addEventListener('click', (e) => withBusy(e.currentTarget, '時刻表を確認中…', () => computePlan(0, false)));

$('#campaign').addEventListener('change', (e) => {
  db.settings.campaign = e.target.value;
  save();
  renderAll();
});

for (const [id, key, max] of [['#dwell', 'dwell', 60], ['#transfer', 'transfer', 30]]) {
  $(id).addEventListener('input', (e) => {
    db.settings[key] = Math.min(max, Math.max(0, Number(e.target.value) || 0));
    markPlanStale();
    save();
    renderPlan();
  });
}

for (const id of ['#plan-date', '#plan-start']) {
  $(id).addEventListener('change', () => {
    markPlanStale();
    save();
    renderPlan();
  });
}

$('#skip-recorded').addEventListener('change', (e) => {
  db.settings.skipRecorded = e.target.checked;
  save();
});

$('#btn-reset-records').addEventListener('click', () => {
  if (!confirm(`「${campaignKey()}」の記録をすべて消去しますか？`)) return;
  delete db.records[campaignKey()];
  save();
  renderAll();
});

$('#store-list').addEventListener('change', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && e.target.dataset.action === 'toggle') toggleExcluded(id);
});

$('#store-list').addEventListener('click', (e) => {
  const groupBtn = e.target.closest('button[data-action=group]');
  if (groupBtn) {
    // 駅の店を一括で外す／含める。1 店でも含まれていれば「外す」
    const g = assignStores()[Number(groupBtn.closest('[data-index]').dataset.index)] ?? [];
    const exclude = g.some((s) => !db.excluded[s.id]);
    for (const s of g) {
      if (exclude) db.excluded[s.id] = true;
      else delete db.excluded[s.id];
    }
    markPlanStale();
    save();
    renderAll();
    return;
  }
  const btn = e.target.closest('button[data-action=focus]');
  const marker = storeMarkers.get(btn?.closest('[data-id]')?.dataset.id);
  if (!marker) return;
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16));
  marker.openPopup();
  $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#plan-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'status') {
    const id = btn.closest('[data-id]')?.dataset.id;
    if (id) setStatus(id, btn.dataset.status);
  } else if (btn.dataset.action === 'replan') {
    withBusy(btn, '確認中…', () => computePlan(Number(btn.dataset.index), true));
  }
});

$('#plan-list').addEventListener('change', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && e.target.dataset.action === 'note') setNote(id, e.target.value);
});

// ===== 起動 =====
document.querySelectorAll('.chain-icon[data-chain]').forEach((el) => { el.innerHTML = CHAINS[el.dataset.chain].icon; });
syncControls();
renderAll();

if (!ODPT_SOURCES.pub.key && ODPT_SOURCES.pub.base.includes('api.odpt.org')) {
  toast('ODPT のキーが設定されていません。手元では python tools/serve.py で起動してください', 10000);
}

loadNetwork()
  .then((n) => {
    net = n;
    buildStationLayer();
    fillRailwaySelect();
    renderAll();
    renderStationResults();
    if (db.plan) fitPlan();
    else fitTrip();
  })
  .catch((e) => {
    console.error(e);
    toast(`駅データを読み込めませんでした（${e.message}）`, 10000);
  });
