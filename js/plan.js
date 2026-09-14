// 駅ごとの巡回計画: 駅で降りる → 徒歩で店を回る → 駅に戻る → 時刻表で次の駅へ
import { findRide, loadNetwork } from './odpt.js?v=15344496';
import { solveTsp } from './tsp.js?v=15344496';
import { haversine } from './util.js?v=15344496';

export const WALK_SPEED = 80; // m/分（不動産広告の徒歩表示と同じ基準）
export const WALK_FACTOR = 1.3; // 直線距離 → 道のりの係数（道路データを使わない概算）

const walkMin = (a, b) => (haversine(a, b) * WALK_FACTOR) / WALK_SPEED;

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

const linesOf = (net, stop) => stop.railways.map((r) => net.railwayById.get(r)?.title).filter(Boolean).join('・');

/**
 * trip: [{ id: 駅グループ ID }]（回る順）
 * storesByStop: trip と同じ長さの配列。各駅で回る店
 * startMin: 最初の駅にいる時刻（その日の 0:00 からの分）
 */
export async function buildPlan({ trip, storesByStop, startMin, dwell, transfer, day }) {
  const net = await loadNetwork();
  const stops = [];
  let clock = startMin;

  for (let i = 0; i < trip.length; i++) {
    const station = net.stopById.get(trip[i].id);
    if (!station) {
      stops.push({ stationId: trip[i].id, arrive: clock, visits: [], backLeg: null, ready: clock, ride: null, error: '駅のデータが見つかりません（駅・路線データの更新で無くなった可能性があります）' });
      break;
    }
    const tour = stationTour(station, storesByStop[i] ?? []);
    const arrive = clock;
    const visits = tour.stores.map((store, k) => {
      clock += tour.legs[k].min;
      const v = { store, arrive: clock, walkMin: tour.legs[k].min, walkDist: tour.legs[k].dist };
      clock += dwell;
      return v;
    });
    const back = tour.legs.at(-1);
    if (back) clock += back.min;
    const stop = { stationId: station.id, arrive, visits, backLeg: back ?? null, ready: clock, ride: null, error: null };
    stops.push(stop);
    if (i === trip.length - 1) break;

    const next = net.stopById.get(trip[i + 1].id);
    if (next === station) continue; // 同じ駅が続くときは乗らずにそのまま次へ
    if (!next) {
      stop.error = '次の駅のデータが見つかりません';
      break;
    }

    const links = commonRailways(net, station.id, next.id);
    if (!links.length) {
      stop.error = `${station.name}駅と${next.name}駅を乗り換えなしで結ぶ路線がありません（${station.name}：${linesOf(net, station)}／${next.name}：${linesOf(net, next)}）。`
        + '乗り換えにはまだ対応していないので、間に乗り換える駅を追加してください';
      break;
    }

    const results = await Promise.all(links.map((l) => findRide({ railway: l.railway.id, from: l.from, to: l.to, earliest: clock + transfer, day })
      .catch((e) => ({ reason: e.message }))));
    const ride = results.map((r) => r.ride).filter(Boolean).sort((x, y) => x.arr - y.arr || y.dep - x.dep)[0];
    if (!ride) {
      stop.error = `${station.name}→${next.name}：乗れる列車が見つかりません。`
        + links.map((l, k) => `${l.railway.title}：${results[k].reason}`).join(' ／ ')
        + (results.every((r) => r.last) ? '。回る店を減らすか駅を外すと、最終列車に間に合うことがあります' : '');
      break;
    }
    stop.ride = ride;
    clock = ride.arr;
  }

  const visited = stops.reduce((n, s) => n + s.visits.length, 0);
  const walk = stops.reduce((n, s) => n + s.visits.reduce((m, v) => m + v.walkMin, 0) + (s.backLeg?.min ?? 0), 0);
  const error = stops.find((s) => s.error)?.error ?? null;
  return { stops, startMin, endMin: error ? null : clock, visited, walkMin: walk, complete: !error, error };
}
