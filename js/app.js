// 画面: 保存データ・地図・描画・イベント（組み立ては lawson/app.js にならう）
import { ODPT_SOURCES } from './config.js?v=15344496';
import { dayProfile, loadNetwork, operatorTitle, railwayTitle, stationName, trainInformation, trainTypeTitle } from './odpt.js?v=15344496';
import { WALK_FACTOR, WALK_SPEED, buildPlan, commonRailways } from './plan.js?v=15344496';
import { CHAINS, STATUSES, fetchStoresAround } from './stores.js?v=15344496';
import { $, esc, fmtDist, fmtDur, fmtMin, haversine, nowHHMM, parseHHMM, toast, todayISO, walkNavUrl, withBusy } from './util.js?v=15344496';

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
  searched: {}, // { 駅ID: 店舗を検索した半径(m) }
  excluded: {}, // { storeId: true }
  records: {}, // { くじ名: { storeId: { status, note, at } } }
  plan: null,
  ui: { tab: 'trip', openGroups: {} }, // 表示中のタブ、店舗一覧で開いている駅 { 駅ID: true/false }
};

const db = load();
let net = null; // 駅・路線データ（読み込み後に入る）

function load() {
  const base = structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // 旧形式（検索した駅の一覧と半径を別々に保存）から移す
    const { searchedStations = [], searchedRadius = 0, ...rest } = raw;
    const searched = raw.searched ?? Object.fromEntries(searchedStations.map((id) => [id, searchedRadius]));
    return { ...base, ...rest, searched, settings: { ...base.settings, ...raw.settings }, ui: { ...base.ui, ...raw.ui } };
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

// ids は駅 ID でも駅グループ ID でもよい。行程には駅グループ（乗り換えできる 1 つの駅）で入れる
function addStations(ids) {
  if (blockedWhileSearching()) return;
  let added = 0;
  for (const id of ids.map((x) => net?.stopById.get(x)?.id ?? x)) {
    if (db.trip.at(-1)?.id === id) continue;
    db.trip.push({ id });
    added++;
  }
  if (!added) return toast('同じ駅が続くため追加しませんでした');
  markPlanStale();
  save();
  renderAll();
  toast(added === 1 ? `「${stationName(ids.at(-1))}」を追加しました` : `${added}駅を追加しました`);
  autoSearchMissing();
  refreshTrainInfo();
}

function moveTrip(i, delta) {
  if (blockedWhileSearching()) return;
  const k = i + delta;
  if (k < 0 || k >= db.trip.length) return;
  [db.trip[i], db.trip[k]] = [db.trip[k], db.trip[i]];
  markPlanStale();
  save();
  renderAll();
  refreshTrainInfo();
}

// 行程で隣り合う 2 駅の間にある駅を、路線ごとに返す。途中の駅が同じ路線（有楽町線と副都心線など）はまとめる
function betweenStops(links) {
  const st = (id) => net.stationById.get(id);
  const isLoop = (order) => order.length >= 10 && haversine(st(order[0]), st(order.at(-1))) < 2500; // 山手線など
  const out = [];
  for (const l of links) {
    const order = l.railway.order ?? [];
    const i = order.indexOf(l.from);
    const k = order.indexOf(l.to);
    if (i < 0 || k < 0) continue;
    let ids = i < k ? order.slice(i + 1, k) : order.slice(k + 1, i).reverse();
    if (isLoop(order)) {
      // 環状線は逆回りの方が近いことがある
      const other = i < k ? [...order.slice(0, i).reverse(), ...order.slice(k + 1).reverse()] : [...order.slice(i + 1), ...order.slice(0, k)];
      if (other.length < ids.length) ids = other;
    }
    const stops = [...new Set(ids.map((id) => net.stopById.get(id)?.id).filter(Boolean))];
    if (!stops.length) continue;
    const same = out.find((f) => f.stops.join() === stops.join());
    if (same) same.titles.push(l.railway.title);
    else out.push({ stops, titles: [l.railway.title] });
  }
  return out;
}

function fillBetween(i, k) {
  if (blockedWhileSearching()) return;
  const f =betweenStops(commonRailways(net, db.trip[i].id, db.trip[i + 1].id))[k];
  if (!f) return;
  db.trip.splice(i + 1, 0, ...f.stops.map((id) => ({ id })));
  markPlanStale();
  save();
  renderAll();
  toast(`${f.titles.join('・')}の途中の${f.stops.length}駅を追加しました`);
  autoSearchMissing();
  refreshTrainInfo();
}

function removeTrip(i) {
  if (blockedWhileSearching()) return;
  db.trip.splice(i, 1);
  markPlanStale();
  save();
  renderAll();
  refreshTrainInfo();
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
      const st = net.stopById.get(id);
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

// 店舗の検索中は、行程・半径・計画の操作を止める（検索中に駅や半径が変わると、何を探したかが食い違うため）
let searching = false;
function setSearching(on) {
  searching = on;
  document.body.classList.toggle('searching', on);
  for (const el of document.querySelectorAll('#radius, #btn-search, #btn-plan, #station-search, #btn-clear-trip, #rw-select, #rw-from, #rw-to, input[name=chain]')) el.disabled = on;
  $('#btn-add-range').disabled = on || !net?.railwayById.get($('#rw-select').value);
}

function blockedWhileSearching() {
  if (!searching) return false;
  toast('店舗を検索中です。終わるまでお待ちください');
  return true;
}

// 店舗をまだ探していない駅（検索のあとに足した駅、半径を広げる前に探した駅）
function unsearchedStations() {
  if (!net) return [];
  return [...new Set(db.trip.map((t) => t.id))]
    .filter((id) => (db.searched[id] ?? 0) < db.settings.radius)
    .map((id) => net.stopById.get(id))
    .filter(Boolean);
}

// onlyMissing: 未検索の駅だけを探して、これまでの結果に足す
async function searchStores({ onlyMissing = false } = {}) {
  if (!net) throw new Error('駅データを読み込み中です。少し待ってください');
  if (!db.trip.length) throw new Error('先に回る駅を追加してください');
  const stations = onlyMissing
    ? unsearchedStations()
    : [...new Set(db.trip.map((t) => t.id))].map((id) => net.stopById.get(id)).filter(Boolean);
  if (!stations.length) return;

  // 検索中に半径を動かされても、実際に探した半径で「検索済み」を記録する
  // （終わった時点の半径で記録すると、400m で探している間に 800m へ広げたとき、広げた分が探されないままになる）
  const radius = db.settings.radius;
  setSearching(true);
  let found;
  try {
    found = await fetchStoresAround(stations, radius);
  } finally {
    setSearching(false);
  }
  if (onlyMissing) {
    const known = new Set(db.stores.map((s) => s.id));
    db.stores.push(...found.filter((s) => !known.has(s.id)));
  } else {
    db.stores = found;
    db.searched = {};
  }
  for (const s of stations) db.searched[s.id] = Math.max(db.searched[s.id] ?? 0, radius);
  db.searchedAt = Date.now();
  markPlanStale();
  save();
  renderAll();
  if (!onlyMissing) fitTrip();

  const ids = new Set(stations.map((s) => s.id));
  const n = assignStores().reduce((k, g, i) => k + (ids.has(db.trip[i].id) ? g.length : 0), 0);
  const where = onlyMissing ? `${stations.map((s) => s.name).join('・')}：` : '';
  toast(n ? `${where}${n}店舗見つかりました` : `${where}見つかりませんでした。半径を広げてください`, 4000);
}

// 一度検索したあとに駅を足したり半径を広げたりしたら、足りない駅だけを自動で探す。
// 検索ボタンの押し忘れで、足した駅が「0店」に見えていた（2026-09-14 池袋→和光市で発覚）
let autoSearching = null;
function autoSearchMissing() {
  if (!db.searchedAt || !net || autoSearching || !unsearchedStations().length) return;
  autoSearching = searchStores({ onlyMissing: true })
    .then(() => true, (e) => {
      console.error(e);
      toast(e.message, 8000);
      return false;
    })
    .then((ok) => {
      autoSearching = null;
      renderStores();
      if (ok) autoSearchMissing(); // 検索中にさらに足された駅
    });
  renderStores();
}

// ===== 運行情報 =====
const INFO_REFRESH_MS = 3 * 60 * 1000;
let trainInfo = null; // Map 路線ID → { level: alert|notice|normal, status, text, date }
let trainInfoError = '';

// 行程の駅と駅を結ぶ路線と、計画で乗る路線
function tripRailways() {
  if (!net) return [];
  const ids = new Set();
  db.trip.forEach((t, i) => {
    const next = db.trip[i + 1];
    if (next) for (const l of commonRailways(net, t.id, next.id)) ids.add(l.railway.id);
  });
  for (const s of db.plan?.stops ?? []) if (s.ride) ids.add(s.ride.railway);
  return [...ids];
}

async function refreshTrainInfo(force = false) {
  if (!net || !tripRailways().length) return renderTrainInfo();
  try {
    trainInfo = await trainInformation({ maxAgeMs: force ? 0 : INFO_REFRESH_MS - 30000 });
    trainInfoError = '';
  } catch (e) {
    trainInfoError = e.message;
  }
  renderTrip();
  renderPlan();
  renderTrainInfo();
}

function clockOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const alertOf = (rid) => (trainInfo?.get(rid)?.level === 'alert' ? trainInfo.get(rid) : null);

function renderTrainInfo() {
  const rids = tripRailways();
  let html = '';
  if (rids.length) {
    const rows = rids.map((rid) => {
      const info = trainInfo?.get(rid);
      const level = info?.level ?? 'none';
      const label = level === 'none' ? (trainInfo ? '情報の提供なし' : '…') : level === 'normal' ? '平常運転' : `${level === 'alert' ? '⚠ ' : ''}${info.status}`;
      return `
        <li class="info ${level}">
          <span class="info-line" style="--c:${railwayColor(rid)}">${esc(railwayLabel(rid))}</span>
          <span class="info-status">${esc(label)}</span>
          ${level === 'alert' || level === 'notice' ? `<div class="small">${esc(info.text)}</div>` : ''}
        </li>`;
    }).join('');
    const latest = rids.map((r) => trainInfo?.get(r)?.date).filter(Boolean).sort().at(-1);
    const when = trainInfoError || (trainInfo ? (latest ? `${clockOf(latest)} 時点` : '') : '取得中…');
    html = `
      <div class="row"><b class="small">🚦 運行情報</b><span class="muted small grow">${esc(when)}</span>
        <button class="btn small ghost" type="button" data-action="refresh-info">更新</button></div>
      <ul class="info-list">${rows}</ul>`;
  }
  document.querySelectorAll('.train-info').forEach((el) => { el.innerHTML = html; });
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

  // 店舗を探していない駅があれば、先に探す（探さずに計画すると、その駅は店なしになる）
  if (autoSearching) await autoSearching;
  if (unsearchedStations().length) await searchStores({ onlyMissing: true });

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
  planOpen.clear();
  save();
  renderAll();
  fitPlan();
  refreshTrainInfo();
  setTab('nav');
  toast(plan.complete ? `${plan.visited}店舗・${plan.stops.length}駅の計画を作りました` : `途中までしか計画できませんでした。${plan.error}`, plan.complete ? 5000 : 12000);
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

// 駅のマーカー（路線ごとの駅）から開いても、乗り換えできる駅全体として出す
function stationPopup(st) {
  const stop = net.stopById.get(st.id) ?? st;
  const pos = db.trip.map((t, i) => (t.id === stop.id ? i + 1 : 0)).filter(Boolean);
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <b>${esc(stop.name)}</b>
    <div class="muted small">${esc(stop.railways.map(railwayLabel).join('、'))}</div>
    ${pos.length ? `<div class="small">行程の ${pos.join('・')} 番目</div>` : ''}
    <button class="btn small primary block" type="button">＋ 行程の最後に追加</button>`;
  div.querySelector('button').onclick = () => {
    map.closePopup();
    addStations([stop.id]);
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
  const pts = db.trip.map((t) => net?.stopById.get(t.id)).filter(Boolean).map((s) => [s.lat, s.lng]);
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
  renderTrainInfo();
  renderRecordSummary();
  renderAttribution();
}

function renderTrip() {
  layers.trip.clearLayers();
  $('#trip-count').textContent = db.trip.length ? `${db.trip.length}駅` : '';
  $('#tab-badge-trip').textContent = db.trip.length ? `${db.trip.length}駅` : '';
  const list = $('#trip-list');
  if (!db.trip.length) {
    list.innerHTML = '<li class="empty">まだ駅がありません</li>';
    return;
  }

  list.innerHTML = db.trip.map((t, i) => {
    const next = db.trip[i + 1];
    let link = '';
    if (next && net && next.id !== t.id) {
      const links = commonRailways(net, t.id, next.id);
      const fills = betweenStops(links);
      link = links.length
        ? `<div class="trip-link">↓ ${esc(links.map((l) => l.railway.title + (alertOf(l.railway.id) ? `（⚠${alertOf(l.railway.id).status}）` : '')).join(' / '))}
            ${fills.map((f, k) => `<button class="btn small ghost" type="button" data-action="fill" data-fill="${k}">＋ 間の${f.stops.length}駅を追加（${esc(f.titles.join('・'))}）</button>`).join('')}
          </div>`
        : '<div class="trip-link warn">↓ 乗り換えなしで行ける路線がありません。乗り換えにはまだ対応していないので、間に乗り換える駅を追加してください</div>';
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
    const st = net.stopById.get(id);
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
  const hits = net.stops
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

// 店舗一覧で、その駅の店を開いて見せるか。駅が 1 つなら開き、2 つ以上なら閉じておく（押すと開く）
function isGroupOpen(id) {
  return db.ui.openGroups[id] ?? new Set(db.trip.map((t) => t.id)).size < 2;
}

// 巡回の一覧は、いま回っている駅（まだ回っていない店がある最初の駅）だけを開く。利用者が開閉した駅はそれに従う
const planOpen = new Map(); // 計画の駅の番号 → 開いているか。計画を作り直したら消す
function currentPlanStop(p, records) {
  return p.stops.findIndex((s) => s.visits.some((v) => !records[v.store.id]?.status));
}
const isStopOpen = (i, current) => (planOpen.has(i) ? planOpen.get(i) : i === current);

// 半径や駅を変えたあと、店舗を検索し直す必要があるかを半径スライダーのすぐ下に出す
let radiusDragging = false;
function renderStoreHint(pending) {
  const hint = $('#store-hint');
  const stopIds = [...new Set(db.trip.map((t) => t.id))];
  const widened = [...pending].some((id) => (db.searched[id] ?? 0) > 0); // 前に探した駅で、半径だけ足りない
  const narrowed = stopIds.some((id) => (db.searched[id] ?? 0) > db.settings.radius);
  let html = '';
  let quiet = false;
  if (!db.searchedAt) {
    html = '';
  } else if (pending.size && autoSearching) {
    html = `🔍 ${widened ? '広げた半径' : '足した駅'}の分の店舗を検索しています…`;
    quiet = true;
  } else if (pending.size && radiusDragging) {
    html = '指を離すと、広げた半径の分の店舗を検索します';
    quiet = true;
  } else if (pending.size) {
    html = `<span>⚠ ${widened ? '半径を広げた' : '駅を足した'}ので、店舗を検索し直してください</span>
      <button class="btn small primary" type="button" data-action="search-missing">🔍 検索し直す</button>`;
  } else if (narrowed) {
    html = '半径を狭めたので、範囲外の店舗は一覧と計画から外しています（検索し直す必要はありません）';
    quiet = true;
  }
  hint.innerHTML = html;
  hint.classList.toggle('quiet', quiet);
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
  $('#tab-badge-stores').textContent = all.length ? `${all.filter((s) => !db.excluded[s.id]).length}店` : '';
  $('#store-tools').hidden = !db.searchedAt || new Set(db.trip.map((t) => t.id)).size < 2;
  const pending = new Set(unsearchedStations().map((s) => s.id));
  renderStoreHint(pending);

  const list = $('#store-list');
  if (!db.trip.length || !db.searchedAt) {
    list.innerHTML = `<li class="empty">${db.trip.length ? '「店舗を検索」を押してください' : '回る駅を追加してから検索してください'}</li>`;
    return;
  }

  const firstIndex = (i) => db.trip.findIndex((t) => t.id === db.trip[i].id) === i;
  list.innerHTML = groups.map((g, i) => {
    if (!firstIndex(i)) return '';
    const id = db.trip[i].id;
    const allOff = g.length && g.every((s) => db.excluded[s.id]);
    const opened = isGroupOpen(id);
    const head = `
      <li class="group" data-index="${i}">
        <button class="group-toggle" type="button" data-action="toggle-group" aria-expanded="${opened}">
          <span class="chev">${opened ? '▾' : '▸'}</span>
          <span class="num" style="--c:var(--primary)">${i + 1}</span>
          <span class="group-name">${esc(stationName(id))}</span>
          ${pending.has(id)
            ? `<span class="small warn">${autoSearching ? '検索中…' : '未検索'}</span>`
            : `<span class="muted small">${g.filter((s) => !db.excluded[s.id]).length}/${g.length}店</span>`}
        </button>
        ${g.length ? `<button class="btn small ghost" type="button" data-action="group">${allOff ? 'すべて含める' : 'すべて外す'}</button>` : ''}
      </li>`;
    if (!opened) return head;
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

// 計画の駅が、いまの行程の何番目か。計画のあとに駅を足したり並べ替えたりすると
// 「計画を作ったときの番号」とずれ、「今からここで」が別の駅から組み直していた。
// 同じ駅が何度も出てくるときは、作ったときの番号に一番近いものを選ぶ。行程から外した駅は -1
function tripIndexOf(stopId, hint) {
  let best = -1;
  db.trip.forEach((t, j) => {
    if (t.id === stopId && (best < 0 || Math.abs(j - hint) < Math.abs(best - hint))) best = j;
  });
  return best;
}

// いま居るとみなす駅（組み直しの起点）の、行程での位置。
// まだ回っていない店がある最初の駅。その駅の店を全部記録済みなら次の駅。何も記録していなければ計画の最初の駅
function currentTripIndex() {
  const p = db.plan;
  if (!p?.stops.length) return db.trip.length ? 0 : -1;
  const records = currentRecords();
  let k = p.stops.findIndex((s) => s.visits.some((v) => !records[v.store.id]?.status));
  if (k < 0) {
    const lastDone = p.stops.findLastIndex((s) => s.visits.some((v) => records[v.store.id]?.status));
    k = lastDone < 0 ? 0 : Math.min(lastDone + 1, p.stops.length - 1);
  }
  const i = tripIndexOf(p.stops[k].stationId, p.fromIndex + k);
  return i >= 0 ? i : Math.min(p.fromIndex, db.trip.length - 1);
}

const destLabel = (dest) =>(dest?.length ? `${dest.map(stationName).join('・')}行` : '');

function renderPlan() {
  layers.route.clearLayers();
  const p = db.plan;
  $('#nav-empty').hidden = !!p;
  $('#nav-body').hidden = !p;
  if (!p) {
    $('#plan-summary').innerHTML = '';
    $('#progress').textContent = '';
    $('#tab-badge-plan').textContent = '';
    $('#tab-badge-nav').textContent = '';
    return;
  }
  $('#tab-badge-plan').textContent = p.stale ? '⚠ 古い' : !p.complete ? '⚠ 途中まで' : `${fmtMin(p.endMin)}終了`;

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
    ${!p.complete ? `<p class="small warn">⚠ 途中までしか計画できませんでした。${esc(p.error ?? '')}</p>` : ''}
    ${p.stale ? '<p class="small warn">⚠ 駅・店舗・設定が変わりました。計画を作り直してください</p>' : ''}`;

  // 地図: 駅から店を回る徒歩は破線、駅間の乗車は路線の色の実線
  p.stops.forEach((s, i) => {
    const st = net?.stopById.get(s.stationId);
    if (!st) return;
    if (s.visits.length) {
      L.polyline([[st.lat, st.lng], ...s.visits.map((v) => [v.store.lat, v.store.lng]), [st.lat, st.lng]], {
        color: '#c2255c', weight: 4, opacity: 0.75, dashArray: '6 8', interactive: false,
      }).addTo(layers.route);
    }
    const nx = s.ride && net.stopById.get(p.stops[i + 1]?.stationId);
    if (nx) {
      const line = [[st.lat, st.lng], [nx.lat, nx.lng]];
      const alert = alertOf(s.ride.railway);
      if (alert) {
        // 遅延・運転見合わせの区間は太いオレンジで囲み、触れると本文を出す
        L.polyline(line, { color: '#e8590c', weight: 16, opacity: 0.4 })
          .bindTooltip(`⚠ ${esc(alert.status)}：${esc(alert.text)}`, { sticky: true, className: 'info-tip' })
          .addTo(layers.route);
      }
      L.polyline(line, { color: railwayColor(s.ride.railway), weight: 6, opacity: 0.8, interactive: false }).addTo(layers.route);
    }
  });

  // 計画のあとに駅・店舗・設定を変えたら、巡回を見ている人にも分かるように出し、その場で組み直せるようにする。
  // 回っている最中に予定が勝手に変わると混乱するので、自動では組み直さない
  $('#nav-card').classList.toggle('stale', !!p.stale);
  const banner = $('#stale-banner');
  banner.hidden = !p.stale;
  if (p.stale) {
    const from = currentTripIndex();
    banner.innerHTML = `
      <div>⚠ 計画を作ったあとに駅・店舗・設定が変わったため、この計画は古いままです。</div>
      ${from >= 0 ? `<button class="btn primary block" type="button" data-action="replan" data-index="${from}">🔄 今の時刻で組み直す（${esc(stationName(db.trip[from].id))}から・記録済みの店を除く）</button>` : ''}`;
  }

  const visits = p.stops.flatMap((s) => s.visits);
  const doneCount = visits.filter((v) => records[v.store.id]?.status).length;
  $('#progress').textContent = `${doneCount} / ${visits.length} 完了`;
  $('#tab-badge-nav').textContent = `${doneCount}/${visits.length}`;

  const next = visits.find((v) => !records[v.store.id]?.status);
  const btnNext = $('#btn-next');
  btnNext.textContent = next ? `▶ 次へ：${next.store.name}（${fmtMin(next.arrive)}着の予定）` : '🎉 全店舗まわりました';
  btnNext.classList.toggle('disabled', !next);
  if (next) btnNext.href = walkNavUrl(next.store);
  else btnNext.removeAttribute('href');

  let n = 0;
  const current = currentPlanStop(p, records);
  $('#plan-list').innerHTML = p.stops.map((s, i) => {
    const tripIndex = tripIndexOf(s.stationId, p.fromIndex + i);
    const doneHere = s.visits.filter((v) => records[v.store.id]?.status).length;
    const opened = s.visits.length > 0 && isStopOpen(i, current);
    const head = `
      <li class="tl-station${i === current ? ' current' : ''}">
        <button class="stop-toggle" type="button" data-action="toggle-stop" data-stop="${i}" aria-expanded="${opened}"${s.visits.length ? '' : ' disabled'}>
          <span class="chev">${s.visits.length ? (opened ? '▾' : '▸') : ''}</span>
          <span class="num" style="--c:var(--primary)">${tripIndex >= 0 ? tripIndex + 1 : '—'}</span>
          <span class="stop-info">
            <span class="store-name">${esc(stationName(s.stationId))} ${i === current ? '<span class="here">回っている駅</span>' : ''}</span>
            <span class="muted small">${fmtMin(s.arrive)}${i === 0 ? 'から' : '着'} ・ ${s.visits.length ? `完了 ${doneHere}/${s.visits.length}店` : '店なし'}</span>
          </span>
        </button>
        ${tripIndex >= 0 ? `<button class="btn small" type="button" data-action="replan" data-index="${tripIndex}" title="この駅から、今の時刻で残りを組み直す">🔄 今からここで</button>` : ''}
      </li>`;

    // 閉じている駅は、店の行と「駅へ戻る」を出さない（番号は通しで数える）
    if (!opened) n += s.visits.length;
    const stores = !opened ? '' : s.visits.map((v) => {
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

    const back = opened && s.backLeg
      ? `<li class="tl-walk">🚶 駅へ戻る ${fmtDur(s.backLeg.min * 60)}（${fmtDist(s.backLeg.dist)}）→ ${fmtMin(s.ready)} 駅着</li>`
      : '';

    const ride = s.ride
      ? `<li class="tl-ride" style="--c:${railwayColor(s.ride.railway)}">
          <div><b>${fmtMin(s.ride.dep)}発</b> ${esc(trainTypeTitle(s.ride.type))} ${esc(destLabel(s.ride.dest))}</div>
          <div class="muted small">${esc(railwayLabel(s.ride.railway))} ・ 駅で${Math.max(0, Math.round(s.ride.dep - s.ready))}分待ち → <b>${fmtMin(s.ride.arr)}着</b>${s.ride.estimated ? '（推定）' : ''}</div>
          ${alertOf(s.ride.railway) ? `<div class="small warn">⚠ ${esc(alertOf(s.ride.railway).status)}：${esc(alertOf(s.ride.railway).text)}</div>` : ''}
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
  for (const t of db.trip) for (const r of net?.stopById.get(t.id)?.railways ?? []) ops.add(net.railwayById.get(r)?.operator);
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
  else if (btn.dataset.action === 'fill') fillBetween(i, Number(btn.dataset.fill));
});

$('#btn-clear-trip').addEventListener('click', () => {
  if (!db.trip.length || !confirm('行程の駅をすべて外しますか？（記録は消えません）')) return;
  db.trip = [];
  db.plan = null;
  save();
  renderAll();
});

// 半径を広げたら、スライダーを離したときに広げた分を探す
$('#radius').addEventListener('change', () => {
  radiusDragging = false;
  renderStores();
  autoSearchMissing();
});

$('#store-hint').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action=search-missing]');
  if (btn) withBusy(btn, '検索中…', () => searchStores({ onlyMissing: true }));
});

$('#radius').addEventListener('input', (e) => {
  radiusDragging = true;
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

$('#store-tools').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  for (const t of db.trip) db.ui.openGroups[t.id] = btn.dataset.action === 'open-all';
  save();
  renderStores();
});

$('#store-list').addEventListener('click', (e) => {
  const toggle = e.target.closest('button[data-action=toggle-group]');
  if (toggle) {
    const id = db.trip[Number(toggle.closest('[data-index]').dataset.index)]?.id;
    if (id) {
      db.ui.openGroups[id] = !isGroupOpen(id);
      save();
      renderStores();
    }
    return;
  }
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

$('#stale-banner').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action=replan]');
  if (btn) withBusy(btn, '時刻表を確認中…', () => computePlan(Number(btn.dataset.index), true));
});

$('#plan-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'status') {
    const id = btn.closest('[data-id]')?.dataset.id;
    if (id) setStatus(id, btn.dataset.status);
  } else if (btn.dataset.action === 'toggle-stop') {
    const i = Number(btn.dataset.stop);
    planOpen.set(i, !isStopOpen(i, currentPlanStop(db.plan, currentRecords())));
    renderPlan();
  } else if (btn.dataset.action === 'replan') {
    withBusy(btn, '確認中…', () => computePlan(Number(btn.dataset.index), true));
  }
});

$('#plan-list').addEventListener('change', (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id && e.target.dataset.action === 'note') setNote(id, e.target.value);
});

// 運行情報の「更新」（行程と巡回の 2 か所にある）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action=refresh-info]');
  if (btn) withBusy(btn, '更新中…', () => refreshTrainInfo(true));
});

// ===== タブ =====
// 4 枚のカードを縦に並べると、駅が多いときに長くなりすぎて操作しにくい（2026-09-14 利用者の指摘）ので 1 枚ずつ出す
const TABS = ['trip', 'stores', 'plan', 'nav'];
function setTab(name) {
  const tab = TABS.includes(name) ? name : 'trip';
  db.ui.tab = tab;
  save();
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.panel > [data-panel]').forEach((s) => s.classList.toggle('active', s.dataset.panel === tab));
  // 切り替えた画面の先頭が見えるように戻す（PC はパネルだけがスクロールし、スマホは画面全体がスクロールする）
  const panel = $('.panel');
  if (getComputedStyle(panel).overflowY === 'auto') {
    panel.scrollTop = 0;
  } else {
    const top = panel.getBoundingClientRect().top + window.scrollY;
    if (window.scrollY > top) window.scrollTo({ top });
  }
}

$('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setTab(btn.dataset.tab);
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-goto]');
  if (btn) setTab(btn.dataset.goto);
});

// ===== 起動 =====
document.querySelectorAll('.chain-icon[data-chain]').forEach((el) => { el.innerHTML = CHAINS[el.dataset.chain].icon; });
syncControls();
renderAll();
setTab(db.ui.tab);

if (!ODPT_SOURCES.pub.key && ODPT_SOURCES.pub.base.includes('api.odpt.org')) {
  toast('ODPT のキーが設定されていません。手元では python tools/serve.py で起動してください', 10000);
}

loadNetwork()
  .then((n) => {
    net = n;
    // 以前の保存データは路線ごとの駅 ID で持っているので、駅グループの ID にそろえる
    const toStop = (id) => net.stopById.get(id)?.id ?? id;
    db.trip = db.trip.map((t) => ({ id: toStop(t.id) }));
    db.searched = Object.fromEntries(Object.entries(db.searched).map(([id, r]) => [toStop(id), r]));
    for (const s of db.plan?.stops ?? []) s.stationId = toStop(s.stationId);
    save();
    buildStationLayer();
    fillRailwaySelect();
    renderAll();
    renderStationResults();
    autoSearchMissing();
    refreshTrainInfo();
    // 画面を開いている間は運行情報を取り直す（裏に回っているときは取らない）
    setInterval(() => {
      if (document.visibilityState === 'visible') refreshTrainInfo();
    }, INFO_REFRESH_MS);
    if (db.plan) fitPlan();
    else fitTrip();
  })
  .catch((e) => {
    console.error(e);
    toast(`駅データを読み込めませんでした（${e.message}）`, 10000);
  });
