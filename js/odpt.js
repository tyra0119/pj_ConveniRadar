// ODPT の問い合わせと、時刻表から「乗る列車」を決める処理
import { DATA_V, ODPT_SOURCES } from './config.js?v=b42fc3b1';
import { fetchJson, fmtMin, haversine, parseHHMM } from './util.js?v=b42fc3b1';

const SERVICE_DAY_START = 4 * 60; // 鉄道の 1 日は 4:00 から。0:10 発の終電は 24:10 として数える
const RIDE_SLOW = 250; // 所要時間の上限を見積もる速さ（m/分 = 15km/h）。これより遅い一致は別の列車とみなす
const RIDE_TYPICAL = 600; // 終着駅に着く時刻を見積もる速さ（m/分 = 36km/h）
const PICK_WINDOW = 40; // 最初に乗れる列車から何分後までを比べるか（後から出る速い列車に抜かれる場合）
const OR_LIMIT = 10; // ODPT の OR 条件（カンマ区切り）の上限（2026-09-02 以降）
// 同じ名前でこの距離以内の駅は、乗り換えできる 1 つの駅とみなす（池袋の JR・東武・西武・メトロなど）
const STOP_RADIUS = 800;

export const serviceMin = (m) => (m % 1440 < SERVICE_DAY_START ? (m % 1440) + 1440 : m % 1440);

export async function odpt(src, path, params = {}, timeoutMs = 30000) {
  const s = ODPT_SOURCES[src];
  const url = new URL(s.base + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  if (s.key) url.searchParams.set('acl:consumerKey', s.key);
  try {
    return await fetchJson(url, {}, timeoutMs);
  } catch (e) {
    // エラーに URL（＝キー）を載せない
    const what = e.name === 'AbortError' ? 'タイムアウト' : e.message;
    throw new Error(`時刻表を取得できませんでした（${s.label}：${what}）`);
  }
}

// ===== 駅・路線の一覧（tools/build_data.py が作る） =====
let network;
export async function loadNetwork() {
  if (network) return network;
  const j = await fetchJson(`data/network.json${DATA_V}`, {}, 30000);
  const railways = j.railways;
  const stations = j.stations.map(([id, name, lat, lng, rs]) => ({ id, name, lat, lng, railways: rs.map((i) => railways[i].id) }));
  const stops = groupStations(stations);
  const stopById = new Map();
  for (const stop of stops) {
    stopById.set(stop.id, stop);
    for (const id of stop.stations) stopById.set(id, stop);
  }
  network = {
    generatedAt: j.generatedAt,
    operators: j.operators,
    trainTypes: j.trainTypes,
    railways,
    railwayById: new Map(railways.map((r) => [r.id, r])),
    stations,
    stationById: new Map(stations.map((s) => [s.id, s])),
    stops,
    stopById, // 駅グループ ID と、その中の駅 ID のどちらからでも引ける
    otherStationNames: j.stationNames ?? {},
  };
  return network;
}

// ODPT の駅 ID は事業者・路線ごとに別（池袋だけで 7 つ）。利用者が選ぶ「駅」は名前と距離でまとめる。
// 「押上〈スカイツリー前〉」と「押上」のような副名は外して比べる
function groupStations(stations) {
  const key = (name) => name.replace(/[〈（(].*?[〉）)]/g, '').trim();
  const byName = new Map();
  for (const s of stations) byName.set(key(s.name), [...(byName.get(key(s.name)) ?? []), s]);

  const stops = [];
  for (const list of byName.values()) {
    const clusters = [];
    for (const s of list) {
      const near = clusters.find((members) => members.some((m) => haversine(m, s) <= STOP_RADIUS));
      if (near) near.push(s);
      else clusters.push([s]);
    }
    for (const members of clusters) {
      const ids = members.map((m) => m.id).sort();
      stops.push({
        id: `stop:${ids[0]}`,
        name: members.map((m) => m.name).sort((a, b) => a.length - b.length)[0],
        lat: members.reduce((t, m) => t + m.lat, 0) / members.length,
        lng: members.reduce((t, m) => t + m.lng, 0) / members.length,
        stations: ids,
        railways: [...new Set(members.flatMap((m) => m.railways))],
      });
    }
  }
  return stops;
}

const tail = (id) => String(id ?? '').split('.').pop();
export const stationName = (id) => network?.stopById.get(id)?.name ?? network?.otherStationNames[id] ?? tail(id);
export const railwayTitle = (id) => network?.railwayById.get(id)?.title ?? tail(id);
export const operatorTitle = (id) => network?.operators[id] ?? tail(id);
export const trainTypeTitle = (id) => (id ? network?.trainTypes[id] ?? tail(id) : '');

// ===== 運行情報 =====
// 全路線分でもセンター 21 件・チャレンジ 121 件（2026-09-14 実測）と小さいので、路線を絞らず一度に取る。
// 平常時は odpt:trainInformationStatus が無く、本文が「平常どおり運転しています」になる
const INFO_RANK = { alert: 2, notice: 1, normal: 0 };
let infoCache = null;
export async function trainInformation({ maxAgeMs = 120000 } = {}) {
  if (infoCache && Date.now() - infoCache.at < maxAgeMs) return infoCache.byRailway;
  let failed = 0;
  const lists = await Promise.all(['pub', 'chl'].map((src) => odpt(src, 'odpt:TrainInformation').catch((e) => {
    console.warn(e);
    failed++;
    return [];
  })));
  if (failed === 2) throw new Error('運行情報を取得できませんでした');

  const byRailway = new Map();
  for (const item of lists.flat()) {
    const rid = item['odpt:railway'];
    if (!rid) continue;
    const status = item['odpt:trainInformationStatus']?.ja ?? '';
    const info = {
      railway: rid,
      status,
      text: item['odpt:trainInformationText']?.ja ?? '',
      date: item['dc:date'],
      level: !status ? 'normal' : status === 'お知らせ' ? 'notice' : 'alert',
    };
    // 同じ路線が両方にある・方面ごとに分かれているときは、重い方を使い、同じ重さなら本文をつなげる
    const cur = byRailway.get(rid);
    if (!cur || INFO_RANK[info.level] > INFO_RANK[cur.level]) byRailway.set(rid, info);
    else if (info.level !== 'normal' && info.level === cur.level && !cur.text.includes(info.text)) cur.text += `／${info.text}`;
  }
  infoCache = { at: Date.now(), byRailway };
  return byRailway;
}

// ===== 運行日（平日・土休日・事業者の特定日） =====
let holidays;
async function holidaysJp() {
  // 内閣府の祝日を JSON にしたもの。取れなければ土日だけで判定する
  holidays ??= fetchJson('https://holidays-jp.github.io/api/v1/date.json', {}, 10000).catch((e) => {
    console.warn('祝日一覧を取得できませんでした', e);
    return {};
  });
  return holidays;
}

const calendarLists = {};
function specificCalendars(src) {
  calendarLists[src] ??= odpt(src, 'odpt:Calendar').catch(() => []);
  return calendarLists[src];
}

export async function dayProfile(dateISO) {
  const hol = await holidaysJp();
  const [y, m, d] = dateISO.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return { dateISO, dow, holiday: !!hol[dateISO] };
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 数字が大きいほどその日に合うカレンダー。0 は使わない
export function calendarScore(cal, day, specific) {
  if (!cal) return 1;
  if (specific.has(cal)) return 5;
  const name = tail(cal.split(':').pop());
  const off = day.holiday || day.dow === 0 || day.dow === 6;
  if (cal.includes('Specific')) return 0;
  if (name === 'Weekday') return off ? 0 : 2;
  if (name === 'SaturdayHoliday') return off ? 2 : 0;
  if (name === 'Holiday') return day.holiday || day.dow === 0 ? 3 : 0;
  if (name === 'Saturday') return day.dow === 6 && !day.holiday ? 3 : 0;
  if (name === DOW_NAMES[day.dow] && !day.holiday) return 3;
  return 0;
}

export async function specificSet(src, dateISO) {
  const list = await specificCalendars(src);
  return new Set(list.filter((c) => (c['odpt:day'] || []).includes(dateISO)).map((c) => c['owl:sameAs']));
}

// ===== 時刻表 =====
const sttCache = new Map();
function stationTimetables(src, station, railway) {
  const key = `${src}|${station}|${railway}`;
  if (!sttCache.has(key)) {
    const p = odpt(src, 'odpt:StationTimetable', { 'odpt:station': station, 'odpt:railway': railway });
    p.catch(() => sttCache.delete(key));
    sttCache.set(key, p);
  }
  return sttCache.get(key);
}

const trainCache = new Map();
async function trainTimetables(src, trains) {
  const missing = trains.filter((t) => !trainCache.has(`${src}|${t}`));
  for (let i = 0; i < missing.length; i += OR_LIMIT) {
    const chunk = missing.slice(i, i + OR_LIMIT);
    const list = await odpt(src, 'odpt:TrainTimetable', { 'odpt:train': chunk.join(',') });
    for (const t of chunk) trainCache.set(`${src}|${t}`, []);
    for (const tt of list) trainCache.get(`${src}|${tt['odpt:train']}`)?.push(tt);
  }
  return new Map(trains.map((t) => [t, trainCache.get(`${src}|${t}`) ?? []]));
}

// その日に使う時刻表を、方面ごとに 1 つずつ選ぶ
function pickForDay(list, day, specific) {
  const byDir = new Map();
  for (const tt of list) {
    const score = calendarScore(tt['odpt:calendar'], day, specific);
    if (!score) continue;
    const dir = tt['odpt:railDirection'] ?? '';
    if (!byDir.has(dir) || score > byDir.get(dir).score) byDir.set(dir, { score, tt });
  }
  return [...byDir.values()].map((v) => v.tt);
}

function departures(tt) {
  return (tt['odpt:stationTimetableObject'] || []).map((o) => {
    const t = parseHHMM(o['odpt:departureTime']);
    if (t == null) return null;
    return {
      at: serviceMin(t),
      train: o['odpt:train'],
      type: o['odpt:trainType'],
      dest: o['odpt:destinationStation'] || [],
      dir: tt['odpt:railDirection'],
    };
  }).filter(Boolean);
}

const sameDest = (a, b) => (!a.dest.length || !b.dest.length ? true : a.dest.some((d) => b.dest.includes(d)));

// 駅順が分かる路線なら、進む向きの方面だけにする
function wantedDirection(rw, from, to) {
  const i = rw.order?.indexOf(from) ?? -1;
  const k = rw.order?.indexOf(to) ?? -1;
  if (i < 0 || k < 0 || i === k) return null;
  return k > i ? rw.asc : rw.desc;
}

// 列車時刻表で、from を出て to に停まるかと、その着時刻を確かめる
function arrivalByTrain(timetables, from, to, depAt, day, specific) {
  const best = timetables
    .map((tt) => ({ tt, score: calendarScore(tt['odpt:calendar'], day, specific) }))
    .filter((x) => x.score || timetables.length === 1)
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  const objs = best.tt['odpt:trainTimetableObject'] || [];
  const stationOf = (o) => o['odpt:departureStation'] ?? o['odpt:arrivalStation'];
  const iFrom = objs.findIndex((o) => stationOf(o) === from);
  if (iFrom < 0) return null;
  const o = objs.slice(iFrom + 1).find((x) => stationOf(x) === to);
  const t = parseHHMM(o?.['odpt:arrivalTime'] ?? o?.['odpt:departureTime']);
  if (t == null) return null;
  let arr = serviceMin(t);
  if (arr < depAt) arr += 1440;
  return arr;
}

/**
 * from 駅を earliest（分）以降に出て、to 駅へ乗り換えなしで行く列車のうち、いちばん早く着くものを探す。
 * from / to は、その路線の駅 ID。
 * 返り値: 見つかれば { ride: { railway, from, to, dep, arr, type, dest, estimated } }、
 *         見つからなければ { reason: 利用者に見せる理由 }
 *
 * 路線によって使えるデータが違うので 3 段で決める:
 *   1. 列車時刻表がある → 列車ごとの到着時刻（正確）
 *   2. 駅時刻表だけ    → to 駅の時刻表で、同じ種別・同じ行き先の次の発車を着時刻とみなす（推定）
 *   3. to が終着駅     → to 駅に発車が無いので、距離から所要時間を見積もる（推定）
 */
export async function findRide({ railway, from, to, earliest, day }) {
  const net = await loadNetwork();
  const rw = net.railwayById.get(railway);
  const a = net.stationById.get(from);
  const b = net.stationById.get(to);
  if (!rw || !a || !b) return { reason: '駅・路線のデータがありません' };
  const src = rw.src;
  const dist = haversine(a, b);
  const earliestAt = serviceMin(earliest);

  const [fromList, toList, specific] = await Promise.all([
    stationTimetables(src, from, railway),
    stationTimetables(src, to, railway),
    specificSet(src, day.dateISO),
  ]);
  if (!fromList.length) return { reason: `${a.name}駅の時刻表がありません` };

  let fromDay = pickForDay(fromList, day, specific);
  if (!fromDay.length) return { reason: `${day.dateISO} に使うダイヤ（平日・土休日）が見つかりません` };
  const dir = wantedDirection(rw, from, to);
  if (dir && fromDay.some((tt) => tt['odpt:railDirection'] === dir)) fromDay = fromDay.filter((tt) => tt['odpt:railDirection'] === dir);

  const all = fromDay.flatMap(departures).sort((x, y) => x.at - y.at);
  const cands = all.filter((d) => d.at >= earliestAt);
  if (!cands.length) {
    return all.length
      ? { reason: `${fmtMin(earliestAt)} 以降の列車がありません（最終は ${fmtMin(all.at(-1).at)} 発）`, last: true }
      : { reason: `${b.name}方面の列車がありません` };
  }
  const window = cands.filter((d) => d.at <= cands[0].at + PICK_WINDOW);
  const toDeps = pickForDay(toList, day, specific).flatMap(departures).sort((x, y) => x.at - y.at);
  const maxRun = dist / RIDE_SLOW + 10;

  const rides = [];
  const push = (c, arr, estimated) => rides.push({ railway, from, to, dep: c.at, arr, type: c.type, dest: c.dest, estimated });
  const best = () => ({ ride: rides.sort((x, y) => x.arr - y.arr || y.dep - x.dep)[0] }); // 同じ時刻に着くなら遅く出る方

  const tryStationMatch = (c) => {
    const m = toDeps.find((d) => d.at > c.at && d.at - c.at <= maxRun && d.type === c.type && sameDest(c, d) && (!c.train || !d.train || c.train === d.train));
    if (m) return push(c, m.at, !(c.train && c.train === m.train));
    if (c.dest.includes(to)) push(c, c.at + Math.max(2, Math.round(dist / RIDE_TYPICAL)), true);
  };

  if (rw.tt === 'train') {
    const withId = window.filter((c) => c.train);
    const tts = await trainTimetables(src, [...new Set(withId.map((c) => c.train))]).catch((e) => {
      console.warn(e);
      return new Map();
    });
    for (const c of window) {
      const arr = c.train ? arrivalByTrain(tts.get(c.train) ?? [], from, to, c.at, day, specific) : null;
      if (arr != null) push(c, arr, false);
      else if (!c.train || !(tts.get(c.train) ?? []).length) tryStationMatch(c);
    }
  } else {
    window.forEach(tryStationMatch);
  }
  if (rides.length) return best();

  // 最初の 40 分に乗れる列車が無ければ、残りの列車を順に確かめる（本数の少ない路線・急行ばかりの時間帯）
  const rest = cands.filter((d) => d.at > cands[0].at + PICK_WINDOW).slice(0, 30);
  for (const c of rest) {
    if (rw.tt === 'train' && c.train) {
      const tts = await trainTimetables(src, [c.train]).catch(() => new Map());
      const arr = arrivalByTrain(tts.get(c.train) ?? [], from, to, c.at, day, specific);
      if (arr != null) push(c, arr, false);
    }
    if (!rides.length) tryStationMatch(c);
    if (rides.length) return best();
  }

  const lastChecked = (rest.length ? rest : window).at(-1);
  if (rw.tt !== 'train' && !toList.length) return { reason: `${b.name}駅の時刻表が無いため、着く時刻を決められません` };
  return { reason: `${fmtMin(cands[0].at)}〜${fmtMin(lastChecked.at)} 発の列車に、${b.name}駅に停まるものが見つかりません（通過する列車・行き先の違う列車だけでした）` };
}
