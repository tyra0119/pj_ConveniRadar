// バス停と、バスの時刻表から「乗る便」を決める処理（電車の odpt.js にならう）
import { DATA_V } from './config.js?v=875347a5';
import { calendarScore, odpt, serviceMin, specificSet } from './odpt.js?v=875347a5';
import { fetchJson, fmtMin, haversine, parseHHMM } from './util.js?v=875347a5';

// 同じ名前でこの距離以内のポール（のりば違い・事業者違い）は 1 つのバス停とみなす。
// 駅（800m）より狭くするのは、バス停は同じ名前が近くの別の場所にもある（「泉町」など）ため
const STOP_RADIUS = 300;
const OR_LIMIT = 10; // ODPT の OR 条件（カンマ区切り）の上限

// ===== バス停の一覧（tools/build_bus.py が作る） =====
let bus = null;
let loading = null;
export function loadBus() {
  if (bus) return Promise.resolve(bus);
  loading ??= fetchJson(`data/bus.json${DATA_V}`, {}, 60000).then((j) => {
    const operators = j.operators.map(([id, title]) => ({ id, title }));
    const patterns = j.patterns.map(([id, op, route]) => ({ id, operator: operators[op], route: j.routes[route] }));
    const poles = j.poles.map(([id, name, lat, lng, op, pats]) => ({ id, name, lat, lng, operator: operators[op], patterns: pats.map((k) => patterns[k]) }));
    const stops = groupPoles(poles);
    const stopById = new Map();
    for (const stop of stops) {
      stopById.set(stop.id, stop);
      for (const p of stop.poles) stopById.set(p.id, stop);
    }
    bus = { generatedAt: j.generatedAt, operators, patterns, poles, poleById: new Map(poles.map((p) => [p.id, p])), stops, stopById };
    return bus;
  });
  loading.catch(() => { loading = null; });
  return loading;
}

export const busData = () => bus;

function groupPoles(poles) {
  const byName = new Map();
  for (const p of poles) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  const stops = [];
  for (const list of byName.values()) {
    const clusters = [];
    for (const p of list) {
      const near = clusters.find((members) => members.some((m) => haversine(m, p) <= STOP_RADIUS));
      if (near) near.push(p);
      else clusters.push([p]);
    }
    for (const members of clusters) {
      const ids = members.map((m) => m.id).sort();
      stops.push({
        id: `bus:${ids[0]}`,
        kind: 'bus',
        name: members[0].name,
        lat: members.reduce((t, m) => t + m.lat, 0) / members.length,
        lng: members.reduce((t, m) => t + m.lng, 0) / members.length,
        poles: members,
        operators: [...new Set(members.map((m) => m.operator.title))],
        routes: [...new Set(members.flatMap((m) => m.patterns.map((pt) => pt.route)).filter(Boolean))],
      });
    }
  }
  return stops;
}

/**
 * 2 つのバス停を結ぶ系統。どちらのバス停にも停まる系統と、それぞれのポール。
 * 向き（どちらが先か）は時刻表の通過順で確かめるので、ここでは見ない
 */
export function commonBusPatterns(a, b) {
  if (!a || !b || a === b) return [];
  const links = new Map();
  for (const pa of a.poles) {
    for (const pt of pa.patterns) {
      const toPoles = b.poles.filter((pb) => pb.patterns.includes(pt));
      if (!toPoles.length) continue;
      const cur = links.get(pt.id) ?? { pattern: pt, fromPoles: new Set(), toPoles: new Set() };
      cur.fromPoles.add(pa.id);
      toPoles.forEach((pb) => cur.toPoles.add(pb.id));
      links.set(pt.id, cur);
    }
  }
  return [...links.values()];
}

// ===== 時刻表 =====
const ttCache = new Map(); // 系統 ID → その系統の便の一覧
async function busTimetables(patternIds) {
  const missing = patternIds.filter((id) => !ttCache.has(id));
  // 並列にせず順番に取る（OR 条件と負荷の制限。busstop リポジトリの実測）
  for (let i = 0; i < missing.length; i += OR_LIMIT) {
    const chunk = missing.slice(i, i + OR_LIMIT);
    const list = await odpt('pub', 'odpt:BusTimetable', { 'odpt:busroutePattern': chunk.join(',') });
    for (const id of chunk) ttCache.set(id, []);
    for (const trip of list) ttCache.get(trip['odpt:busroutePattern'])?.push(trip);
  }
  return new Map(patternIds.map((id) => [id, ttCache.get(id) ?? []]));
}

const timeOf = (o, prefer) => parseHHMM(o?.[prefer] ?? o?.[prefer === 'odpt:departureTime' ? 'odpt:arrivalTime' : 'odpt:departureTime']);

/**
 * バス停 a を earliest（分）以降に出て、バス停 b へ乗り換えなしで行く便のうち、いちばん早く着くもの。
 * 返り値: 見つかれば { ride: { mode: 'bus', route, operator, dep, arr, dest, fromPole, toPole } }、
 *         見つからなければ { reason, last? }
 */
export async function findBusRide({ a, b, earliest, day }) {
  const links = commonBusPatterns(a, b);
  if (!links.length) return { reason: `${a.name}と${b.name}の両方に停まる系統がありません` };
  const earliestAt = serviceMin(earliest);
  const [tts, specific] = await Promise.all([
    busTimetables(links.map((l) => l.pattern.id)),
    specificSet('pub', day.dateISO),
  ]);

  let anyTimetable = false;
  let anyToday = false;
  let lastDep = null;
  const rides = [];
  for (const link of links) {
    const trips = tts.get(link.pattern.id) ?? [];
    if (trips.length) anyTimetable = true;
    // その日に合うカレンダーの便だけ（特定日 > 曜日 > 平日・土休日）
    const scored = trips.map((t) => ({ t, score: calendarScore(t['odpt:calendar'], day, specific) }));
    const best = Math.max(0, ...scored.map((x) => x.score));
    if (!best) continue;
    anyToday = true;
    for (const { t, score } of scored) {
      if (score !== best) continue;
      const objs = [...(t['odpt:busTimetableObject'] || [])].sort((x, y) => x['odpt:index'] - y['odpt:index']);
      const iFrom = objs.findIndex((o) => link.fromPoles.has(o['odpt:busstopPole']));
      if (iFrom < 0) continue;
      const toObj = objs.slice(iFrom + 1).find((o) => link.toPoles.has(o['odpt:busstopPole']));
      if (!toObj) continue; // 逆向きの便
      const depT = timeOf(objs[iFrom], 'odpt:departureTime');
      const arrT = timeOf(toObj, 'odpt:arrivalTime');
      if (depT == null || arrT == null) continue;
      const dep = serviceMin(depT);
      let arr = serviceMin(arrT);
      if (arr < dep) arr += 1440;
      lastDep = Math.max(lastDep ?? 0, dep);
      if (dep < earliestAt) continue;
      rides.push({
        mode: 'bus',
        route: t['dc:title'] || link.pattern.route,
        operator: link.pattern.operator.title,
        dep,
        arr,
        dest: busPoleName(objs.at(-1)['odpt:busstopPole']),
        fromPole: objs[iFrom]['odpt:busstopPole'],
        toPole: toObj['odpt:busstopPole'],
      });
    }
  }

  if (rides.length) return { ride: rides.sort((x, y) => x.arr - y.arr || y.dep - x.dep)[0] };
  if (!anyTimetable) return { reason: 'バスの時刻表がありません' };
  if (!anyToday) return { reason: `${day.dateISO} に走る便がありません` };
  if (lastDep != null) return { reason: `${fmtMin(earliestAt)} 以降の便がありません（最終は ${fmtMin(lastDep)} 発）`, last: true };
  return { reason: `${b.name}へ向かう便がありません（逆向きの便だけでした）` };
}

export const busPoleName = (poleId) => bus?.poleById.get(poleId)?.name ?? String(poleId ?? '').split('.').at(-3) ?? '';
