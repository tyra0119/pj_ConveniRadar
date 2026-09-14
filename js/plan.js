// 駅ごとの巡回計画: 駅で降りる → 徒歩で店を回る → 駅に戻る → 時刻表で次の駅へ
import { findRide, loadNetwork } from './odpt.js?v=4352e1d6';
import { solveTsp } from './tsp.js?v=4352e1d6';
import { haversine } from './util.js?v=4352e1d6';

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

// 2 つの駅に共通する、時刻表のある路線
export function commonRailways(net, fromId, toId) {
  const a = net.stationById.get(fromId);
  const b = net.stationById.get(toId);
  if (!a || !b) return [];
  return a.railways.filter((r) => b.railways.includes(r)).map((r) => net.railwayById.get(r));
}

/**
 * trip: [{ id: 駅ID }]（回る順）
 * storesByStop: trip と同じ長さの配列。各駅で回る店
 * startMin: 最初の駅にいる時刻（その日の 0:00 からの分）
 */
export async function buildPlan({ trip, storesByStop, startMin, dwell, transfer, day }) {
  const net = await loadNetwork();
  const stops = [];
  let clock = startMin;

  for (let i = 0; i < trip.length; i++) {
    const station = net.stationById.get(trip[i].id);
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

    const nextId = trip[i + 1].id;
    if (nextId === station.id) continue; // 同じ駅が続くときは乗らずにそのまま次へ
    const railways = commonRailways(net, station.id, nextId);
    if (!railways.length) {
      stop.error = `${net.stationById.get(nextId)?.name ?? '次の駅'}へ乗り換えなしで行ける路線がありません（乗り換えにはまだ対応していません）`;
      break;
    }
    const rides = await Promise.all(railways.map((rw) => findRide({ railway: rw.id, from: station.id, to: nextId, earliest: clock + transfer, day })));
    const ride = rides.filter(Boolean).sort((x, y) => x.arr - y.arr || y.dep - x.dep)[0];
    if (!ride) {
      stop.error = '乗れる列車が見つかりません（終電後か、時刻表を取得できない駅です）';
      break;
    }
    stop.ride = ride;
    clock = ride.arr;
  }

  const visited = stops.reduce((n, s) => n + s.visits.length, 0);
  const walk = stops.reduce((n, s) => n + s.visits.reduce((m, v) => m + v.walkMin, 0) + (s.backLeg?.min ?? 0), 0);
  return { stops, startMin, endMin: stops.at(-1)?.error ? null : clock, visited, walkMin: walk, complete: !stops.some((s) => s.error) };
}
