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

// 店舗が多いとき用: 最近傍法 → 2-opt / Or-opt で改善。D は対称（徒歩の距離）とする。
// 以前は候補の手ごとに配列を作って全体の長さを測っていたため、数百店になると 1 回の見直しで数千万回の計算になり、
// 計画作りが終わらなかった（2026-09-15 利用者の指摘）。手の差分だけを計算してその場で入れ替え、時間の上限でも打ち切る
const HEURISTIC_MS = 300;

function solveHeuristic(D, n, roundtrip) {
  const used = new Array(n).fill(false);
  const order = [];
  for (let s = 0, cur = 0; s < n; s++) {
    let next = -1;
    for (let j = 0; j < n; j++) {
      if (!used[j] && (next === -1 || D[cur][j + 1] < D[cur][next + 1])) next = j;
    }
    used[next] = true;
    order.push(next);
    cur = next + 1;
  }

  // seq はノード番号の並び。先頭は起点 0、往復なら末尾も 0（動かせるのは 1〜last）
  const seq = [0, ...order.map((i) => i + 1)];
  if (roundtrip) seq.push(0);
  const m = seq.length;
  const last = roundtrip ? m - 2 : m - 1;
  const edge = (u, v) => (v == null ? 0 : D[u][v]);
  const end = performance.now() + HEURISTIC_MS;

  for (let improved = true; improved && performance.now() < end;) {
    improved = false;
    // 2-opt: seq[i..k] を反転したときの差分
    for (let i = 1; i < last; i++) {
      for (let k = i + 1; k <= last; k++) {
        const a = seq[i - 1];
        const b = seq[i];
        const c = seq[k];
        const d = k + 1 < m ? seq[k + 1] : null;
        if (D[a][c] + edge(b, d) < D[a][b] + edge(c, d) - 1e-9) {
          for (let x = i, y = k; x < y; x++, y--) [seq[x], seq[y]] = [seq[y], seq[x]];
          improved = true;
        }
      }
    }
    // Or-opt: 1 つの店を、一番短くなる別の辺の間へ移す
    for (let i = 1; i <= last; i++) {
      const p = seq[i - 1];
      const x = seq[i];
      const q = i + 1 < m ? seq[i + 1] : null;
      const gain = D[p][x] + edge(x, q) - (q == null ? 0 : D[p][q]);
      let bestJ = -1;
      let bestAdd = gain - 1e-9;
      for (let j = 0; j < m; j++) {
        if (j === i - 1 || j === i) continue;
        const u = seq[j];
        const v = j + 1 < m ? seq[j + 1] : null;
        if (v == null && roundtrip) continue;
        const add = D[u][x] + edge(x, v) - (v == null ? 0 : D[u][v]);
        if (add < bestAdd) {
          bestAdd = add;
          bestJ = j;
        }
      }
      if (bestJ >= 0) {
        seq.splice(i, 1);
        seq.splice(bestJ < i ? bestJ + 1 : bestJ, 0, x);
        improved = true;
      }
    }
  }
  return seq.slice(1, roundtrip ? -1 : undefined).map((node) => node - 1);
}
