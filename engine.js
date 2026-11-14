/* ===== Index engine: Sheet1 → specs, fetch (TWSE / FinMind / cnyes / U.S. Treasury), merge, derive, Excel I/O ===== */
(function (G) {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const num = s => { if (s == null || s === '') return null; const v = parseFloat(String(s).replace(/,/g, '')); return isFinite(v) ? v : null; };
  const rocToIso = s => { const [y, m, d] = s.split('/'); return (parseInt(y, 10) + 1911) + '-' + m + '-' + d; };
  const r2 = (v, d = 2) => v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const DEFAULT_START = '2025-10-01';

  const TWSE = 'https://www.twse.com.tw/rwd/zh/';
  const FINMIND = 'https://api.finmindtrade.com/api/v4/data';
  const CNYES = 'https://ws.api.cnyes.com/ws/api/v1/charting/history';
  const UST = y => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;

  /* ---------- fetch with timeout + retry ---------- */
  async function getText(url, tries = 3) {
    let err;
    for (let i = 0; i < tries; i++) {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
      try {
        const r = await fetch(url, { cache: 'no-store', signal: c.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
      } catch (e) { clearTimeout(t); err = e; if (i < tries - 1) await sleep(1500 * (i + 1)); }
    }
    throw new Error((err && err.message || 'fetch failed') + ' @ ' + url.split('?')[0]);
  }
  let lastTwse = 0;
  async function twse(path) {               // TWSE asks for gentle pacing between calls
    const wait = 2100 - (Date.now() - lastTwse); if (wait > 0) await sleep(wait);
    lastTwse = Date.now();
    return JSON.parse(await getText(TWSE + path));
  }
  async function finmind(qs) {
    const j = JSON.parse(await getText(FINMIND + '?' + qs));
    if (j.status !== 200) throw new Error('FinMind ' + (j.msg || j.status));
    return j.data || [];
  }
  function monthsBetween(fromIso, toIso) {
    const out = []; let y = +fromIso.slice(0, 4), m = +fromIso.slice(5, 7);
    const ty = +toIso.slice(0, 4), tm = +toIso.slice(5, 7);
    while (y < ty || (y === ty && m <= tm)) { out.push('' + y + pad(m) + '01'); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }

  /* ---------- source fetchers. Each returns rows sorted by date asc; tick() is called once per network call ---------- */
  const SRC = {
    twse_taiex: {
      label: 'TWSE 加權指數', calls: (from, to) => monthsBetween(from, to).length,
      async get(from, to, tick) {
        const rows = [];
        for (const d of monthsBetween(from, to)) {
          const j = await twse(`TAIEX/MI_5MINS_HIST?date=${d}&response=json`);
          if (j.stat === 'OK') for (const r of j.data) rows.push([rocToIso(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4])]);
          tick('TWSE 加權指數 ' + d.slice(0, 6));
        }
        return rows.filter(r => r[0] >= from && r[0] <= to);           // [date, open, high, low, close]
      }
    },
    twse_fmtqik: {
      label: 'TWSE 市場成交資訊', calls: (from, to) => monthsBetween(from, to).length,
      async get(from, to, tick) {
        const rows = [];
        for (const d of monthsBetween(from, to)) {
          const j = await twse(`afterTrading/FMTQIK?date=${d}&response=json`);
          if (j.stat === 'OK') for (const r of j.data) rows.push([rocToIso(r[0]), r2(num(r[2]) / 1e8, 2), num(r[3])]);
          tick('TWSE 成交資訊 ' + d.slice(0, 6));
        }
        return rows.filter(r => r[0] >= from && r[0] <= to);           // [date, turnover(億), trades]
      }
    },
    fm_margin: {
      label: 'FinMind 融資餘額', calls: () => 1,
      async get(from, to, tick) {
        const d = await finmind(`dataset=TaiwanStockTotalMarginPurchaseShortSale&start_date=${from}&end_date=${to}`);
        tick('融資餘額 (TWSE 信用交易統計 via FinMind)');
        return d.filter(x => x.name === 'MarginPurchaseMoney').map(x => [x.date, r2(x.TodayBalance / 1e8, 2)]).sort((a, b) => a[0] < b[0] ? -1 : 1);
      }
    },
    fm_foreign: {
      label: 'FinMind 外資買賣超', calls: () => 1,
      async get(from, to, tick) {
        const d = await finmind(`dataset=TaiwanStockTotalInstitutionalInvestors&start_date=${from}&end_date=${to}`);
        tick('外資買賣超 (TWSE 三大法人 via FinMind)');
        return d.filter(x => x.name === 'Foreign_Investor').map(x => [x.date, r2(x.buy / 1e8, 2), r2(x.sell / 1e8, 2), r2((x.buy - x.sell) / 1e8, 2)]).sort((a, b) => a[0] < b[0] ? -1 : 1);
      }
    },
    fm_futoi: {
      label: 'FinMind 外資台指期未平倉', calls: () => 1,
      async get(from, to, tick) {
        const d = await finmind(`dataset=TaiwanFuturesInstitutionalInvestors&data_id=TX&start_date=${from}&end_date=${to}`);
        tick('外資台指期未平倉 (TAIFEX via FinMind)');
        return d.filter(x => x.institutional_investors === '外資').map(x => [x.date, x.long_open_interest_balance_volume, x.short_open_interest_balance_volume,
          x.long_open_interest_balance_volume - x.short_open_interest_balance_volume]).sort((a, b) => a[0] < b[0] ? -1 : 1);
      }
    },
    ust: {
      label: 'U.S. Treasury', calls: (from, to) => +to.slice(0, 4) - +from.slice(0, 4) + 1,
      async get(from, to, tick) {
        const rows = [];
        for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
          const lines = (await getText(UST(y))).trim().split(/\r?\n/);
          const head = lines[0].split(',').map(s => s.replace(/"/g, ''));
          const k = head.indexOf('10 Yr');
          for (const ln of lines.slice(1)) { const c = ln.split(','); const [m, d, yy] = c[0].split('/'); rows.push([`${yy}-${m}-${d}`, num(c[k])]); }
          tick('U.S. Treasury ' + y);
        }
        return rows.filter(r => r[0] >= from && r[0] <= to && r[1] != null).sort((a, b) => a[0] < b[0] ? -1 : 1);
      }
    },
    cn: {   // cnyes daily bars: one call returns ~1 year
      label: '鉅亨網', calls: () => 1,
      async get(from, to, tick, sym) {
        const j = JSON.parse(await getText(`${CNYES}?symbol=${encodeURIComponent(sym)}&resolution=D&quote=1`));
        const d = j.data || {}; const rows = [];
        (d.t || []).forEach((ts, i) => rows.push([new Date(ts * 1000).toISOString().slice(0, 10), d.o[i], d.h[i], d.l[i], d.c[i]]));
        tick('鉅亨網 ' + sym);
        if (!rows.length) throw new Error('鉅亨網沒有 ' + sym + ' 的資料（代碼可能不正確）');
        return rows.filter(r => r[0] >= from && r[0] <= to && r[4] != null).sort((a, b) => a[0] < b[0] ? -1 : 1);
      }
    }
  };

  /* ---------- derived-column helpers ---------- */
  const pct = (a, b) => a == null || b == null || b === 0 ? null : (a / b - 1) * 100;
  const back = (arr, i, n) => i - n >= 0 ? arr[i - n] : null;
  const sumN = (a, i, n) => { if (i - n + 1 < 0) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) { if (a[k] == null) return null; s += a[k]; } return s; };
  const retCols = (C, i) => [r2(pct(C[i], back(C, i, 1))), r2(pct(C[i], back(C, i, 5))), r2(pct(C[i], back(C, i, 20)))];
  const pctRank = (vals, v) => { const ok = vals.filter(x => x != null); return v == null || !ok.length ? null : r2(ok.filter(x => x <= v).length / ok.length * 100, 1); };
  function kd(H, L, C) {
    const out = []; let K = 50, D = 50;
    for (let i = 0; i < C.length; i++) {
      const s = Math.max(0, i - 8);
      const hh = Math.max(...H.slice(s, i + 1)), ll = Math.min(...L.slice(s, i + 1));
      const rsv = hh === ll ? 50 : (C[i] - ll) / (hh - ll) * 100;
      const pK = K, pD = D;
      K = pK * 2 / 3 + rsv / 3; D = pD * 2 / 3 + K / 3;
      let sig = K > D ? '多方 (K>D)' : '空方 (K<D)';
      if (i > 0 && pK <= pD && K > D) sig = '黃金交叉';
      if (i > 0 && pK >= pD && K < D) sig = '死亡交叉';
      if (K >= 80 && sig.startsWith('多方')) sig = '多方・超買區';
      if (K <= 20 && sig.startsWith('空方')) sig = '空方・超賣區';
      out.push([r2(rsv), r2(K), r2(D), sig]);
    }
    return out;
  }
  function rsi(C, n = 14) {
    const out = [null]; let ag = 0, al = 0;
    for (let i = 1; i < C.length; i++) {
      const ch = C[i] - C[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= n) { ag += g / n; al += l / n; out.push(i === n ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : null); }
      else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); }
    }
    return out;
  }

  /* ---------- source links ---------- */
  const LK = {
    taiex: ['TWSE 發行量加權股價指數歷史資料', 'https://www.twse.com.tw/zh/indices/taiex/mi-5min-hist.html'],
    taiexApi: ['TWSE API (JSON，按月)', 'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=20261001&response=json'],
    fmtqik: ['TWSE 市場成交資訊 (FMTQIK)', 'https://www.twse.com.tw/zh/trading/historical/fmtqik.html'],
    fmtqikApi: ['TWSE API (JSON，按月)', 'https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=20261001&response=json'],
    bfi: ['TWSE 三大法人買賣金額統計表 (BFI82U)', 'https://www.twse.com.tw/zh/trading/foreign/bfi82u.html'],
    bfiApi: ['FinMind API (TaiwanStockTotalInstitutionalInvestors)', FINMIND + '?dataset=TaiwanStockTotalInstitutionalInvestors&start_date=2026-10-01'],
    margin: ['TWSE 融資融券彙總 (MI_MARGN)', 'https://www.twse.com.tw/zh/trading/margin/mi-margn.html'],
    marginApi: ['FinMind API (TaiwanStockTotalMarginPurchaseShortSale)', FINMIND + '?dataset=TaiwanStockTotalMarginPurchaseShortSale&start_date=2026-10-01'],
    taifex: ['TAIFEX 期貨契約 三大法人 (依日期)', 'https://www.taifex.com.tw/cht/3/futContractsDate'],
    taifexApi: ['FinMind API (TaiwanFuturesInstitutionalInvestors, TX)', FINMIND + '?dataset=TaiwanFuturesInstitutionalInvestors&data_id=TX&start_date=2026-10-01'],
    ust: ['U.S. Treasury Daily Par Yield Curve Rates', 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026'],
    ustApi: ['U.S. Treasury CSV', UST(2026)],
    cn: (sym, page) => [['鉅亨網 ' + sym, page || 'https://www.cnyes.com/'], ['鉅亨網 日線 API (JSON)', CNYES + '?symbol=' + sym + '&resolution=D&quote=1']]
  };
  const cnPage = sym => {
    const [a, b, c] = sym.split(':');
    if (c === 'FOREX') return `https://forex.cnyes.com/currency/${b.slice(0, 3)}/${b.slice(3)}`;
    if (a === 'TWS' && c === 'STOCK') return `https://www.cnyes.com/twstock/${b}`;
    if (c === 'FUTURES') return `https://invest.cnyes.com/futures/${a}/${b}`;
    return `https://invest.cnyes.com/index/${a}/${b}`;
  };

  /* ---------- spec templates ---------- */
  const OHLC = ['日期', '開盤', '最高', '最低', '收盤'];
  const T = {
    taiex: () => ({ title: '台股加權指數 TAIEX', unit: '點', dec: 2, links: [LK.taiex, LK.taiexApi], src: 'twse_taiex', raw: OHLC,
      derived: ['日報酬率(%)', '5日報酬率(%)', '20日報酬率(%)'],
      derive: R => { const C = R.map(r => r[4]); return R.map((r, i) => retCols(C, i)); },
      chart: { col: '收盤' }, chips: [['日報酬', '日報酬率(%)', '%'], ['5日', '5日報酬率(%)', '%'], ['20日', '20日報酬率(%)', '%']] }),
    kd: () => ({ title: '台股KD (9,3,3)', unit: '', dec: 2, links: [LK.taiex, LK.taiexApi], src: 'twse_taiex', raw: OHLC,
      derived: ['RSV', 'K', 'D', '交叉訊號'],
      derive: R => kd(R.map(r => r[2]), R.map(r => r[3]), R.map(r => r[4])),
      chart: { col: 'K', col2: 'D', range: [0, 100], guides: [20, 80], kind: 'osc' }, chips: [['K', 'K', ''], ['D', 'D', ''], ['訊號', '交叉訊號', 'txt']] }),
    rsi: () => ({ title: '台股RSI (14)', unit: '', dec: 2, links: [LK.taiex, LK.taiexApi], src: 'twse_taiex', raw: OHLC,
      derived: ['漲跌點', 'RSI(14)', 'RSI 歷史百分位(%)'],
      derive: R => { const C = R.map(r => r[4]); const v = rsi(C);
        return R.map((r, i) => [r2(i ? C[i] - C[i - 1] : null), r2(v[i]), pctRank(v, v[i])]); },
      chart: { col: 'RSI(14)', range: [0, 100], guides: [30, 70], kind: 'osc' }, chips: [['RSI', 'RSI(14)', ''], ['歷史百分位', 'RSI 歷史百分位(%)', '%u']] }),
    marginLevel: () => ({ title: '台股融資餘額 (上市)', unit: '億元', dec: 1, links: [LK.margin, LK.marginApi], src: 'fm_margin', raw: ['日期', '融資餘額(億)'],
      derived: ['日增減(億)', '日增減率(%)', '5日增減(億)'],
      derive: R => { const C = R.map(r => r[1]); return R.map((r, i) => [r2(i ? C[i] - C[i - 1] : null, 2), r2(pct(C[i], back(C, i, 1))), r2(back(C, i, 5) == null ? null : C[i] - C[i - 5], 2)]); },
      chart: { col: '融資餘額(億)' }, chips: [['日增減', '日增減(億)', '億'], ['5日增減', '5日增減(億)', '億']] }),
    marginChg: () => ({ title: '融資餘額 變化率', unit: '億元', dec: 1, links: [LK.margin, LK.marginApi], src: 'fm_margin', raw: ['日期', '融資餘額(億)'],
      derived: ['日變化(億)', '5日變化率(%)', '20日變化率(%)'],
      derive: R => { const C = R.map(r => r[1]); return R.map((r, i) => [r2(i ? C[i] - C[i - 1] : null, 2), r2(pct(C[i], back(C, i, 5))), r2(pct(C[i], back(C, i, 20)))]); },
      chart: { col: '融資餘額(億)' }, chips: [['5日', '5日變化率(%)', '%'], ['20日', '20日變化率(%)', '%']] }),
    futoi: () => ({ title: '外資台指期淨未平倉口數', unit: '口', dec: 0, links: [LK.taifex, LK.taifexApi], src: 'fm_futoi', raw: ['日期', '多方未平倉(口)', '空方未平倉(口)', '淨未平倉(口)'],
      derived: ['日變化(口)', '5日變化(口)', '20日變化(口)'],
      derive: R => { const C = R.map(r => r[3]); const ch = (i, n) => back(C, i, n) == null ? null : C[i] - C[i - n]; return R.map((r, i) => [ch(i, 1), ch(i, 5), ch(i, 20)]); },
      chart: { col: '淨未平倉(口)' }, chips: [['日變化', '日變化(口)', '口'], ['5日', '5日變化(口)', '口'], ['20日', '20日變化(口)', '口']] }),
    kdOf: (sym, label) => ({ title: label + ' 與 KD (9,3,3)', unit: '', dec: 2, links: LK.cn(sym, cnPage(sym)), src: 'cn:' + sym, raw: OHLC,
      derived: ['日報酬率(%)', '5日報酬率(%)', 'RSV', 'K', 'D', '交叉訊號'],
      derive: R => { const C = R.map(r => r[4]); const k = kd(R.map(r => r[2]), R.map(r => r[3]), C); return R.map((r, i) => [...retCols(C, i).slice(0, 2), ...k[i]]); },
      chart: { col: 'K', col2: 'D', range: [0, 100], guides: [20, 80], kind: 'osc' }, chips: [[label, '收盤', 'lvl'], ['5日', '5日報酬率(%)', '%'], ['K', 'K', ''], ['D', 'D', ''], ['訊號', '交叉訊號', 'txt']] }),
    closeOf: (sym, label, o = {}) => ({ title: label, unit: o.unit || '點', dec: o.dec != null ? o.dec : 2, links: LK.cn(sym, cnPage(sym)), src: 'cn:' + sym, raw: ['日期', '收盤'],
      derived: [`日${o.word || '報酬'}率(%)`, `5日${o.word || '報酬'}率(%)`, `20日${o.word || '報酬'}率(%)`],
      derive: R => { const C = R.map(r => r[1]); return R.map((r, i) => retCols(C, i)); },
      chart: { col: '收盤', guides: o.guides }, chips: [...(o.level ? [['水準', '收盤', 'lvl']] : []), ['5日', `5日${o.word || '報酬'}率(%)`, '%'], ['20日', `20日${o.word || '報酬'}率(%)`, '%']] }),
    foreign: () => ({ title: '外資買賣超金額', unit: '億元', dec: 1, links: [LK.bfi, LK.bfiApi, LK.fmtqik], src: 'fm_foreign', raw: ['日期', '買進(億)', '賣出(億)', '買賣超(億)', '市場成交金額(億)'],
      needs: ['twse_fmtqik'],
      derived: ['5日累積(億)', '5日累積/成交額(%)', '20日累積(億)', '20日累積/成交額(%)'],
      derive: R => { const N = R.map(r => r[3]), V = R.map(r => r[4]);
        return R.map((r, i) => { const s5 = sumN(N, i, 5), v5 = sumN(V, i, 5), s20 = sumN(N, i, 20), v20 = sumN(V, i, 20);
          return [r2(s5, 2), r2(s5 != null && v5 ? s5 / v5 * 100 : null), r2(s20, 2), r2(s20 != null && v20 ? s20 / v20 * 100 : null)]; }); },
      chart: { col: '買賣超(億)', bar: true, five: true }, chips: [['5日累積', '5日累積(億)', '億'], ['5日比例', '5日累積/成交額(%)', '%'], ['20日比例', '20日累積/成交額(%)', '%']] }),
    ust10: () => ({ title: '美國10年期公債殖利率', unit: '%', dec: 2, links: [LK.ust, LK.ustApi], src: 'ust', raw: ['日期', '殖利率(%)'],
      derived: ['日變動(bp)', '5日變動(bp)', '20日變動(bp)'],
      derive: R => { const C = R.map(r => r[1]); const bp = (i, n) => back(C, i, n) == null ? null : r2((C[i] - C[i - n]) * 100, 0); return R.map((r, i) => [bp(i, 1), bp(i, 5), bp(i, 20)]); },
      chart: { col: '殖利率(%)' }, chips: [['水準', '殖利率(%)', 'lvl'], ['5日', '5日變動(bp)', 'bp'], ['20日', '20日變動(bp)', 'bp']] }),
    volume: () => ({ title: '台股成交金額', unit: '億元', dec: 0, links: [LK.fmtqik, LK.fmtqikApi], src: 'twse_fmtqik', raw: ['日期', '成交金額(億)', '成交筆數'],
      derived: ['20日均量(億)', '相對20日均量(倍)'],
      derive: R => { const V = R.map(r => r[1]); return R.map((r, i) => { const s = sumN(V, i, 20); const m = s == null ? null : s / 20; return [r2(m, 1), r2(m ? V[i] / m : null)]; }); },
      chart: { col: '成交金額(億)', bar: true, five: true, col2: '20日均量(億)', neutral: true }, chips: [['相對20日均量', '相對20日均量(倍)', 'x']] }),
    pe: () => ({ title: '台股本益比 (估算)', unit: '倍', dec: 2,
      links: [['財報狗 台股本益比 (EPS 錨定值來源)', 'https://statementdog.com/taiex'], ['Goodinfo 加權指數本益比河流圖 (歷史參考)', 'https://goodinfo.tw/tw/ShowK_ChartFlow.asp?RPT_CAT=PER&STOCK_ID=%E5%8A%A0%E6%AC%8A%E6%8C%87%E6%95%B8&CHT_CAT=WEEK'], LK.taiex],
      src: 'twse_taiex', raw: ['日期', '收盤'], meta: ['EPS 錨定值', '錨定說明'],
      derived: ['EPS(估)', '本益比(倍)', '近一年百分位(%)'],
      derive: (R, meta) => { const eps = num(meta['EPS 錨定值']); const P = R.map(r => eps ? r[1] / eps : null);
        return R.map((r, i) => [r2(eps), r2(P[i]), pctRank(P, P[i])]); },
      chart: { col: '本益比(倍)' }, chips: [['本益比', '本益比(倍)', 'x'], ['近一年百分位', '近一年百分位(%)', '%u']] }),
    monthly: (title, links) => ({ title, unit: '%', dec: 2, monthly: true, links, src: null, raw: ['月份', '年增率(%)', '發布日期', '來源連結'],
      derived: ['較前月(百分點)'],
      derive: R => R.map((r, i) => [r2(i && R[i - 1][1] != null && r[1] != null ? r[1] - R[i - 1][1] : null, 2)]),
      chart: { col: '年增率(%)', bar: true, five: true }, chips: [['最新', '年增率(%)', '%'], ['較前月', '較前月(百分點)', 'pt']] }),
    manual: (title, monthly) => ({ title, unit: '', dec: 2, monthly: !!monthly, manual: true, links: [], src: null, raw: [monthly ? '月份' : '日期', '數值', '備註'],
      derived: ['變化', '變化率(%)'],
      derive: R => R.map((r, i) => { const p = i ? R[i - 1][1] : null; return [r2(p == null || r[1] == null ? null : r[1] - p), r2(pct(r[1], p))]; }),
      chart: { col: '數值' }, chips: [['最新', '數值', 'lvl'], ['變化', '變化', '']] })
  };

  /* ---------- catalog: Sheet1 名稱 → template (first match wins) ---------- */
  const CATALOG = [
    [/KD/i, n => /KOSPI|韓/.test(n) ? T.kdOf('GI:KOSPI:INDEX', 'KOSPI') : T.kd()],
    [/RSI/i, T.rsi],
    [/本益比|P\/?E/i, T.pe],
    [/(台股|上市)融資/, T.marginLevel],
    [/融資/, T.marginChg],
    [/外資.*(期貨|台指|未平倉)/, T.futoi],
    [/外資|三大法人/, T.foreign],
    [/KOSPI|韓國/i, () => T.kdOf('GI:KOSPI:INDEX', 'KOSPI')],
    [/USD.?TWD|美元.*新台幣|新台幣.*匯率/i, () => T.closeOf('FX:USDTWD:FOREX', 'USD/TWD 匯率', { unit: 'TWD', dec: 3, word: '變動' })],
    [/USD.?JPY|日圓|日幣/i, () => T.closeOf('FX:USDJPY:FOREX', 'USD/JPY 匯率', { unit: 'JPY', dec: 2, word: '變動' })],
    [/USD.?CNY|人民幣/i, () => T.closeOf('FX:USDCNY:FOREX', 'USD/CNY 匯率', { unit: 'CNY', dec: 4, word: '變動' })],
    [/EUR.?USD|歐元/i, () => T.closeOf('FX:EURUSD:FOREX', 'EUR/USD 匯率', { unit: 'USD', dec: 4, word: '變動' })],
    [/美元指數|DXY/i, () => T.closeOf('GI:DXY:INDEX', '美元指數 DXY', { unit: '', word: '變動' })],
    [/SOX|費城半導體|費半/i, () => T.closeOf('GI:SOX:INDEX', '費城半導體指數 SOX')],
    [/NASDAQ|那斯達克/i, () => T.closeOf('GI:IXIC:INDEX', 'NASDAQ 綜合指數')],
    [/S&P|標普|SP500|SPX/i, () => T.closeOf('GI:INX:INDEX', 'S&P 500 指數')],
    [/道瓊|DOW|DJI/i, () => T.closeOf('GI:DJI:INDEX', '道瓊工業指數')],
    [/日經|NIKKEI|N225/i, () => T.closeOf('GI:NKY:INDEX', '日經225指數')],
    [/恒生|恆生|HSI|香港/i, () => T.closeOf('GI:HSI:INDEX', '香港恒生指數')],
    [/上證|上海|SSEC/i, () => T.closeOf('GI:SSEC:INDEX', '上證綜合指數')],
    [/DAX|德國/i, () => T.closeOf('GI:DAX:INDEX', '德國 DAX 指數')],
    [/FTSE|富時|英國/i, () => T.closeOf('GI:FTSE:INDEX', '英國富時100指數')],
    [/櫃買|OTC/i, () => T.closeOf('TWS:OTC01:INDEX', '櫃買指數')],
    [/VIX|波動率/i, () => T.closeOf('GF:VIX:FUTURES', 'CBOE VIX 波動率指數', { unit: '', word: '變動', level: true, guides: [20, 30] })],
    [/10年.*殖利率|10Y|美債/i, T.ust10],
    [/WTI/i, () => T.closeOf('GI:WTCL:INDEX', 'WTI 原油期貨 (近月)', { unit: 'USD/bbl' })],
    [/布蘭特|BRENT/i, () => T.closeOf('GI:LCO:INDEX', '布蘭特原油期貨 (近月)', { unit: 'USD/bbl' })],
    [/成交量|成交金額|成交值/, T.volume],
    [/外銷訂單/, () => T.monthly('台灣外銷訂單 年增率', [['經濟部統計處 外銷訂單統計 (新聞稿)', 'https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724']])],
    [/工業生產/, () => T.monthly('台灣工業生產指數 年增率', [['經濟部統計處 工業生產統計 (新聞稿)', 'https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=6&html=1&menu_id=6725']])],
    [/加權|TAIEX|大盤/i, T.taiex]
  ];
  const sheetName = s => String(s).replace(/[\\\/?*\[\]:]/g, '-').slice(0, 31);
  function specFor(row) {
    const name = String(row.name).trim(); const src = (row.source || '').trim();
    let t = null;
    if (/^[A-Z]{2,4}:[A-Z0-9.]+:[A-Z]+$/i.test(src)) t = T.closeOf(src.toUpperCase(), name);
    else if (/^\d{4,6}[A-Z]?$/i.test(src)) t = T.closeOf(`TWS:${src.toUpperCase()}:STOCK`, name, { unit: '元' });
    else { const m = /(?:^|\D)(\d{4,6})(?:\D|$)/.exec(name); // e.g. "台積電 2330"
      for (const [re, f] of CATALOG) if (re.test(name)) { t = f(name); break; }
      if (!t && m) t = T.closeOf(`TWS:${m[1]}:STOCK`, name, { unit: '元' }); }
    if (!t) t = T.manual(name, /month|月/i.test(row.freq || ''));
    return Object.assign(t, { key: sheetName(name), sheet: sheetName(name), name, note: row.note || '', freq: row.freq || '' });
  }

  /* ---------- fetch everything needed ---------- */
  // specs: active specs; lastDates: {key: 'YYYY-MM-DD'|null}. Returns {res:{key:rows}, warnings}
  function plan(specs, lastDates, today) {
    const need = {};            // srcId -> from
    const add = (id, from) => { if (!need[id] || from < need[id]) need[id] = from; };
    for (const s of specs) {
      if (!s.src) continue;
      const from = lastDates[s.key] || DEFAULT_START;
      add(s.src, from); (s.needs || []).forEach(n => add(n, from));
    }
    const jobs = Object.entries(need).map(([id, from]) => {
      const base = id.startsWith('cn:') ? SRC.cn : SRC[id];
      return { id, from, calls: base.calls(from, today), run: tick => base.get(from, today, tick, id.slice(3)) };
    });
    return { jobs, total: jobs.reduce((a, j) => a + j.calls, 0) };
  }
  async function fetchAll(specs, lastDates, today, tick, warn) {
    const { jobs } = plan(specs, lastDates, today);
    const data = {};
    // run TWSE jobs sequentially (rate-limited), others in parallel
    const tw = jobs.filter(j => j.id.startsWith('twse_')), other = jobs.filter(j => !j.id.startsWith('twse_'));
    const runJob = async j => { try { data[j.id] = await j.run(tick); } catch (e) { warn(j.id.replace(/^cn:/, '鉅亨網 ') + ' 讀取失敗：' + e.message); for (let i = 0; i < j.calls; i++) tick(null); } };
    await Promise.all([(async () => { for (const j of tw) await runJob(j); })(), ...other.map(runJob)]);
    const res = {};
    for (const s of specs) {
      if (!s.src || !data[s.src]) continue;
      const from = lastDates[s.key] || DEFAULT_START;
      let rows = data[s.src].filter(r => r[0] >= from);
      if (s.raw.length === 2 && rows.length && rows[0].length === 5) rows = rows.map(r => [r[0], r[4]]);
      if (s.src === 'fm_foreign') { const tv = Object.fromEntries((data.twse_fmtqik || []).map(r => [r[0], r[1]])); rows = rows.map(r => [...r, tv[r[0]] != null ? tv[r[0]] : null]); }
      res[s.key] = rows;
    }
    return res;
  }

  /* ---------- merge + derive ---------- */
  function build(spec, existingRaw, newRaw, meta = {}) {
    const m = new Map();
    for (const r of existingRaw || []) if (r && r[0]) m.set(String(r[0]), r.slice(0, spec.raw.length));
    for (const r of newRaw || []) if (r && r[0]) {   // keep any non-empty existing cell when the new row lacks it
      const old = m.get(String(r[0])); const nr = r.slice(0, spec.raw.length);
      if (old) nr.forEach((v, i) => { if (v == null && old[i] != null) nr[i] = old[i]; });
      m.set(String(r[0]), nr);
    }
    const keys = [...m.keys()].sort();
    const R = keys.map(k => m.get(k));
    const D = spec.derive(R, meta);
    return { headers: [...spec.raw, ...spec.derived], rows: R.map((r, i) => [...r, ...D[i]]) };
  }

  /* ---------- summary for chart: base day + latest 5 (or 5 bars) ---------- */
  function summary(spec, table) {
    const H = table.headers, rows = table.rows; const n = spec.chart.five || spec.monthly ? 5 : 6;
    const col = H.indexOf(spec.chart.col), col2 = spec.chart.col2 ? H.indexOf(spec.chart.col2) : -1;
    const sel = rows.filter(r => r[col] != null).slice(-n);
    const last = sel[sel.length - 1] || rows[rows.length - 1] || [];
    return {
      key: spec.key, name: spec.name, title: spec.title, note: spec.note, unit: spec.unit, dec: spec.dec, monthly: !!spec.monthly, manual: !!spec.manual,
      dates: sel.map(r => r[0]), values: sel.map(r => r[col]), values2: col2 >= 0 ? sel.map(r => r[col2]) : null,
      label: spec.chart.col, label2: col2 >= 0 ? spec.chart.col2 : null, bar: !!spec.chart.bar, five: !!(spec.chart.five || spec.monthly), neutral: !!spec.chart.neutral,
      kind: spec.chart.kind || '', range: spec.chart.range || null, guides: spec.chart.guides || null,
      chips: spec.chips.map(([lab, c, kind]) => [lab, last[H.indexOf(c)], kind]),
      links: spec.links, lastDate: last[0] || null, count: rows.length
    };
  }

  /* ---------- Excel I/O (ExcelJS workbook) ---------- */
  const cellVal = v => {
    if (v == null) return null;
    if (v instanceof Date) return ymd(new Date(v.getTime() + v.getTimezoneOffset() * 60000));
    if (typeof v === 'object') { if ('result' in v) return v.result; if ('text' in v) return v.hyperlink ? v.hyperlink : v.text; if (v.richText) return v.richText.map(t => t.text).join(''); }
    return v;
  };
  function readIndexList(wb) {
    const ws = wb.getWorksheet('Sheet1') || wb.worksheets[0]; const out = []; const seen = new Set();
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const name = cellVal(row.getCell(1).value); if (name == null || String(name).trim() === '') return;
      const k = sheetName(String(name).trim()); if (seen.has(k)) return; seen.add(k);
      out.push({ name: String(name).trim(), freq: String(cellVal(row.getCell(2).value) || ''), note: String(cellVal(row.getCell(3).value) || ''), source: String(cellVal(row.getCell(4).value) || '') });
    });
    return out;
  }
  function readSheet(ws, spec) {
    const out = { raw: [], meta: {} }; if (!ws) return out; let hdr = 0;
    ws.eachRow((row, i) => {
      const a = cellVal(row.getCell(1).value);
      if (!hdr && (a === '日期' || a === '月份')) { hdr = i; return; }
      if (!hdr) { if (a != null) out.meta[String(a)] = cellVal(row.getCell(2).value); return; }
      if (a == null || a === '') return;
      const r = []; for (let c = 1; c <= spec.raw.length; c++) { let v = cellVal(row.getCell(c).value); if (c === 1) v = String(v).slice(0, spec.monthly ? 7 : 10); r.push(v === '' ? null : v); }
      out.raw.push(r);
    });
    out.raw.sort((x, y) => x[0] < y[0] ? -1 : 1); return out;
  }
  function writeSheet(wb, spec, table, meta, stamp) {
    let ws = wb.getWorksheet(spec.sheet); if (!ws) ws = wb.addWorksheet(spec.sheet);
    const oldCount = ws.rowCount; let cur = 0;
    const bold = { bold: true };
    const add = v => { const row = ws.getRow(++cur); row.values = []; row.font = {}; row.eachCell({ includeEmpty: true }, c => { c.style = {}; });
      v.forEach((x, i) => { row.getCell(i + 1).value = x; }); return row; };
    add(['指標', spec.name]).getCell(1).font = bold;
    add(['說明', spec.title + (spec.note ? '：' + spec.note : '')]).getCell(1).font = bold;
    if (spec.links.length) spec.links.forEach(([t, u]) => { const r = add(['資料來源', { text: t, hyperlink: u }, u]); r.getCell(1).font = bold; r.getCell(2).font = { color: { argb: 'FF1F5FA7' }, underline: true }; });
    else add(['資料來源', spec.manual ? '未能自動辨識。請在 Sheet1 D 欄填入鉅亨網代碼 (例 GI:NKY:INDEX) 或台股代號，或於下方表格手動輸入資料' : '']).getCell(1).font = bold;
    add(['最後更新', stamp]).getCell(1).font = bold;
    (spec.meta || []).forEach(k => add([k, meta[k] != null ? meta[k] : null]).getCell(1).font = bold);
    add([]);
    const h = add(table.headers); h.font = bold; h.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF5' } }; });
    table.rows.forEach(r => { const row = add(r.map(v => v == null ? null : v)); if (spec.monthly && !spec.manual && r[3]) row.getCell(4).value = { text: String(r[3]), hyperlink: String(r[3]) }; });
    for (let i = cur + 1; i <= oldCount; i++) { const row = ws.getRow(i); row.values = []; row.eachCell({ includeEmpty: true }, c => { c.style = {}; }); }
    ws.getColumn(1).width = 12; for (let c = 2; c <= Math.max(3, table.headers.length); c++) ws.getColumn(c).width = Math.max(12, String(table.headers[c - 1] || '').length * 2 + 2);
    ws.getColumn(2).width = Math.max(ws.getColumn(2).width, 20); ws.views = [{ state: 'frozen', ySplit: h.number }];
  }

  G.ENGINE = { SRC, T, CATALOG, specFor, plan, fetchAll, build, summary, readIndexList, readSheet, writeSheet, sheetName, ymd, r2, DEFAULT_START };
  if (typeof module !== 'undefined') module.exports = G.ENGINE;
})(typeof window !== 'undefined' ? window : globalThis);
