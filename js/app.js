// 画面: 保存データ・地図・描画・イベント（組み立ては lawson/app.js にならう）
import { ODPT_SOURCES } from './config.js?v=72ab7fe1';
import { busData, loadBus } from './bus.js?v=72ab7fe1';
import { buildReport, canShare, copyReport, mailtoUrl, shareReport } from './report.js?v=72ab7fe1';
import { planAreaRoute } from './area.js?v=72ab7fe1';
import { loadBikeInfo, loadBikeStatus } from './bike.js?v=72ab7fe1';
import { dayProfile, loadNetwork, operatorTitle, railwayTitle, stationName as odptStationName, trainInformation, trainTypeTitle } from './odpt.js?v=72ab7fe1';
import { WALK_FACTOR, WALK_SPEED, buildPlan, commonRailways, hopOptions } from './plan.js?v=72ab7fe1';
import { CHAINS, STATUSES, fetchStoresAround } from './stores.js?v=72ab7fe1';
import { $, esc, fmtDist, fmtDur, fmtMin, getPosition, haversine, nowHHMM, parseHHMM, toast, todayISO, walkNavUrl, withBusy } from './util.js?v=72ab7fe1';

// ===== 設定 =====
const STORAGE_KEY = 'conveniradar:v1';
const NO_NAME_CAMPAIGN = '(名称未設定)';
const STATION_MIN_ZOOM = 12; // 駅は数千あるので、ここまで拡大したら表示する
const SEARCH_LIMIT = 20;

// ===== 保存データ =====
const DEFAULTS = {
  settings: { radius: 600, chains: ['lawson', 'seven', 'ministop'], dwell: 5, transfer: 3, skipRecorded: true, campaign: '', deadline: '', reportTo: '', modes: { rail: true, bus: true, bike: false } },
  trip: [], // [{ id: 駅ID }] 回る順
  stores: [], // 直近の検索結果
  searchedAt: null,
  searched: {}, // { 駅ID: 店舗を検索した半径(m) }
  excluded: {}, // { storeId: true }
  records: {}, // { くじ名: { storeId: { status, note, at } } }
  plan: null,
  tripMode: 'station', // 行程をどちらの探し方で作ったか（area / station）。地図に出すかを決める
  ui: { tab: 'stores', mode: 'station', openGroups: {} }, // 表示中のタブ、探し方（area / station）、店舗一覧で開いている駅 { 駅ID: true/false }
  area: { center: null, source: null, radiusKm: 3, last: null }, // エリア検索の中心 { lat, lng, label }、中心の決め方（gps / map）、半径、直近の結果
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
    return { ...base, ...rest, searched, settings: { ...base.settings, ...raw.settings }, ui: { ...base.ui, ...raw.ui }, area: { ...base.area, ...raw.area } };
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
const BUS_COLOR = '#2b8a3e';
const BIKE_COLOR = '#e8590c';

// 行程の停留所は、駅グループ（stop:…）かバス停（bus:…）。駅 ID・ポール ID からも引ける
function stopById(id) {
  const key = String(id ?? '');
  return key.startsWith('bus:') ? busData()?.stopById.get(key) : net?.stopById.get(key) ?? busData()?.stopById.get(key);
}
const stopName = (id) => stopById(id)?.name ?? odptStationName(id);
const stopWord = (id) => (String(id).startsWith('bus:') ? 'バス停' : '駅');

// 探し方は 2 つ（2026-09-14 利用者の指示で整理。似た設定があちこちにあって使いにくかった）
//   エリア検索: 中心・半径・移動手段から、回る駅・バス停と店を自動で選ぶ
//   駅検索: 回る駅を自分で並べる。駅と駅の間は電車・バス・徒歩のうち一番早い手段
const AREA_WALK_RADIUS = 500; // エリア検索で、選んだ駅・バス停から歩いて回る範囲（m）
const AREA_DEFAULT_MINUTES = 180; // エリア検索で終了時刻が空欄のときの長さ（分）
const STATION_MODES = { rail: true, bus: true, bike: false }; // 駅検索の移動手段
const isAreaMode = () => db.ui.mode === 'area';
const walkRadius = () => (isAreaMode() ? AREA_WALK_RADIUS : db.settings.radius);

function renderSearchBadge() {
  $('#tab-badge-search').textContent = isAreaMode()
    ? (db.area.center ? `エリア${db.area.radiusKm}km` : 'エリア')
    : (db.trip.length ? `${db.trip.length}駅` : '駅');
}

// ===== 操作 =====
function markPlanStale() {
  if (db.plan) db.plan.stale = true;
}

// ids は駅 ID でも駅グループ ID でもよい。行程には駅グループ（乗り換えできる 1 つの駅）で入れる
function addStations(ids) {
  if (blockedWhileSearching()) return;
  let added = 0;
  for (const id of ids.map((x) => stopById(x)?.id ?? x)) {
    if (db.trip.at(-1)?.id === id) continue;
    db.trip.push({ id });
    added++;
  }
  if (!added) return toast('同じ駅が続くため追加しませんでした');
  db.tripMode = 'station';
  markPlanStale();
  save();
  renderAll();
  toast(added === 1 ? `「${stopName(ids.at(-1))}」を追加しました` : `${added}駅を追加しました`);
  autoSearchMissing();
  refreshTrainInfo();
}

function moveTrip(i, delta) {
  if (blockedWhileSearching()) return;
  const k = i + delta;
  if (k < 0 || k >= db.trip.length) return;
  [db.trip[i], db.trip[k]] = [db.trip[k], db.trip[i]];
  db.tripMode = 'station';
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
    const stops = [...new Set(ids.map((id) => stopById(id)?.id).filter(Boolean))];
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
  db.tripMode = 'station';
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
  db.tripMode = 'station';
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
  const limit = walkRadius() * 1.1;
  for (const s of db.stores) {
    if (!db.settings.chains.includes(s.chain)) continue;
    let best = -1;
    let bestD = Infinity;
    for (const [id, i] of first) {
      const st = stopById(id);
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

// 検索中・計算中は、画面の上に理由を出す。操作が止まっているのに理由が分からない、と指摘された（2026-09-14）。
// 店舗の検索（search）と計画の計算（plan / area）が重なることがあるので、理由ごとに持ち、最後に始まったものを出す
const busyReasons = new Map();
function setBusy(key, message) {
  if (message) busyReasons.set(key, message);
  else busyReasons.delete(key);
  const latest = [...busyReasons.values()].at(-1);
  $('#busy').hidden = !latest;
  if (latest) $('#busy-text').textContent = latest;
}

// 店舗の検索中は、行程・半径・計画の操作を止める（検索中に駅や半径が変わると、何を探したかが食い違うため）
let searching = false;
function setSearching(on) {
  searching = on;
  setBusy('search', on ? '🔍 店舗を検索しています…　終わるまで、駅や設定は変えられません' : null);
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
    .filter((id) => (db.searched[id] ?? 0) < walkRadius())
    .map((id) => stopById(id))
    .filter(Boolean);
}

// onlyMissing: 未検索の駅だけを探して、これまでの結果に足す
async function searchStores({ onlyMissing = false } = {}) {
  if (!net) throw new Error('駅データを読み込み中です。少し待ってください');
  if (!db.trip.length) throw new Error('先に回る駅を追加してください');
  const stations = onlyMissing
    ? unsearchedStations()
    : [...new Set(db.trip.map((t) => t.id))].map((id) => stopById(id)).filter(Boolean);
  if (!stations.length) return;

  // 検索中に半径を動かされても、実際に探した半径で「検索済み」を記録する
  // （終わった時点の半径で記録すると、400m で探している間に 800m へ広げたとき、広げた分が探されないままになる）
  const radius = walkRadius();
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
  // 駅検索では、駅を足したら 1 回目から自動で探す（「店舗を検索」ボタンは無くした）。エリア検索は計画を作るときにまとめて探す
  if (isAreaMode() || !net || autoSearching || !db.trip.length || !unsearchedStations().length) return;
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
  for (const s of db.plan?.stops ?? []) if (s.ride?.railway) ids.add(s.ride.railway); // バス・徒歩の区間は除く
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
  setBusy('plan', '🗓 時刻表を確認して計画を作っています…');
  try {
    return await computePlanInner(fromIndex, useNow);
  } finally {
    setBusy('plan', null);
  }
}

async function computePlanInner(fromIndex = 0, useNow = false) {
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
  let deadline = db.settings.deadline ? parseHHMM(db.settings.deadline) : null;
  if (deadline != null && deadline < 4 * 60) deadline += 24 * 60;
  if (deadline != null && deadline <= startMin) {
    throw new Error(`終了時刻 ${db.settings.deadline} が、始める時刻 ${startTime} より前です。終了時刻を直すか「なし」にしてください`);
  }
  // エリア検索で終了時刻が空欄のときは、回る駅を選んだときの終了（開始から 3 時間）を、組み直しでも使う
  if (deadline == null && isAreaMode() && db.area.autoEnd > startMin) deadline = db.area.autoEnd;

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
    deadline,
    modes: isAreaMode() ? { ...DEFAULTS.settings.modes, ...db.settings.modes } : STATION_MODES,
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
  renderReport();
}

// ===== 地図 =====
const map = L.map('map', { keyboard: false, preferCanvas: true }).setView([35.681, 139.767], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

const layers = {
  stations: L.layerGroup(),
  busStops: L.layerGroup().addTo(map),
  area: L.layerGroup().addTo(map),
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

// バス停は 1 万以上あるので、さらに拡大したときに、見えている範囲の分だけ出す
const BUS_MIN_ZOOM = 15;
function syncBusLayer() {
  layers.busStops.clearLayers();
  if (map.getZoom() < BUS_MIN_ZOOM || !busData()) return;
  const bounds = map.getBounds().pad(0.2);
  for (const stop of busData().stops) {
    if (!bounds.contains([stop.lat, stop.lng])) continue;
    L.circleMarker([stop.lat, stop.lng], {
      radius: 5, color: '#fff', weight: 1.5, fillColor: BUS_COLOR, fillOpacity: 0.95,
    })
      .bindTooltip(`🚌 ${stop.name}`, { direction: 'top', offset: [0, -5] })
      .bindPopup(() => busStopPopup(stop))
      .addTo(layers.busStops);
  }
}
map.on('moveend', syncBusLayer);

function busStopPopup(stop) {
  const pos = db.trip.map((t, i) => (t.id === stop.id ? i + 1 : 0)).filter(Boolean);
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <b>🚌 ${esc(stop.name)}</b>
    <div class="muted small">${esc(stop.operators.join('・'))} ・ ${esc(stop.routes.slice(0, 8).join('・'))}</div>
    ${pos.length ? `<div class="small">行程の ${pos.join('・')} 番目</div>` : ''}
    <button class="btn small primary block" type="button">＋ 行程の最後に追加</button>`;
  div.querySelector('button').onclick = () => {
    map.closePopup();
    addStations([stop.id]);
  };
  return div;
}

// 駅のマーカー（路線ごとの駅）から開いても、乗り換えできる駅全体として出す
function stationPopup(st) {
  const stop = stopById(st.id) ?? st;
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

// 地図に出す行程（駅のピン・範囲の円・店・ルート）は、いまの探し方で作った行程のときだけ。
// 駅検索で駅を指定したあとエリア検索に切り替えると、駅検索の情報が地図に残っていた（2026-09-14）。
// 巡回タブでは、どちらで作った計画でも回っている最中なので出す
function syncMapLayers() {
  const show = !isAreaMode() || db.tripMode === 'area' || db.ui.tab === 'nav';
  for (const layer of [layers.trip, layers.stores, layers.route]) {
    if (show && !map.hasLayer(layer)) layer.addTo(map);
    if (!show && map.hasLayer(layer)) map.removeLayer(layer);
  }
}

function tripBounds() {
  const pts = db.trip.map((t) => stopById(t.id)).filter(Boolean).map((s) => [s.lat, s.lng]);
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
  renderReport();
  renderArea();
  syncMapLayers();
}

function renderTrip() {
  layers.trip.clearLayers();
  renderSearchBadge();
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
      // 電車の路線・バスの系統・徒歩（1.5km 以内）のうち、使えるものを並べる
      const opt = hopOptions(net, t.id, next.id);
      const parts = [
        ...links.map((l) => l.railway.title + (alertOf(l.railway.id) ? `（⚠${alertOf(l.railway.id).status}）` : '')),
        ...(opt.bus.length ? [`🚌 ${[...new Set(opt.bus.map((l) => l.pattern.route).filter(Boolean))].slice(0, 4).join('・')}`] : []),
        ...(opt.walk ? [`🚶 徒歩 約${Math.max(1, Math.round(opt.walk.min))}分`] : []),
      ];
      link = parts.length
        ? `<div class="trip-link">↓ ${esc(parts.join(' / '))}
            ${fills.map((f, k) => `<button class="btn small ghost" type="button" data-action="fill" data-fill="${k}">＋ 間の${f.stops.length}駅を追加（${esc(f.titles.join('・'))}）</button>`).join('')}
          </div>`
        : '<div class="trip-link warn">↓ 乗り換えなしで行ける電車・バスがなく、歩くにも遠すぎます。乗り換えにはまだ対応していないので、間に乗り換える駅・バス停を追加してください</div>';
    }
    return `
      <li class="trip-item" data-index="${i}">
        <div class="row">
          <span class="num" style="--c:var(--primary)">${i + 1}</span>
          <span class="grow store-name">${esc(stopName(t.id))}</span>
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
    const st = stopById(id);
    if (!st) continue;
    L.circle([st.lat, st.lng], {
      radius: walkRadius(), color: '#0b7285', weight: 1, fillOpacity: 0.05, interactive: false,
    }).addTo(layers.trip);
    L.marker([st.lat, st.lng], { icon: pinIcon(st.kind === 'bus' ? BUS_COLOR : '#0b7285', nums.join('・')), zIndexOffset: 1000 })
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
  const hits = [...net.stops, ...(busData()?.stops ?? [])]
    .filter((s) => norm(s.name).includes(q))
    .sort((a, b) => (norm(b.name) === q) - (norm(a.name) === q) || a.name.length - b.name.length)
    .slice(0, SEARCH_LIMIT);
  box.innerHTML = hits.length
    ? hits.map((s) => `
      <li><button type="button" class="result" data-id="${esc(s.id)}">
        <b>${s.kind === 'bus' ? '🚌' : '🚉'} ${esc(s.name)}</b>
        <span class="muted small">${esc(s.kind === 'bus' ? `バス停 ・ ${s.operators.join('・')} ${s.routes.slice(0, 6).join('・')}` : s.railways.map(railwayLabel).join('、'))}</span>
      </button></li>`).join('')
    : `<li class="empty">見つかりません（時刻表のある駅・バス停だけを収録しています）${busData() ? '' : '。バス停は読み込み中です'}</li>`;
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
  const opts = rw ? rw.order.map((id, i) => `<option value="${i}">${esc(stopName(id))}</option>`).join('') : '';
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
  const narrowed = stopIds.some((id) => (db.searched[id] ?? 0) > walkRadius());
  let html = '';
  let quiet = false;
  if (isAreaMode() || !db.trip.length) {
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
  $('#tab-badge-stores').textContent = `${db.settings.chains.length}種類`;
  $('#store-tools').hidden = !db.searchedAt || new Set(db.trip.map((t) => t.id)).size < 2;
  const pending = new Set(unsearchedStations().map((s) => s.id));
  renderStoreHint(pending);

  // 店のマーカーは一覧より先に作る。地図に出すかは syncMapLayers が決める
  // （一覧を出さないときに先に抜けていて、エリア検索中に巡回タブを開くと店が地図に出なかった）
  for (const s of all) {
    const done = !!records[s.id]?.status;
    const marker = L.marker([s.lat, s.lng], {
      icon: storeIcon(s.chain, done ? '✓' : planNo.get(s.id), { done, faded: !!db.excluded[s.id] }),
    }).bindPopup(() => storePopup(s)).addTo(layers.stores);
    storeMarkers.set(s.id, marker);
  }

  const list = $('#store-list');
  // エリア検索でまだ選んでいないときは、駅検索で作った行程の店を出さない
  if (!db.trip.length || !db.searchedAt || (isAreaMode() && db.tripMode !== 'area')) {
    list.innerHTML = `<li class="empty">${isAreaMode() ? 'エリア検索では、計画を作ると、選んだ駅・バス停ごとの店がここに出ます'
      : db.trip.length ? '店舗を探しています…' : '「探す」タブで回る駅を追加すると、近くの店がここに出ます'}</li>`;
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
          <span class="group-name">${esc(stopName(id))}</span>
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

// バスと徒歩の区間の行（電車は renderPlan の中）
function otherRideRow(s, nextName) {
  const r = s.ride;
  if (r.mode === 'bike') {
    return `<li class="tl-ride bike" style="--c:${BIKE_COLOR}">
      <div>🚲 <b>${esc(r.system)}</b> ${esc(r.rent.name)} で借りる（${r.rent.bikes}台）</div>
      <div class="muted small">🚶${Math.max(1, Math.round(r.walkTo))}分 → 🚲 約${Math.max(1, Math.round(r.rideMin))}分（${fmtDist(r.dist)}）→ ${esc(r.ret.name)} に返す（空き${r.ret.docks}）→ 🚶${Math.max(1, Math.round(r.walkFrom))}分 → <b>${fmtMin(r.arr)} ${esc(nextName)}着</b></div>
      <div class="muted small">台数・空きは計画を作った時点のものです</div>
    </li>`;
  }
  if (r.mode === 'walk') {
    return `<li class="tl-hop-walk">🚶 <b>${esc(nextName)}まで徒歩</b> 約${Math.max(1, Math.round(r.arr - r.dep))}分（${fmtDist(r.dist)}）→ ${fmtMin(r.arr)}着</li>`;
  }
  return `<li class="tl-ride bus" style="--c:${BUS_COLOR}">
      <div>🚌 <b>${fmtMin(r.dep)}発</b> ${esc(r.route)} ${r.dest ? `${esc(r.dest)}行` : ''}</div>
      <div class="muted small">${esc(r.operator)} ・ 待ち${Math.max(0, Math.round(r.dep - s.ready))}分 → <b>${fmtMin(r.arr)}着</b></div>
    </li>`;
}

const destLabel = (dest) => (dest?.length ? `${dest.map(stopName).join('・')}行` : '');

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
  const firstName = stopName(p.stops[0]?.stationId);

  $('#plan-summary').innerHTML = `
    <div class="summary">
      <div><span class="big">${p.visited}</span><span class="label">店舗</span></div>
      <div><span class="big">${fmtDur(p.walkMin * 60)}</span><span class="label">歩く時間</span></div>
      <div><span class="big">${p.endMin != null ? fmtMin(p.endMin) : '—'}</span><span class="label">終了</span></div>
    </div>
    <p class="small">${esc(p.date)} ${fmtMin(p.startMin)} ${esc(firstName)}から ${p.stops.length}か所・移動${rides.length}回</p>
    ${rides.some((r) => r.estimated) ? '<p class="small muted">「推定」の着時刻は、次の駅の時刻表や距離から見積もったものです</p>' : ''}
    ${usesChallenge ? `<p class="small muted">公共交通オープンデータチャレンジの時刻表を含みます（${ODPT_SOURCES.chl.until} まで）</p>` : ''}
    ${p.deadline != null ? `<p class="small">⏰ 終了時刻 ${fmtMin(p.deadline)}（駅に戻るまで）・ ${p.dropped ? `間に合わない ${p.dropped}店を外しました` : '選んだ店はすべて間に合います'}</p>` : ''}
    ${p.cutoff ? `<p class="small warn">⏰ ${esc(p.cutoff)}</p>` : ''}
    ${!p.complete ? `<p class="small warn">⚠ 途中までしか計画できませんでした。${esc(p.error ?? '')}</p>` : ''}
    ${p.stale ? '<p class="small warn">⚠ 駅・店舗・設定が変わりました。計画を作り直してください</p>' : ''}`;

  // 地図: 駅から店を回る徒歩は破線、駅間の乗車は路線の色の実線
  p.stops.forEach((s, i) => {
    const st = stopById(s.stationId);
    if (!st) return;
    if (s.visits.length) {
      L.polyline([[st.lat, st.lng], ...s.visits.map((v) => [v.store.lat, v.store.lng]), [st.lat, st.lng]], {
        color: '#c2255c', weight: 4, opacity: 0.75, dashArray: '6 8', interactive: false,
      }).addTo(layers.route);
    }
    const nx = s.ride && stopById(p.stops[i + 1]?.stationId);
    if (nx) {
      const line = [[st.lat, st.lng], [nx.lat, nx.lng]];
      const alert = alertOf(s.ride.railway);
      if (alert) {
        // 遅延・運転見合わせの区間は太いオレンジで囲み、触れると本文を出す
        L.polyline(line, { color: '#e8590c', weight: 16, opacity: 0.4 })
          .bindTooltip(`⚠ ${esc(alert.status)}：${esc(alert.text)}`, { sticky: true, className: 'info-tip' })
          .addTo(layers.route);
      }
      // 電車は路線の色の実線、バスは緑の破線、徒歩は灰色の点線
      const style = s.ride.mode === 'bike' ? { color: BIKE_COLOR, weight: 5 }
        : s.ride.mode === 'bus' ? { color: BUS_COLOR, weight: 5, dashArray: '10 6' }
        : s.ride.mode === 'walk' ? { color: '#495057', weight: 4, dashArray: '2 8' }
          : { color: railwayColor(s.ride.railway), weight: 6 };
      // 自転車は、停留所 → 借りるポート → 返すポート → 次の停留所 と描き、ポートに印を付ける
      const r = s.ride;
      const path = r.mode === 'bike' ? [[st.lat, st.lng], [r.rent.lat, r.rent.lon], [r.ret.lat, r.ret.lon], [nx.lat, nx.lng]] : line;
      L.polyline(path, { ...style, opacity: 0.8, interactive: false }).addTo(layers.route);
      if (r.mode === 'bike') {
        for (const [pt, label] of [[r.rent, `🚲 借りる：${r.rent.name}（${r.rent.bikes}台）`], [r.ret, `🚲 返す：${r.ret.name}（空き${r.ret.docks}）`]]) {
          L.circleMarker([pt.lat, pt.lon], { radius: 7, color: '#fff', weight: 2, fillColor: BIKE_COLOR, fillOpacity: 1 })
            .bindTooltip(esc(label))
            .addTo(layers.route);
        }
      }
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
      ${from >= 0 ? `<button class="btn primary block" type="button" data-action="replan" data-index="${from}">🔄 今の時刻で組み直す（${esc(stopName(db.trip[from].id))}から・記録済みの店を除く）</button>` : ''}`;
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
            <span class="store-name">${esc(stopName(s.stationId))} ${i === current ? '<span class="here">回っているところ</span>' : ''}</span>
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
      ? `<li class="tl-walk">🚶 ${stopWord(s.stationId)}へ戻る ${fmtDur(s.backLeg.min * 60)}（${fmtDist(s.backLeg.dist)}）→ ${fmtMin(s.ready)} 着</li>`
      : '';

    const ride = ['bus', 'walk', 'bike'].includes(s.ride?.mode) ? otherRideRow(s, stopName(p.stops[i + 1]?.stationId)) : s.ride
      ? `<li class="tl-ride" style="--c:${railwayColor(s.ride.railway)}">
          <div><b>${fmtMin(s.ride.dep)}発</b> ${esc(trainTypeTitle(s.ride.type))} ${esc(destLabel(s.ride.dest))}</div>
          <div class="muted small">${esc(railwayLabel(s.ride.railway))} ・ 駅で${Math.max(0, Math.round(s.ride.dep - s.ready))}分待ち → <b>${fmtMin(s.ride.arr)}着</b>${s.ride.estimated ? '（推定）' : ''}</div>
          ${alertOf(s.ride.railway) ? `<div class="small warn">⚠ ${esc(alertOf(s.ride.railway).status)}：${esc(alertOf(s.ride.railway).text)}</div>` : ''}
        </li>`
      : '';

    const err = s.error ? `<li class="tl-error">⚠ ${esc(s.error)}</li>` : '';
    const dropped = s.dropped?.length
      ? `<li class="tl-walk warn">⏰ 終了時刻に間に合わないので ${s.dropped.length}店を外しました（${esc(s.dropped.slice(0, 3).map((d) => d.name).join('、'))}${s.dropped.length > 3 ? ' ほか' : ''}）</li>`
      : '';
    const cutoff = s.cutoff ? `<li class="tl-error">⏰ ${esc(s.cutoff)}</li>` : '';
    return head + dropped + stores + back + ride + cutoff + err;
  }).join('') + (p.endMin != null ? `
      <li class="tl-station">
        <span class="num" style="--c:#495057">🏁</span>
        <div class="stop-info"><div class="store-name">終了</div><div class="muted small">${fmtMin(p.endMin)}</div></div>
      </li>` : '');
}

// ===== 実績を送る =====
// 記録を、計画の順（無ければ行程の順）に停留所ごとにまとめる。外した店の記録も、その停留所に書く
function reportGroups() {
  const groups = (db.plan?.stops ?? []).map((s) => ({
    name: stopName(s.stationId),
    stores: [...s.visits.map((v) => v.store), ...(s.dropped ?? [])],
  }));
  const assigned = assignStores();
  db.trip.forEach((t, i) => {
    if (assigned[i]?.length) groups.push({ name: stopName(t.id), stores: assigned[i] });
  });
  return groups;
}

function currentReport() {
  const planStores = (db.plan?.stops ?? []).flatMap((s) => s.visits.map((v) => v.store));
  return buildReport({ campaign: campaignKey(), records: currentRecords(), groups: reportGroups(), stores: [...db.stores, ...planStores] });
}

function renderReport() {
  const report = currentReport();
  $('#report-count').textContent = report.count ? `記録 ${report.count}件` : 'まだ記録がありません';
  const mail = $('#btn-report-mail');
  mail.href = mailtoUrl(db.settings.reportTo, report);
  mail.classList.toggle('disabled', !report.count);
  $('#btn-report-share').hidden = !canShare();
  $('#report-preview').textContent = `${report.subject}\n\n${report.body}`;
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
  for (const t of db.trip) for (const r of stopById(t.id)?.railways ?? []) ops.add(net.railwayById.get(r)?.operator);
  const names = [...new Set([...[...ops].filter(Boolean).map(operatorTitle), ...db.trip.flatMap((t) => stopById(t.id)?.operators ?? [])])];
  document.querySelectorAll('.odpt-owner').forEach((el) => { el.textContent = names.length ? names.join('・') : '各事業者'; });
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
  $('#plan-deadline').value = s.deadline;
  $('#report-to').value = s.reportTo;
  const modes = { ...DEFAULTS.settings.modes, ...s.modes };
  document.querySelectorAll('input[name=mode]').forEach((el) => { el.checked = !!modes[el.value]; });
  $('#campaign').value = s.campaign;
  $('#plan-date').value = todayISO();
  $('#plan-start').value = nowHHMM();
  syncModeSwitch();
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
  db.tripMode = 'station';
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

// 「計画を作る」は 1 つ。エリア検索なら回る駅と店を選んでから、駅検索なら行程のまま計画を作る
$('#btn-plan').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  withBusy(btn, isAreaMode() ? '準備中…' : '時刻表を確認中…', () => (isAreaMode() ? computeArea(btn) : computePlan(0, false)));
});

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

// 使う移動手段（電車・バス・シェアサイクル）。エリア検索で使う。徒歩は常に使う
document.querySelectorAll('input[name=mode]').forEach((el) => el.addEventListener('change', (e) => {
  db.settings.modes = { ...DEFAULTS.settings.modes, ...db.settings.modes, [e.target.value]: e.target.checked };
  markPlanStale();
  save();
  renderPlan();
}));

function setDeadline(value) {
  db.settings.deadline = value;
  $('#plan-deadline').value = value;
  markPlanStale();
  save();
  renderPlan();
}
$('#plan-deadline').addEventListener('change', (e) => setDeadline(e.target.value));
$('#btn-clear-deadline').addEventListener('click', () => setDeadline(''));

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

// 実績を送る（宛先はこの端末の localStorage にだけ保存する）
$('#report-to').addEventListener('change', (e) => {
  db.settings.reportTo = e.target.value.trim();
  save();
  renderReport();
});

$('#btn-report-mail').addEventListener('click', (e) => {
  if (!currentReport().count) {
    e.preventDefault();
    toast('まだ記録がありません');
  }
});

$('#btn-report-share').addEventListener('click', (e) => withBusy(e.currentTarget, '共有中…', async () => {
  try {
    await shareReport(currentReport());
  } catch (err) {
    if (err.name !== 'AbortError') throw err; // 共有メニューを閉じただけなら何もしない
  }
}));

$('#btn-report-copy').addEventListener('click', (e) => withBusy(e.currentTarget, 'コピー中…', async () => {
  await copyReport(currentReport());
  toast('記録をコピーしました。メールや LINE に貼り付けて送れます');
}));

// 運行情報の「更新」（行程と巡回の 2 か所にある）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action=refresh-info]');
  if (btn) withBusy(btn, '更新中…', () => refreshTrainInfo(true));
});

// ===== エリア巡回モード =====
const AREA_COLOR = '#7048e8';

// time 入力の形（HH:MM）。四捨五入してから時と分に分ける（659.6 分を 10:00 にしないため）
function toHHMM(min) {
  const r = Math.round(min);
  return `${String(Math.floor(r / 60) % 24).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}

function renderArea() {
  const a = db.area;
  layers.area.clearLayers();
  $('#area-radius').value = a.radiusKm;
  $('#area-radius-out').textContent = a.radiusKm;
  // 中心の決め方は選択式。選んでいる方のボタンの色を変える（押しても色が変わらず分かりにくかった）
  const sourceLabel = a.source === 'gps' ? '📍 現在地'
    : a.source === 'map' ? '🗺 地図の中心（地図を動かすと、中心と範囲も動きます）' : a.center?.label;
  $('#area-center').textContent = a.center ? `中心：${sourceLabel}` : '中心：未設定（📍 現在地 か 🗺 地図の中心 を選んでください）';
  $('#btn-area-locate').setAttribute('aria-pressed', String(a.source === 'gps'));
  $('#btn-area-mapcenter').setAttribute('aria-pressed', String(a.source === 'map'));
  renderSearchBadge();
  if (a.center && isAreaMode()) {
    L.circle([a.center.lat, a.center.lng], {
      radius: a.radiusKm * 1000, color: AREA_COLOR, weight: 2, dashArray: '6 6', fillOpacity: 0.03, interactive: false,
    }).addTo(layers.area);
    L.marker([a.center.lat, a.center.lng], { icon: pinIcon(AREA_COLOR, '🧭'), zIndexOffset: 900 })
      .bindTooltip(`エリアの中心（${a.center.label}）`)
      .addTo(layers.area);
  }
  const l = a.last;
  $('#area-summary').innerHTML = !l || !isAreaMode() ? '' : `
    ${l.autoEnd ? `<p class="small">⏰ 終了時刻が空欄なので、開始から 3 時間（${fmtMin(l.autoEnd)} まで）で選びました</p>` : ''}
    <div class="summary">
      <div><span class="big">${l.chosen}</span><span class="label">駅・バス停</span></div>
      <div><span class="big">${l.estimate}</span><span class="label">店（見積もり）</span></div>
      <div><span class="big">${fmtMin(l.estimateEnd)}</span><span class="label">終了（見積もり）</span></div>
    </div>
    <p class="small">範囲内の候補 ${l.candidates}店・店のある駅・バス停 ${l.bases}か所 から選びました。${esc(l.startName)}まで徒歩 約${Math.max(1, Math.round(l.walkToStart))}分から始めます。</p>
    <p class="small muted">見積もりは平均的な待ち時間と速さで出したものです。実際の時刻表での計画は「巡回」タブに出ます（見積もりより店が減ることがあります）。</p>`;
}

function setAreaCenter(center, source, { fit = true } = {}) {
  db.area.center = center;
  db.area.source = source;
  markPlanStale();
  save();
  renderArea();
  renderPlan();
  if (fit) map.fitBounds(L.latLng(center.lat, center.lng).toBounds(db.area.radiusKm * 2000));
}

async function computeArea(btn) {
  try {
    return await computeAreaInner(btn);
  } finally {
    setBusy('area', null);
  }
}

async function computeAreaInner(btn) {
  const step = (msg) => {
    btn.textContent = msg;
    setBusy('area', `🧭 ${msg}`);
  };
  if (!net) throw new Error('駅データを読み込み中です。少し待ってください');
  const area = db.area;
  if (!area.center) throw new Error('先に中心を決めてください（📍 現在地 か 🗺 地図の中心）');
  const startTime = $('#plan-start').value || nowHHMM();
  let startMin = parseHHMM(startTime);
  if (startMin < 4 * 60) startMin += 24 * 60;
  let deadline = db.settings.deadline ? parseHHMM(db.settings.deadline) : null;
  if (deadline != null && deadline < 4 * 60) deadline += 24 * 60;
  if (deadline != null && deadline <= startMin) throw new Error(`終了時刻 ${db.settings.deadline} が、開始時刻 ${startTime} より前です`);
  // 終了時刻が空欄なら 3 時間。時間の上限が無いと、回る店を選べない（範囲内の店を全部回る計画になってしまう）
  const autoEnd = deadline == null ? startMin + AREA_DEFAULT_MINUTES : null;
  if (autoEnd != null) deadline = autoEnd;
  area.autoEnd = autoEnd;
  const modes = { ...DEFAULTS.settings.modes, ...db.settings.modes };

  step('データを読み込み中…');
  if (modes.bus) await loadBus();
  if (modes.bike) await Promise.all([loadBikeInfo(), loadBikeStatus()]);

  step('範囲内の店舗を検索中…');
  const walkR = AREA_WALK_RADIUS;
  setSearching(true);
  let found;
  try {
    found = await fetchStoresAround([area.center], area.radiusKm * 1000 + walkR, { timeoutScale: 3 });
  } finally {
    setSearching(false);
  }

  step('回る順番を選んでいます…');
  await new Promise((r) => setTimeout(r, 30)); // ボタンの表示を更新させてから重い計算に入る
  const records = currentRecords();
  const candidates = found.filter((s) => db.settings.chains.includes(s.chain) && !db.excluded[s.id] && !(db.settings.skipRecorded && records[s.id]?.status));
  const result = planAreaRoute({
    net,
    bus: modes.bus ? busData() : null,
    center: area.center,
    radiusM: area.radiusKm * 1000,
    stores: candidates,
    walkRadiusM: walkR,
    startMin,
    deadline,
    dwell: db.settings.dwell,
    transfer: db.settings.transfer,
    modes,
  });

  // 選んだ順番を行程に入れる。店舗は範囲全体で探し済みなので、選んだ停留所は検索済みにする
  db.trip = result.route.map((r) => ({ id: r.base.id }));
  db.tripMode = 'area';
  db.stores = found;
  db.searchedAt = Date.now();
  db.searched = Object.fromEntries(db.trip.map((t) => [t.id, walkR]));
  db.plan = null;
  db.ui.openGroups = {};
  area.last = {
    candidates: candidates.length,
    bases: result.bases,
    chosen: result.route.length,
    estimate: result.visited,
    estimateEnd: result.endMin,
    walkToStart: result.walkToStart,
    startName: result.start.name,
    autoEnd,
  };
  save();
  renderAll();

  // 実際の時刻表で計画を作る。最初の停留所にいる時刻は、中心からの徒歩を足した時刻
  step('時刻表で計画を作っています…');
  $('#plan-start').value = toHHMM(startMin + result.walkToStart);
  try {
    await computePlan(0, false);
  } finally {
    $('#plan-start').value = startTime; // 入力欄は利用者が入れた開始時刻に戻す
  }
}

$('#btn-area-locate').addEventListener('click', (e) => withBusy(e.currentTarget, '📍 取得中…', async () => {
  const pos = await getPosition();
  setAreaCenter({ lat: pos.lat, lng: pos.lng, label: '現在地' }, 'gps');
  toast(`現在地を中心にしました${pos.accuracy ? `（誤差 約${Math.round(pos.accuracy)}m）` : ''}`);
}));

$('#btn-area-mapcenter').addEventListener('click', () => {
  const c = map.getCenter();
  setAreaCenter({ lat: c.lat, lng: c.lng, label: '地図の中心' }, 'map', { fit: false });
  toast('地図の中心を中心にしました。地図を動かすと、範囲も一緒に動きます');
});

// 「地図の中心」を選んでいる間は、探すタブで地図を動かすと中心も動かす（巡回中に地図を動かしても変えない）
map.on('moveend', () => {
  if (!isAreaMode() || db.area.source !== 'map' || db.ui.tab !== 'search' || searching) return;
  const c = map.getCenter();
  const cur = db.area.center;
  if (cur && Math.abs(cur.lat - c.lat) < 1e-6 && Math.abs(cur.lng - c.lng) < 1e-6) return;
  db.area.center = { lat: c.lat, lng: c.lng, label: '地図の中心' };
  markPlanStale();
  save();
  renderArea();
  renderPlan();
});

// 計画のあとに中心・半径を変えても、選んだ結果は消さずに「計画が古い」にする（回っている最中に店の一覧が消えないように）
$('#area-radius').addEventListener('input', (e) => {
  db.area.radiusKm = Number(e.target.value);
  markPlanStale();
  save();
  renderArea();
  renderPlan();
  // 範囲の円がちょうど収まるように、地図も拡大・縮小する
  const c = db.area.center;
  if (c) map.fitBounds(L.latLng(c.lat, c.lng).toBounds(db.area.radiusKm * 2000), { animate: false });
});

// ===== 探し方（エリア検索／駅検索） =====
function syncModeSwitch() {
  const mode = isAreaMode() ? 'area' : 'station';
  document.querySelectorAll('.mode-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  document.querySelectorAll('[data-mode-panel]').forEach((p) => p.classList.toggle('active', p.dataset.modePanel === mode));
  $('#plan-start-label').textContent = mode === 'area' ? '開始時刻（中心にいる時刻）' : '開始時刻（最初の駅にいる時刻）';
  $('#btn-plan').textContent = mode === 'area' ? '🧭 回る駅と店を決めて計画を作る' : '🗓 時刻表で計画を作る';
}

function setMode(mode) {
  if (blockedWhileSearching()) return;
  db.ui.mode = mode === 'area' ? 'area' : 'station';
  save();
  syncModeSwitch();
  renderAll();
  if (isAreaMode() && db.area.center) map.fitBounds(L.latLng(db.area.center.lat, db.area.center.lng).toBounds(db.area.radiusKm * 2000));
  else fitTrip();
  autoSearchMissing();
}

$('.mode-switch').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (btn) setMode(btn.dataset.mode);
});

// ===== タブ =====
// カードを縦に並べると、駅が多いときに長くなりすぎて操作しにくい（2026-09-14 利用者の指摘）ので 1 枚ずつ出す
// 進み方は 店舗 → 探す → 計画 → 巡回（2026-09-14 利用者の指示で、店舗を最初に選ぶ形にした）
const TABS = ['stores', 'search', 'plan', 'nav'];
function setTab(name) {
  const tab = TABS.includes(name) ? name : 'stores';
  db.ui.tab = tab;
  save();
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.panel > [data-panel]').forEach((s) => s.classList.toggle('active', s.dataset.panel === tab));
  syncMapLayers();
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
if (db.ui.tab === 'area') db.ui.mode = 'area'; // 以前の「エリア」タブを開いていた保存データ
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
    const toStop = (id) => stopById(id)?.id ?? id;
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
    // バス停（2MB あまり）は駅のあとに読む。行程にバス停があるときは、計画づくり（buildPlan）が読み終わりを待つ
    loadBus()
      .then(() => {
        syncBusLayer();
        renderAll();
        renderStationResults();
        autoSearchMissing();
      })
      .catch((e) => {
        console.warn(e);
        toast(`バス停のデータを読み込めませんでした（${e.message}）`, 8000);
      });
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
