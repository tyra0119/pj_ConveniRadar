// エリア巡回モード: 中心と半径の中から、終了時刻までに回れる店が多くなるように、拠点（駅・バス停）と順番を選ぶ。
// ここで使う移動時間は見積もり。選んだ順番を行程に入れたあと、実際の時刻表での計画は plan.js の buildPlan が作る
import { portAccess } from './bike.js?v=875347a5';
import { commonBusPatterns } from './bus.js?v=875347a5';
import { WALK_FACTOR, WALK_HOP_MAX, WALK_SPEED, commonRailways } from './plan.js?v=875347a5';
import { haversine } from './util.js?v=875347a5';

const RAIL_SPEED = 550; // 駅間の見積もりの速さ（m/分 ≈ 33km/h、停車込み）
const RAIL_WAIT = 5; // 列車を待つ時間の見積もり（分）
const RAIL_FACTOR = 1.2; // 駅間の直線距離 → 線路の距離
const BUS_SPEED = 250; // バス（m/分 ≈ 15km/h）
const BUS_WAIT = 10;
const BIKE_SPEED = 250; // 自転車（m/分 ≈ 15km/h）
const BIKE_OVERHEAD = 9; // ポートまで歩く・借りる・返す・歩く の見積もり（分）
const BIKE_MAX = 10000;
const BIKE_MIN = 400; // これより近い区間は歩く

const walkMin = (a, b) => (haversine(a, b) * WALK_FACTOR) / WALK_SPEED;

// 範囲内の拠点。駅はいつも使い（自転車だけで回るときも目印になる）、バス停はバスを使うときだけ
function collectBases({ net, bus, center, radiusM }) {
  const inArea = (s) => haversine(center, s) <= radiusM;
  const bases = net.stops.filter(inArea).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, kind: 'rail', stop: s }));
  if (bus) bases.push(...bus.stops.filter(inArea).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, kind: 'bus', stop: s })));
  return bases;
}

// 店を一番近い拠点（歩く範囲以内）に割り当てる。数千店×数百拠点なので、格子に分けて近くの拠点だけ比べる
function assignToBases(stores, bases, walkRadiusM) {
  const cell = walkRadiusM / 111000; // 緯度 1 度 ≈ 111km。経度方向は cos(緯度) 倍に縮むので、±2 マスで半径を覆える
  const key = (y, x) => `${y}|${x}`;
  const grid = new Map();
  for (const b of bases) {
    b.stores = [];
    const k = key(Math.floor(b.lat / cell), Math.floor(b.lng / cell));
    grid.set(k, [...(grid.get(k) ?? []), b]);
  }
  for (const s of stores) {
    const cy = Math.floor(s.lat / cell);
    const cx = Math.floor(s.lng / cell);
    let best = null;
    let bestD = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (const b of grid.get(key(cy + dy, cx + dx)) ?? []) {
          const d = haversine(b, s);
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        }
      }
    }
    if (best && bestD <= walkRadiusM) best.stores.push(s);
  }
  return bases.filter((b) => b.stores.length);
}

// 拠点から近い順に店を回って拠点へ戻るときの、k 店目までの所要（分）。最近傍法の概算
function profile(base, dwell) {
  const left = [...base.stores];
  let cur = base;
  let t = 0;
  base.cum = [];
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    left.forEach((s, i) => {
      const d = walkMin(cur, s);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const s = left.splice(bi, 1)[0];
    t += bd + dwell;
    base.cum.push(t + walkMin(s, base));
    cur = s;
  }
}

// 使える時間の中で、その拠点で回れる店の数とかかる時間
function fits(base, budget) {
  let k = 0;
  while (k < base.cum.length && base.cum[k] <= budget) k++;
  return { count: k, minutes: k ? base.cum[k - 1] : 0 };
}

// 拠点 a → b の移動時間の見積もり（分）。電車・バスは乗り換えなしで行けるときだけ
function travel(ctx, a, b) {
  const key = `${a.id}>${b.id}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const d = haversine(a, b);
  let min = Infinity;
  let mode = null;
  const take = (t, m) => {
    if (t < min) {
      min = t;
      mode = m;
    }
  };
  if (d * WALK_FACTOR <= WALK_HOP_MAX) take((d * WALK_FACTOR) / WALK_SPEED, 'walk');
  if (ctx.modes.rail && a.kind === 'rail' && b.kind === 'rail' && commonRailways(ctx.net, a.id, b.id).length) {
    take(ctx.transfer + RAIL_WAIT + (d * RAIL_FACTOR) / RAIL_SPEED, 'rail');
  }
  if (ctx.modes.bus && a.kind === 'bus' && b.kind === 'bus' && commonBusPatterns(a.stop, b.stop).length) {
    take(ctx.transfer + BUS_WAIT + (d * WALK_FACTOR) / BUS_SPEED, 'bus');
  }
  if (ctx.bikeAccess && d > BIKE_MIN && d * WALK_FACTOR <= BIKE_MAX && ctx.bikeAccess(a, b)) {
    take(BIKE_OVERHEAD + (d * WALK_FACTOR) / BIKE_SPEED, 'bike');
  }
  const r = { min, mode };
  ctx.cache.set(key, r);
  return r;
}

// 借りられるポートが a の近くに、返せるポートが b の近くに、同じ事業者であるか
function makeBikeAccess() {
  const memo = new Map();
  const access = (p) => {
    if (!memo.has(p.id)) memo.set(p.id, portAccess(p));
    return memo.get(p.id);
  };
  return (a, b) => {
    const ret = access(b).ret;
    for (const system of access(a).rent) if (ret.has(system)) return true;
    return false;
  };
}

/**
 * 回る拠点の順番を選ぶ（時間制限つきで回れる店の数を多くする、オリエンテーリング問題の貪欲法）。
 * いまの拠点から、「回れる店の数 ÷（移動＋回る時間）」が一番大きい拠点を、終了時刻まで足していく
 */
function chooseRoute({ net, bases, start, startMin, deadline, dwell, transfer, modes, bikeAccess }) {
  const ctx = { net, modes, transfer, bikeAccess, cache: new Map() };
  for (const b of new Set([...bases, start])) profile(b, dwell);

  const first = fits(start, deadline - startMin);
  const route = [{ base: start, count: first.count, arrive: startMin, travel: null }];
  const used = new Set([start.id]);
  let t = startMin + first.minutes;
  let cur = start;

  for (;;) {
    let best = null;
    for (const b of bases) {
      if (used.has(b.id)) continue;
      const tr = travel(ctx, cur, b);
      if (!Number.isFinite(tr.min)) continue;
      const f = fits(b, deadline - t - tr.min);
      if (!f.count) continue;
      const score = f.count / (tr.min + f.minutes);
      if (!best || score > best.score) best = { b, tr, f, score };
    }
    if (!best) break;
    t += best.tr.min;
    route.push({ base: best.b, count: best.f.count, arrive: t, travel: best.tr });
    t += best.f.minutes;
    used.add(best.b.id);
    cur = best.b;
  }
  return { route, endMin: t, visited: route.reduce((n, r) => n + r.count, 0) };
}

/**
 * center: { lat, lng }、radiusM: 範囲、stores: 候補の店（チェーン・記録済みで絞ったもの）、walkRadiusM: 拠点から歩く範囲
 * startMin / deadline: 中心にいる時刻と終了時刻（分）
 * 返り値: { start, walkToStart, route: [{ base, count, arrive, travel }], endMin, visited, bases }
 */
export function planAreaRoute({ net, bus, center, radiusM, stores, walkRadiusM, startMin, deadline, dwell, transfer, modes }) {
  const all = collectBases({ net, bus, center, radiusM });
  if (!all.length) throw new Error('範囲内に駅・バス停がありません。半径を広げてください');

  // 中心から歩いて行ける、一番近い駅・バス停から始める
  let start = all[0];
  let startD = Infinity;
  for (const b of all) {
    const d = haversine(center, b);
    if (d < startD) {
      startD = d;
      start = b;
    }
  }
  if (startD * WALK_FACTOR > WALK_HOP_MAX) {
    throw new Error(`中心から歩いて行ける駅・バス停がありません（一番近い ${start.name} まで約${(startD / 1000).toFixed(1)}km）。中心を駅の近くにしてください`);
  }

  const bases = assignToBases(stores, all, walkRadiusM);
  const walkToStart = walkMin(center, start);
  const result = chooseRoute({
    net,
    bases,
    start,
    startMin: startMin + walkToStart,
    deadline,
    dwell,
    transfer,
    modes,
    bikeAccess: modes.bike ? makeBikeAccess() : null,
  });
  if (!result.visited) throw new Error('終了時刻までに回れる店が見つかりませんでした。終了時刻を遅くするか、半径・駅から歩く範囲を広げてください');
  return { start, walkToStart, ...result, bases: bases.length };
}
