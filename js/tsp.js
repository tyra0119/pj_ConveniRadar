// 巡回順の最適化（lawson/app.js から移したもの）
// D はノード 0 = 起点（駅）、ノード i+1 = 店舗 i のコスト行列。戻り値は店舗インデックスの訪問順。

const EXACT_LIMIT = 15; // この店舗数以下なら全組み合わせから厳密な最短を求める

export function pathCost(D, order, roundtrip) {
  if (!order.length) return 0;
  let c = D[0][order[0] + 1];
  for (let k = 1; k < order.length; k++) c += D[order[k - 1] + 1][order[k] + 1];
  if (roundtrip) c += D[order[order.length - 1] + 1][0];
  return c;
}

export function solveTsp(D, n, roundtrip) {
  if (n <= 1) return n ? [0] : [];
  return n <= EXACT_LIMIT ? solveExact(D, n, roundtrip) : solveHeuristic(D, n, roundtrip);
}

// Held-Karp 法（動的計画法）: 全順列を試したのと同じ厳密な最短順を求める
function solveExact(D, n, roundtrip) {
  const FULL = 1 << n;
  const dp = new Float64Array(FULL * n).fill(Infinity);
  const parent = new Int8Array(FULL * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = D[0][j + 1];

  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < n; j++) {
      const cur = dp[mask * n + j];
      if (!(mask & (1 << j)) || cur === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const idx = (mask | (1 << k)) * n + k;
        const v = cur + D[j + 1][k + 1];
        if (v < dp[idx]) {
          dp[idx] = v;
          parent[idx] = j;
        }
      }
    }
  }

  const all = FULL - 1;
  let best = Infinity;
  let last = 0;
  for (let j = 0; j < n; j++) {
    const v = dp[all * n + j] + (roundtrip ? D[j + 1][0] : 0);
    if (v < best) {
      best = v;
      last = j;
    }
  }

  const order = [];
  for (let mask = all, j = last; j !== -1;) {
    order.push(j);
    const p = parent[mask * n + j];
    mask ^= 1 << j;
    j = p;
  }
  return order.reverse();
}

// 店舗が多いとき用: 最近傍法 → 2-opt / Or-opt で改善
function solveHeuristic(D, n, roundtrip) {
  const used = new Array(n).fill(false);
  let order = [];
  for (let s = 0, cur = 0; s < n; s++) {
    let next = -1;
    for (let j = 0; j < n; j++) {
      if (!used[j] && (next === -1 || D[cur][j + 1] < D[cur][next + 1])) next = j;
    }
    used[next] = true;
    order.push(next);
    cur = next + 1;
  }

  let bestCost = pathCost(D, order, roundtrip);
  const tryOrder = (cand) => {
    const c = pathCost(D, cand, roundtrip);
    if (c < bestCost - 1e-6) {
      order = cand;
      bestCost = c;
      return true;
    }
    return false;
  };

  for (let improved = true; improved;) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        improved = tryOrder([...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)]) || improved;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cand = order.slice();
        cand.splice(j, 0, ...cand.splice(i, 1));
        improved = tryOrder(cand) || improved;
      }
    }
  }
  return order;
}
