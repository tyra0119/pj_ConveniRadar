// 実績（くじの記録）を文章にして、メールアプリ・共有メニュー・コピーで送る。
// GitHub Pages はサーバーを持たないので、アプリから自動でメールは送らない（送るのは利用者の端末のアプリ）
import { STATUSES } from './stores.js?v=9c449be1';

const APP_URL = 'https://tyra0119.github.io/pj_ConveniRadar/';
const MAILTO_MAX = 1800; // これより長い mailto はメールアプリによって途中で切れる

function clock(at) {
  if (!at) return '';
  const d = new Date(at);
  const today = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * campaign: くじ名
 * records: { storeId: { status, note, at } }
 * groups: [{ name: 停留所名, stores: [店] }]（行程の順。計画の順があればその順）
 * stores: 名前を引くための店の一覧（groups に無い記録の店名に使う）
 */
export function buildReport({ campaign, records, groups, stores }) {
  const recorded = Object.entries(records).filter(([, r]) => r.status || r.note);
  const counts = Object.entries(STATUSES).map(([k, st]) => `${st.icon}${st.label} ${recorded.filter(([, r]) => r.status === k).length}`);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${clock(now)}`;

  const line = (store, r) => {
    const st = STATUSES[r.status];
    return `・${st ? `${st.icon} ${st.label}` : '📝 メモ'}　${store?.name ?? '（名前不明の店）'}${r.at ? `（${clock(r.at)}）` : ''}${r.note ? `　メモ: ${r.note}` : ''}`;
  };

  const shown = new Set();
  const sections = [];
  for (const g of groups) {
    // 同じ店が計画と行程の両方に出てくるので、最初に出てきた停留所にだけ書く
    const rows = g.stores.filter((s) => !shown.has(s.id) && (records[s.id]?.status || records[s.id]?.note)).map((s) => {
      shown.add(s.id);
      return line(s, records[s.id]);
    });
    if (rows.length) sections.push(`■ ${g.name}\n${rows.join('\n')}`);
  }
  const byId = new Map(stores.map((s) => [s.id, s]));
  const others = recorded.filter(([id]) => !shown.has(id)).map(([id, r]) => line(byId.get(id), r));
  if (others.length) sections.push(`■ いまの行程にない店\n${others.join('\n')}`);

  const subject = `【コンビニ巡回】${campaign} の記録（${stamp}）`;
  const body = [
    `くじ・グッズ: ${campaign}`,
    `記録: ${counts.join(' ／ ')}`,
    '',
    sections.length ? sections.join('\n\n') : '（まだ記録はありません）',
    '',
    `— コンビニ巡回ルート 電車版（非公式）${APP_URL}`,
  ].join('\n');
  return { subject, body, count: recorded.length };
}

export function mailtoUrl(to, { subject, body }) {
  const text = body.length > MAILTO_MAX ? `${body.slice(0, MAILTO_MAX)}\n…（長いので途中まで。全文は「コピー」で貼り付けてください）` : body;
  return `mailto:${encodeURIComponent(to.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

export const canShare = () => typeof navigator.share === 'function';

export async function shareReport({ subject, body }) {
  await navigator.share({ title: subject, text: `${subject}\n\n${body}` });
}

export async function copyReport({ subject, body }) {
  const text = `${subject}\n\n${body}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http の手元確認や古いブラウザでは clipboard API が使えないので、選択してコピーする
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('コピーできませんでした');
  }
}
