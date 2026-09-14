// 巡回計画: 停留所（駅・バス停）で降りる → 徒歩で店を回る → 戻る → 電車・バス・徒歩で次の停留所へ
import { findBikeRide } from './bike.js?v=b42fc3b1';
import { busData, commonBusPatterns, findBusRide, loadBus } from './bus.js?v=b42fc3b1';
import { findRide, loadNetwork } from './odpt.js?v=b42fc3b1';
import { solveTsp } from './tsp.js?v=b42fc3b1';
import { fmtMin, haversine } from './util.js?v=b42fc3b1';

export const WALK_SPEED = 80; // m/分（不動産広告の徒歩表示と同じ基準）
export const WALK_FACTOR = 1.3; // 直線距離 → 道のりの係数（道路データを使わない概算）
export const WALK_HOP_MAX = 1500; // 停留所と停留所の間を歩いてつなぐ上限（道のり m）。駅とバス停の乗り換えにも使う

const walkMin = (a, b) => (haversine(a, b) * WALK_FACTOR) / WALK_SPEED;

// 行程の停留所。駅グループ（stop:…、駅 ID でも可）かバス停（bus:…）
export function stopOf(net, id) {
  return String(id).startsWith('bus:') ? busData()?.stopById.get(id) : net?.stopById.get(id);
}

// 駅を起点に全店を回って駅へ戻る、歩く時間が最短の順番
export function stationTour(station, stores) {
  if (!stores.length) return { stores: [], legs: [] };
  const pts = [station, ...stores];
  const D = pts.map((p) => pts.map((q) => walkMin(p, q)));
  const order = solveTsp(D, stores.length, true);
  const nodes = [0, ...order.map((i) => i + 1), 0];
  return {
    stores: order.map((i) => stores[i]),
    legs: nodes.slice(1).map((n, k) => ({ min: D[nodes[k]][n], dist: haversine(pts[nodes[k]], pts[n]) * WALK_FACTOR })),
  };
}

const tourMinutes = (tour, dwell) => tour.legs.reduce((m, l) => m + l.min, 0) + tour.stores.length * dwell;

/**
 * 使える時間（分）に収まるまで、外すと一番時間が縮む店から外す。
 * 縮む時間 = その店への徒歩 ＋ その店からの徒歩 − 前後を直接結ぶ徒歩 ＋ 滞在
 */
function fitTour(station, stores, dwell, budget) {
  let tour = stationTour(station, stores);
  const dropped = [];
  while (tour.stores.length && tourMinutes(tour, dwell) > budget) {
    const pts = [station, ...tour.stores, station];
    let bestK = 0;
    let bestSave = -Infinity;
    tour.stores.forEach((_, k) => {
      const save = tour.legs[k].min + tour.legs[k + 1].min - walkMin(pts[k], pts[k + 2]) + dwell;
      if (save > bestSave) {
        bestSave = save;
        bestK = k;
      }
    });
    dropped.push(tour.stores[bestK]);
    tour = stationTour(station, tour.stores.filter((_, k) => k !== bestK));
  }
  return { tour, dropped };
}

/**
 * 2 つの駅（駅グループ）を乗り換えなしで結ぶ路線。
 * 返り値: [{ railway, from: その路線の出発駅 ID, to: その路線の到着駅 ID }]
 * 例: 池袋 → 和光市 なら 東上線・有楽町線・副都心線 の 3 つ
 */
export function commonRailways(net, fromId, toId) {
  const a = net.stopById.get(fromId);
  const b = net.stopById.get(toId);
  if (!a || !b || a === b) return [];
  const links = [];
  for (const sa of a.stations) {
    for (const r of net.stationById.get(sa)?.railways ?? []) {
      if (links.some((l) => l.railway.id === r)) continue;
      const sb = b.stations.find((id) => net.stationById.get(id)?.railways.includes(r));
      if (sb) links.push({ railway: net.railwayById.get(r), from: sa, to: sb });
    }
  }
  return links;
}

/**
 * 2 つの停留所の間で使える移動手段（表示と計画の両方で使う）。
 * rail: 乗り換えなしの路線、bus: 両方に停まる系統、walk: 歩ける距離なら { dist, min }
 */
export function hopOptions(net, fromId, toId) {
  const a = stopOf(net, fromId);
  const b = stopOf(net, toId);
  if (!a || !b || a === b) return { a, b, rail: [], bus: [], walk: null, dist: 0 };
  const isBus = (s) => s.kind === 'bus';
  const dist = haversine(a, b) * WALK_FACTOR;
  return {
    a,
    b,
    rail: !isBus(a) && !isBus(b) ? commonRailways(net, a.id, b.id) : [],
    bus: isBus(a) && isBus(b) ? commonBusPatterns(a, b) : [],
    walk: dist <= WALK_HOP_MAX ? { dist, min: dist / WALK_SPEED } : null,
    dist,
  };
}

/**
 * trip: [{ id: 停留所 ID }]（回る順）
 * storesByStop: trip と同じ長さの配列。各停留所で回る店
 * startMin: 最初の停留所にいる時刻（その日の 0:00 からの分）
 * deadline: 終了時刻（分）。この時刻までに停留所へ戻れるよう、間に合わない店を外し、間に合わない停留所へは行かない。null なら制限なし
 */
// modes: 使う移動手段 { rail, bus, bike }。徒歩（1.5km 以内）は常に使う
export async function buildPlan({ trip, storesByStop, startMin, dwell, transfer, day, deadline = null, modes = { rail: true, bus: true, bike: false } }) {
  const net = await loadNetwork();
  if (trip.some((t) => String(t.id).startsWith('bus:'))) await loadBus();
  const stops = [];
  let clock = startMin;

  for (let i = 0; i < trip.length; i++) {
    const station = stopOf(net, trip[i].id);
    if (!station) {
      stops.push({ stationId: trip[i].id, arrive: clock, visits: [], backLeg: null, ready: clock, ride: null, dropped: [], error: '駅・バス停のデータが見つかりません（データの更新で無くなった可能性があります）' });
      break;
    }
    const budget = deadline == null ? Infinity : deadline - clock;
    const { tour, dropped } = fitTour(station, storesByStop[i] ?? [], dwell, budget);
    const arrive = clock;
    const visits = tour.stores.map((store, k) => {
      clock += tour.legs[k].min;
      const v = { store, arrive: clock, walkMin: tour.legs[k].min, walkDist: tour.legs[k].dist };
      clock += dwell;
      return v;
    });
    const back = tour.legs.at(-1);
    if (back) clock += back.min;
    const stop = { stationId: station.id, arrive, visits, backLeg: back ?? null, ready: clock, ride: null, dropped, cutoff: null, error: null };
    stops.push(stop);
    if (i === trip.length - 1) break;

    const next = stopOf(net, trip[i + 1].id);
    if (next === station) continue; // 同じ停留所が続くときは乗らずにそのまま次へ
    if (!next) {
      stop.error = '次の駅・バス停のデータが見つかりません';
      break;
    }

    const opt = hopOptions(net, station.id, next.id);
    const earliest = clock + transfer;
    const tasks = [
      ...(modes.rail ? opt.rail : []).map((l) => findRide({ railway: l.railway.id, from: l.from, to: l.to, earliest, day })
        .then((r) => ({ ...r, label: l.railway.title }), (e) => ({ reason: e.message, label: l.railway.title }))),
      ...(modes.bus && opt.bus.length
        ? [findBusRide({ a: station, b: next, earliest, day }).then((r) => ({ ...r, label: 'バス' }), (e) => ({ reason: e.message, label: 'バス' }))]
        : []),
      // 自転車は乗るまでの余裕を足さない（停留所に戻った時刻にポートへ歩き出す）。近すぎる区間は歩いた方が早いので試さない
      ...(modes.bike && opt.dist > 400
        ? [findBikeRide({ a: station, b: next, depart: clock, walkSpeed: WALK_SPEED, walkFactor: WALK_FACTOR })
          .then((r) => ({ ...r, label: 'シェアサイクル' }), (e) => ({ reason: e.message, label: 'シェアサイクル' }))]
        : []),
    ];
    const results = await Promise.all(tasks);
    const candidates = results.map((r) => r.ride).filter(Boolean).map((r) => ({ mode: 'rail', ...r }));
    // 歩いて行ける距離なら徒歩も候補（乗るまでの余裕は要らない）
    if (opt.walk) candidates.push({ mode: 'walk', dep: clock, arr: clock + opt.walk.min, dist: opt.walk.dist });
    const ride = candidates.sort((x, y) => x.arr - y.arr || y.dep - x.dep)[0];

    if (!ride) {
      if (!tasks.length) {
        const off = [['rail', '電車'], ['bus', 'バス'], ['bike', 'シェアサイクル']].filter(([k]) => !modes[k]).map(([, label]) => label);
        stop.error = `${station.name}と${next.name}を乗り換えなしで結ぶ電車・バスがなく、歩くにも遠すぎます（約${(opt.dist / 1000).toFixed(1)}km）。`
          + (off.length ? `「使う移動手段」で ${off.join('・')} がオフになっています。` : '')
          + '乗り換えにはまだ対応していないので、間に乗り換える駅・バス停を追加してください';
      } else {
        stop.error = `${station.name}→${next.name}：乗れる便が見つかりません。`
          + results.map((r) => `${r.label}：${r.reason}`).join(' ／ ')
          + (results.every((r) => r.last) ? '。回る店を減らすか停留所を外すと、最終便に間に合うことがあります' : '');
      }
      break;
    }
    if (deadline != null && ride.arr >= deadline) {
      stop.cutoff = `${next.name}に着くのが ${fmtMin(ride.arr)} で、終了時刻 ${fmtMin(deadline)} までに回る時間が残らないため、ここで終わります（残り ${trip.length - i - 1}か所は回りません）`;
      break;
    }
    stop.ride = ride;
    clock = ride.arr;
  }

  const visited = stops.reduce((n, s) => n + s.visits.length, 0);
  const walk = stops.reduce((n, s) => n + s.visits.reduce((m, v) => m + v.walkMin, 0) + (s.backLeg?.min ?? 0), 0);
  const error = stops.find((s) => s.error)?.error ?? null;
  return {
    stops,
    startMin,
    endMin: error ? null : clock,
    visited,
    walkMin: walk,
    complete: !error,
    error,
    deadline,
    dropped: stops.reduce((n, s) => n + (s.dropped?.length ?? 0), 0),
    cutoff: stops.find((s) => s.cutoff)?.cutoff ?? null,
  };
}
