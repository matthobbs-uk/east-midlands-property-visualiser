/* ==========================================================================
   East Midlands £550k+ property visualiser
   Plain ES5-compatible browser JS, no modules, so it runs from file://.
   ========================================================================== */
(function () {
'use strict';

// ---------------------------------------------------------------- constants

var D = window.EM_DATA;
var C = D.sales.cols;
var DICT = D.sales.dict;
var N = D.sales.n;

var BASE_YEAR = 2010;
var LAST_MONTH = Math.max.apply(null, C.date);          // months since 2010-01
var LAST_YEAR = BASE_YEAR + Math.floor(LAST_MONTH / 12);
var PARTIAL_YEAR = LAST_YEAR;                            // 2026 = Jan–Jun only

var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Flag bits, mirroring build_data.py. There is no "comparable" bit to test:
// build_data.py ships comparables only, so a non-comparable cannot reach a chart.
var F_SEARCH = 2, F_NEW = 4;
var EXCLUDED = (D.sales.excluded) || { total: 0, ofFile: N, reasons: [] };

// district -> county, and the reverse, built at load
var COUNTY_OF = D.counties || {};
var COUNTIES = (function () {
  var byCounty = {};
  Object.keys(COUNTY_OF).forEach(function (d) {
    (byCounty[COUNTY_OF[d]] || (byCounty[COUNTY_OF[d]] = [])).push(d);
  });
  return Object.keys(byCounty).sort().map(function (c) {
    return { name: c, districts: byCounty[c].sort() };
  });
})();

// colour roles — kept in sync with styles.css
var SEQ = ['#1d2129','#4a3a16','#7a5709','#a87206','#c98500','#e3a52f','#f6cd7c'];
var DIV = ['#1f5fa8','#3987e5','#7fb0ee','#383c42','#efa3a3','#e66767','#c33c3c'];
var ACCENT = '#c98500';
var ACCENT_UI = '#e8a33d';
var MUTED = '#495059';
var SURFACE = '#14171c';
var INK3 = '#737a86';
var LADDER = ['#7a5709','#a87206','#d99a2b','#f6cd7c'];

var BANDS = [
  { key: '550-750', label: '£550k–750k', lo: 550000,  hi: 750000 },
  { key: '750-1m',  label: '£750k–1m',   lo: 750000,  hi: 1000000 },
  { key: '1m-2m',   label: '£1m–2m',     lo: 1000000, hi: 2000000 },
  { key: '2m+',     label: '£2m+',       lo: 2000000, hi: Infinity }
];

// Smallest sample an area needs before it earns a place in momentum/value work.
// Villages are held to a lower bar than zones or districts — at a £550k floor
// even a well-known village records only a handful of sales a decade, so 20
// would empty the view entirely — and the charts say so where it matters.
var MIN_AREA_SALES = 20;
var MIN_VILLAGE_SALES = 10;
var MOVER_FLOOR_LABEL = 12;   // a mover needs this in BOTH windows, else a
                              // 9 -> 19 zone outranks a 262 -> 182 one
var MIN_WINDOW_SALES = 5;
function minSalesFor(grain) { return grain === 'settlement' ? MIN_VILLAGE_SALES : MIN_AREA_SALES; }

// villages are numerous, so the distribution chart shows the busiest slice of
// them rather than several thousand pixels of rows
var MAX_DIST_ROWS = 40;

// ----------------------------------------------------------------- helpers

function $(id) { return document.getElementById(id); }
function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}
var NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, kids) {
  var e = document.createElementNS(NS, tag), k;
  if (attrs) for (k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
  if (kids !== undefined && kids !== null) {
    if (!Array.isArray(kids)) kids = [kids];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
  }
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function fmtInt(n) { return Math.round(n).toLocaleString('en-GB'); }
function fmtMoney(n) { return '£' + Math.round(n).toLocaleString('en-GB'); }
function fmtCompact(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return '£' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'bn';
  if (Math.abs(n) >= 1e6) return '£' + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.0+$/, '') + 'm';
  if (Math.abs(n) >= 1e3) return '£' + Math.round(n / 1e3) + 'k';
  return '£' + Math.round(n);
}
function fmtPct(v, dp) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(dp === undefined ? 1 : dp) + '%';
}
function monthLabel(m) { return MONTHS[m % 12] + ' ' + (BASE_YEAR + Math.floor(m / 12)); }
function yearOf(m) { return BASE_YEAR + Math.floor(m / 12); }

function quantile(sorted, q) {
  if (!sorted.length) return null;
  var pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}
function median(sortedArr) { return quantile(sortedArr, 0.5); }
function sum(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return t; }

function linear(d0, d1, r0, r1) {
  var span = (d1 - d0) || 1;
  var f = function (v) { return r0 + (v - d0) * (r1 - r0) / span; };
  f.d0 = d0; f.d1 = d1; f.r0 = r0; f.r1 = r1;
  f.invert = function (p) { return d0 + (p - r0) * span / (r1 - r0); };
  return f;
}

// Prices are multiplicative and long-tailed: on a linear axis one area with a
// few £3m sales flattens every difference that matters between £600k and £800k.
function logScale(d0, d1, r0, r1) {
  var l0 = Math.log(d0), l1 = Math.log(d1), span = (l1 - l0) || 1;
  return function (v) { return r0 + (Math.log(Math.max(v, 1)) - l0) * (r1 - r0) / span; };
}
function priceTicks(lo, hi) {
  var cand = [400e3, 500e3, 600e3, 700e3, 800e3, 900e3, 1e6, 1.25e6, 1.5e6, 2e6, 2.5e6, 3e6, 4e6, 5e6, 7.5e6, 10e6, 20e6];
  var out = cand.filter(function (v) { return v >= lo && v <= hi; });
  // a narrow range (zone medians all sit between about £570k and £750k) needs
  // finer steps or the axis renders with two labels
  if (out.length < 4) {
    var fine = [];
    for (var v = 500e3; v <= 1.6e6; v += 50e3) fine.push(v);
    var f = fine.filter(function (t) { return t >= lo && t <= hi; });
    if (f.length >= out.length) out = f;
  }
  return out;
}

function niceTicks(min, max, count) {
  if (min === max) { max = min + 1; }
  var span = max - min;
  var step = Math.pow(10, Math.floor(Math.log(span / count) / Math.LN10));
  var err = span / count / step;
  if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
  var out = [], v = Math.ceil(min / step) * step;
  for (; v <= max + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

// first and last year always, then every third year — but never one that would
// collide with an end label
function yearTicks(years, width) {
  var first = years[0], last = years[years.length - 1];
  // a 375px chart cannot carry a label every three years without them colliding
  var step = (width && width < 480) ? 6 : (width && width < 760 ? 4 : 3);
  return years.filter(function (y) {
    if (y === first || y === last) return true;
    if (y % step !== 0) return false;
    return Math.abs(y - first) > 1 && Math.abs(y - last) > 1;
  });
}

// Greedy label placement: callers try labels in priority order and the first
// one to claim a patch of canvas keeps it. Boxes are centre-anchored, so a
// left-aligned label passes the centre of its own box, not its start.
function labelPlacer(defW, defH) {
  var placed = [];
  return function (cx, cy, w, h) {
    w = w || defW; h = h || defH;
    for (var i = 0; i < placed.length; i++) {
      var p = placed[i];
      if (Math.abs(p[0] - cx) < (p[2] + w) / 2 && Math.abs(p[1] - cy) < (p[3] + h) / 2) return false;
    }
    placed.push([cx, cy, w, h]);
    return true;
  };
}

function lerpHex(a, b, t) {
  var ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
  var br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  var f = function (x, y) { var v = Math.round(x + (y - x) * t); return (v < 16 ? '0' : '') + v.toString(16); };
  return '#' + f(ar, br) + f(ag, bg) + f(ab, bb);
}
function rampColor(ramp, t) {
  t = Math.max(0, Math.min(1, t));
  var i = t * (ramp.length - 1), lo = Math.floor(i);
  if (lo >= ramp.length - 1) return ramp[ramp.length - 1];
  return lerpHex(ramp[lo], ramp[lo + 1], i - lo);
}
// luminance-aware ink for text sitting inside a coloured fill
function inkOn(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? '#14171c' : '#f4f2ee';
}

// ==========================================================================
// REPEAT-SALES PRICE INDEX
//
// The observed median by year is flat across sixteen years — £655k in 2010,
// £670k in 2025 — and that is an artefact, not the market. The extract has a
// fixed £550,000 floor, so as prices rise progressively more modest houses
// cross it and drag the observed median back down, very nearly cancelling real
// growth. (The share of semis and terraces in the sample climbs from 8.4% to
// 12.2% over the period, which is that effect made visible.)
//
// The honest measure is the same house sold twice: size, plot, aspect and
// street held constant, so the change in price is the change in price. 832
// addresses here sold more than once. This is the standard repeat-sales
// regression (the method behind Case-Shiller), solved by ordinary least
// squares on log price relatives.
//
// It is computed ONCE over the whole region and deliberately does not follow
// the area filter: below district level the pair counts collapse — the median
// village has two — and a per-village index would be pure noise wearing the
// authority of a line chart.
// ==========================================================================

var RSI = (function () {
  var MIN_GAP_MONTHS = 6;      // ignore near-instant resales; often the same deal
  var MAX_RATIO = 2.0;         // a doubling is an extension or a rebuild, not the market
  var MIN_RATIO = 0.5;
  var BASE = 2013;             // 2010–12 rests on ~20 pairs; too thin to anchor on
  var BOOTSTRAPS = 160;

  // group by address; the address strings are title-cased consistently by
  // build_data.py so they match exactly
  var byAddr = {};
  for (var i = 0; i < N; i++) {
    var a = C.address[i];
    (byAddr[a] || (byAddr[a] = [])).push(i);
  }

  var pairs = [], repeatsOf = {}, addrCount = 0;
  Object.keys(byAddr).forEach(function (a) {
    var list = byAddr[a];
    if (list.length < 2) return;
    addrCount++;
    list.sort(function (p, q) { return C.date[p] - C.date[q]; });
    repeatsOf[a] = list;
    for (var k = 1; k < list.length; k++) {
      var p0 = list[k - 1], p1 = list[k];
      var gap = C.date[p1] - C.date[p0];
      if (gap < MIN_GAP_MONTHS) continue;
      var ratio = C.price[p1] / C.price[p0];
      if (ratio > MAX_RATIO || ratio < MIN_RATIO) continue;
      pairs.push({ y0: yearOf(C.date[p0]), y1: yearOf(C.date[p1]), lr: Math.log(ratio) });
    }
  });

  var YEARS = [];
  for (var y = BASE_YEAR; y <= LAST_YEAR; y++) YEARS.push(y);
  var pos = {};
  YEARS.forEach(function (yr, k) { pos[yr] = k; });

  // Solve for annual log-levels: for each pair, level(y1) - level(y0) = log ratio.
  // Normal equations give a symmetric system; one year is pinned to break the
  // translation degeneracy.
  function solve(ps) {
    var n = YEARS.length, A = [], b = [], r, c;
    for (r = 0; r < n; r++) { A.push(new Array(n)); for (c = 0; c < n; c++) A[r][c] = 0; b.push(0); }
    for (var k = 0; k < ps.length; k++) {
      var i = pos[ps[k].y0], j = pos[ps[k].y1], lr = ps[k].lr;
      A[i][i] += 1; A[j][j] += 1; A[i][j] -= 1; A[j][i] -= 1;
      b[i] -= lr; b[j] += lr;
    }
    A[pos[BASE]][pos[BASE]] += 1e6;                    // pin the base year at 0
    for (var p = 0; p < n; p++) {                      // gaussian elimination, partial pivot
      var best = p;
      for (r = p + 1; r < n; r++) if (Math.abs(A[r][p]) > Math.abs(A[best][p])) best = r;
      var t = A[p]; A[p] = A[best]; A[best] = t;
      var tb = b[p]; b[p] = b[best]; b[best] = tb;
      if (Math.abs(A[p][p]) < 1e-12) A[p][p] = 1e-9;
      for (r = p + 1; r < n; r++) {
        var f = A[r][p] / A[p][p];
        if (!f) continue;
        for (c = p; c < n; c++) A[r][c] -= f * A[p][c];
        b[r] -= f * b[p];
      }
    }
    var x = new Array(n);
    for (r = n - 1; r >= 0; r--) {
      var s = 0;
      for (c = r + 1; c < n; c++) s += A[r][c] * x[c];
      x[r] = (b[r] - s) / A[r][r];
    }
    return x;
  }

  var level = {}, band = {};
  if (pairs.length >= 60) {
    var fit = solve(pairs);
    YEARS.forEach(function (yr) { level[yr] = Math.exp(fit[pos[yr]]) * 100; });

    // bootstrap the pair sample for an honest uncertainty band
    var draws = {};
    YEARS.forEach(function (yr) { draws[yr] = []; });
    var seed = 20260801;
    var rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (var bIdx = 0; bIdx < BOOTSTRAPS; bIdx++) {
      var samp = new Array(pairs.length);
      for (var s2 = 0; s2 < pairs.length; s2++) samp[s2] = pairs[(rnd() * pairs.length) | 0];
      try {
        var f2 = solve(samp);
        YEARS.forEach(function (yr) { draws[yr].push(Math.exp(f2[pos[yr]]) * 100); });
      } catch (e) { /* a degenerate resample just contributes nothing */ }
    }
    YEARS.forEach(function (yr) {
      var d = draws[yr].sort(function (p, q) { return p - q; });
      band[yr] = d.length ? { lo: quantile(d, 0.05), hi: quantile(d, 0.95) } : null;
    });
  }

  // how many pairs inform each year, so the chart can fade a thin tail
  var perYear = {};
  YEARS.forEach(function (yr) { perYear[yr] = 0; });
  pairs.forEach(function (p) { perYear[p.y0]++; perYear[p.y1]++; });

  // the factor to restate a price from one year in another year's money
  function factor(fromYear, toYear) {
    if (!level[fromYear] || !level[toYear]) return null;
    return level[toYear] / level[fromYear];
  }

  return {
    base: BASE, years: YEARS, level: level, band: band, perYear: perYear,
    pairs: pairs.length, addresses: addrCount, repeatsOf: repeatsOf,
    factor: factor,
    ok: pairs.length >= 60
  };
})();

// ---------------------------------------------------------------- tooltip

var tipEl = $('tip');
function tipShow(ev, title, rows, foot) {
  clear(tipEl);
  if (title) tipEl.appendChild(el('div', 't-title', title));
  (rows || []).forEach(function (r) {
    var row = el('div', 't-row');
    var k = el('span', 'k');
    if (r.color) {
      var key = el('span', 't-key');
      key.style.background = r.color;
      k.appendChild(key);
    }
    k.appendChild(document.createTextNode(r.k));
    row.appendChild(k);
    row.appendChild(el('span', 'v', r.v));
    tipEl.appendChild(row);
  });
  if (foot) tipEl.appendChild(el('div', 't-foot', foot));
  tipEl.classList.add('on');
  tipMove(ev);
}
// prose variant of the tooltip, for explaining a control rather than a mark
function tipShowHelp(ev, title, body, foot) {
  clear(tipEl);
  tipEl.appendChild(el('div', 't-title', title));
  tipEl.appendChild(el('div', 't-body', body));
  if (foot && foot.length) {
    var f = el('div', 't-foot');
    // an array foot renders as one line per entry (used for the exclusion list)
    [].concat(foot).forEach(function (line) { f.appendChild(el('div', null, line)); });
    tipEl.appendChild(f);
  }
  tipEl.classList.add('on');
  tipEl.classList.add('wide');
  tipMove(ev);
}

function tipMove(ev) {
  var pad = 16, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  var x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  tipEl.style.left = Math.max(8, x) + 'px';
  tipEl.style.top = Math.max(8, y) + 'px';
}
function tipHide() { tipEl.classList.remove('on'); tipEl.classList.remove('wide'); }

// bind hover + keyboard focus to a mark, with a hit target of its own
function bindTip(node, build) {
  node.addEventListener('pointerenter', function (e) { var t = build(); tipShow(e, t.title, t.rows, t.foot); });
  node.addEventListener('pointermove', tipMove);
  node.addEventListener('pointerleave', tipHide);
  node.addEventListener('focus', function () {
    var r = node.getBoundingClientRect(), t = build();
    tipShow({ clientX: r.left + r.width / 2, clientY: r.top }, t.title, t.rows, t.foot);
  });
  node.addEventListener('blur', tipHide);
}

// ------------------------------------------------------------------ state

var state = {
  y0: BASE_YEAR,
  y1: LAST_YEAR,
  county: '',
  district: '',
  village: '',
  area: null,          // {kind, name} — an exact scope, beats the loose text match
  ptype: '',
  bands: {},          // key -> true
  search: false,
  newBuild: 0,        // 0 = all, 1 = new build only, -1 = exclude new build
  view: 'pulse',
  mapMetric: 'volume',
  mapSel: null,
  grain: 'zone',      // zone | district for momentum + value
  salesSort: { col: 'date', dir: -1 },
  salesLimit: 400,
  todayMoney: false,   // restate past prices in today's money — off by default
  repeatOnly: false,
  openHistory: null,
  salesQuery: ''
};

var TABLES = {};      // chartId -> {cols, rows} for the table twin

// ------------------------------------------------------------------ slice

var idxAll = [];
for (var _i = 0; _i < N; _i++) idxAll.push(_i);

function passes(i, skipVillage) {
  var y = yearOf(C.date[i]);
  if (y < state.y0 || y > state.y1) return false;
  if (state.search && !(C.flags[i] & F_SEARCH)) return false;
  if (state.newBuild === 1 && !(C.flags[i] & F_NEW)) return false;
  if (state.newBuild === -1 && (C.flags[i] & F_NEW)) return false;
  if (state.county && COUNTY_OF[DICT.district[C.district[i]]] !== state.county) return false;
  if (state.district && DICT.district[C.district[i]] !== state.district) return false;
  if (state.ptype && DICT.ptype[C.ptype[i]] !== state.ptype) return false;
  if (!skipVillage) {
    // an exact area pick (village, zone, postcode district or sector) beats the
    // loose text match, which pools every settlement whose name contains the text
    if (state.area) {
      if (areaValue(state.area.kind, i) !== state.area.name) return false;
    } else if (state.village &&
               DICT.settlement[C.settlement[i]].toLowerCase().indexOf(state.village) < 0) return false;
  }
  var bk = Object.keys(state.bands);
  if (bk.length) {
    var p = C.price[i], ok = false;
    for (var b = 0; b < bk.length; b++) {
      var band = BANDS.filter(function (x) { return x.key === bk[b]; })[0];
      if (p >= band.lo && p < band.hi) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

var slice = [];
function rebuildSlice() {
  slice = [];
  for (var i = 0; i < N; i++) if (passes(i)) slice.push(i);
}

// group the slice by a key function; returns {key: [indices]}
function groupBy(idx, keyFn) {
  var g = {}, k;
  for (var i = 0; i < idx.length; i++) {
    k = keyFn(idx[i]);
    if (k === null || k === undefined) continue;
    (g[k] || (g[k] = [])).push(idx[i]);
  }
  return g;
}

function priceStats(idx) {
  var p = [];
  for (var i = 0; i < idx.length; i++) p.push(C.price[idx[i]]);
  p.sort(function (a, b) { return a - b; });
  return {
    n: p.length,
    p10: quantile(p, 0.10), p25: quantile(p, 0.25), med: quantile(p, 0.5),
    p75: quantile(p, 0.75), p90: quantile(p, 0.90),
    min: p[0], max: p[p.length - 1], total: sum(p)
  };
}

// The four things you can scope to, in the order the type-ahead offers them.
// "village" is the unit you shop in; the other three are the units the charts
// aggregate by, and until now you could rank them but never scope to one.
var AREA_KINDS = [
  { kind: 'settlement', label: 'village' },
  { kind: 'zone',       label: 'settlement zone' },
  { kind: 'pcd',        label: 'postcode district' },
  { kind: 'sector',     label: 'postcode sector' }
];
function areaValue(kind, i) {
  if (kind === 'settlement') return DICT.settlement[C.settlement[i]];
  if (kind === 'zone') return DICT.zone[C.zone[i]];
  if (kind === 'pcd') return DICT.pcd[C.pcd[i]];
  if (kind === 'sector') return DICT.sector[C.sector[i]];
  return null;
}
function areaKindLabel(kind) {
  for (var i = 0; i < AREA_KINDS.length; i++) if (AREA_KINDS[i].kind === kind) return AREA_KINDS[i].label;
  return kind;
}

// Set the scope from a click on the map, a treemap cell or a table row.
function scopeTo(kind, name) {
  if (state.area && state.area.kind === kind && state.area.name === name) state.area = null;
  else state.area = { kind: kind, name: name };
  state.village = '';
  var box = $('fVillage');
  if (box) box.value = state.area ? state.area.name : '';
  // scoping to the unit the chart already groups by would draw a single bar,
  // so step one level finer
  if (state.area) {
    if (state.grain === kind) {
      state.grain = (kind === 'zone' || kind === 'pcd') ? 'settlement'
                  : (kind === 'sector' ? 'settlement' : 'settlement');
    }
    if (kind === 'settlement') state.grain = 'settlement';
  }
  refresh();
}

function keyFor(grain) {
  if (grain === 'district') return function (i) { return DICT.district[C.district[i]]; };
  if (grain === 'pcd') return function (i) { var v = DICT.pcd[C.pcd[i]]; return v === '—' ? null : v; };
  if (grain === 'settlement') return function (i) { return DICT.settlement[C.settlement[i]]; };
  if (grain === 'sector') return function (i) { var v = DICT.sector[C.sector[i]]; return v === '—' ? null : v; };
  return function (i) { return DICT.zone[C.zone[i]]; };
}
function grainNoun(grain, plural) {
  var m = { district: 'district', zone: 'settlement zone', pcd: 'postcode district',
            settlement: 'village', sector: 'postcode sector' };
  return m[grain] + (plural ? 's' : '');
}

// momentum windows: two equal, back-to-back spans ending at the slice's last month
function windows() {
  if (!slice.length) return null;
  var lo = Infinity, hi = -Infinity;
  for (var i = 0; i < slice.length; i++) {
    var m = C.date[slice[i]];
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  var span = hi - lo + 1;
  var w = Math.min(36, Math.floor(span / 2));
  if (w < 6) return null;
  return { w: w, recent0: hi - w + 1, recent1: hi, prior0: hi - 2 * w + 1, prior1: hi - w };
}

// per-area momentum, at the given grain
function momentum(grain) {
  var win = windows();
  if (!win) return { win: null, rows: [], considered: 0 };
  var kf = keyFor(grain);
  var g = groupBy(slice, kf);
  var rows = [], considered = 0;
  Object.keys(g).forEach(function (name) {
    var idx = g[name];
    considered++;
    if (idx.length < minSalesFor(grain)) return;
    var rec = [], pri = [];
    for (var i = 0; i < idx.length; i++) {
      var m = C.date[idx[i]];
      if (m >= win.recent0 && m <= win.recent1) rec.push(idx[i]);
      else if (m >= win.prior0 && m <= win.prior1) pri.push(idx[i]);
    }
    if (rec.length < MIN_WINDOW_SALES || pri.length < MIN_WINDOW_SALES) return;
    var rs = priceStats(rec), ps = priceStats(pri);
    rows.push({
      name: name,
      district: grain === 'district' ? name : dominantDistrict(idx),
      n: idx.length,
      nRecent: rec.length, nPrior: pri.length,
      volChange: (rec.length - pri.length) / pri.length * 100,
      medRecent: rs.med, medPrior: ps.med,
      medChange: (rs.med - ps.med) / ps.med * 100,
      med: priceStats(idx).med
    });
  });
  return { win: win, rows: rows, considered: considered };
}

// Describe the baseline honestly. It is the median of whatever is in view, so
// calling it "the regional median" is false the moment anything is filtered —
// scope to one village and the premium bar reads 0.0% under a caption claiming
// a regional comparison.
function baselineLabel(shortForm) {
  var bits = [];
  if (state.county) bits.push(state.county);
  if (state.district) bits.push(state.district);
  if (state.area) bits.push(state.area.name);
  if (state.village) bits.push('“' + state.village + '”');
  if (state.ptype) bits.push(state.ptype);
  if (state.newBuild === 1) bits.push('new build');
  else if (state.newBuild === -1) bits.push('resale only');
  if (state.search) bits.push('search area');
  if (Object.keys(state.bands).length) bits.push('selected bands');
  if (state.y0 !== BASE_YEAR || state.y1 !== LAST_YEAR) bits.push(state.y0 + '–' + state.y1);

  if (!bits.length) return shortForm ? 'region' : 'the whole region';
  if (shortForm) return 'sales in view';
  return 'the ' + fmtInt(slice.length) + ' sales in view — ' + bits.join(', ');
}
function isUnfiltered() { return baselineLabel(true) === 'region'; }

// Zone names come from the source data and several are opaque or downright
// misleading on their own — "Town" is not a place, it is a category meaning
// "the town this district revolves around", so it reads as Stamford in South
// Kesteven and Oakham in Rutland. Never show a zone name without saying which
// settlements are actually in it.
var ZONE_MAKEUP = {};
function zoneMakeup(zone, district, limit) {
  var key = zone + '|' + (district || '') + '|' + (limit || 3);
  if (ZONE_MAKEUP[key]) return ZONE_MAKEUP[key];
  var counts = {}, total = 0;
  for (var i = 0; i < N; i++) {
    if (DICT.zone[C.zone[i]] !== zone) continue;
    if (district && DICT.district[C.district[i]] !== district) continue;
    var nm = DICT.settlement[C.settlement[i]];
    counts[nm] = (counts[nm] || 0) + 1;
    total++;
  }
  var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  var top = names.slice(0, limit || 3);
  var out = {
    names: names, top: top, total: total,
    // "Stamford, Market Deeping and 12 more"
    text: top.length
      ? top.join(', ') + (names.length > top.length ? ' and ' + (names.length - top.length) + ' more' : '')
      : ''
  };
  ZONE_MAKEUP[key] = out;
  return out;
}
// how many districts a zone spans — a zone in more than one is a classification
// as much as a geography, and the user should be told
function zoneSpread(zone) {
  var ds = {};
  for (var i = 0; i < N; i++) if (DICT.zone[C.zone[i]] === zone) ds[DICT.district[C.district[i]]] = 1;
  return Object.keys(ds);
}

// A ranked list of zone names is close to useless on its own: 32 of the 47 zone
// names never mention any of their own leading settlements, so "Rutland
// Villages", "Cliff Villages" and above all "Town" name nowhere the reader can
// place. Every zone row label carries its settlements.
function areaLabelText(name, grain, maxChars) {
  if (grain !== 'zone') return truncate(name, maxChars);
  var mk = zoneMakeup(name, null, 1);
  if (!mk.text) return truncate(name, maxChars);
  var joined = name + ' · ' + mk.top[0];
  return joined.length <= maxChars ? joined : truncate(name, maxChars);
}

function axisRowLabel(g, xEnd, y, name, grain, widthBudget) {
  var t = s('text', { class: 'lbl', x: xEnd, y: y, 'text-anchor': 'end' });
  var mk = (grain === 'zone') ? zoneMakeup(name, null, 2) : null;
  var makeup = mk && mk.text ? mk.top.join(', ') : '';
  var charW = 5.45;
  var maxChars = Math.max(10, Math.floor(widthBudget / charW));

  if (!makeup || maxChars < name.length + 7) {
    t.appendChild(document.createTextNode(truncate(name, maxChars)));
    g.appendChild(t);
    return t;
  }
  var room = Math.max(4, maxChars - name.length - 3);
  var n1 = s('tspan', { fill: '#a9aeb8' }, name);
  var n2 = s('tspan', { fill: '#737a86' }, ' · ' + truncate(makeup, room));
  t.appendChild(n1);
  t.appendChild(n2);
  g.appendChild(t);
  return t;
}

function dominantDistrict(idx) {
  var c = {}, best = null, bn = 0;
  for (var i = 0; i < idx.length; i++) {
    var d = DICT.district[C.district[idx[i]]];
    c[d] = (c[d] || 0) + 1;
    if (c[d] > bn) { bn = c[d]; best = d; }
  }
  return best;
}

// ------------------------------------------------------------ chart chrome

function mount(id, height) {
  var host = $(id);
  clear(host);
  var w = host.clientWidth || 900;
  var svg = s('svg', { width: w, height: height, viewBox: '0 0 ' + w + ' ' + height,
                       role: 'img' });
  host.appendChild(svg);
  return { svg: svg, w: w, h: height, host: host };
}

function yAxis(g, scale, ticks, x0, x1, fmt) {
  var ax = s('g', { class: 'axis' });
  ticks.forEach(function (t) {
    var y = Math.round(scale(t)) + 0.5;
    ax.appendChild(s('line', { x1: x0, x2: x1, y1: y, y2: y }));
    ax.appendChild(s('text', { x: x0 - 8, y: y + 4, 'text-anchor': 'end' }, fmt(t)));
  });
  g.appendChild(ax);
}

function xLabels(g, items, y) {
  var ax = s('g', { class: 'axis' });
  items.forEach(function (it) {
    ax.appendChild(s('text', { x: it.x, y: y, 'text-anchor': 'middle' }, it.label));
  });
  g.appendChild(ax);
}

// rounded top on a column, square at the baseline
function barPath(x, y, w, h, r) {
  r = Math.min(r === undefined ? 4 : r, w / 2, h);
  if (h <= 0.5) return 'M' + x + ',' + (y + h) + 'h' + w;
  return 'M' + x + ',' + (y + h) +
         'V' + (y + r) +
         'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + -r +
         'h' + (w - 2 * r) +
         'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
         'V' + (y + h) + 'Z';
}
// rounded right end on a horizontal bar growing from x0
function hBarPath(x0, y, w, h, r) {
  var dir = w >= 0 ? 1 : -1, aw = Math.abs(w);
  r = Math.min(r === undefined ? 4 : r, h / 2, aw);
  if (aw <= 0.5) return 'M' + x0 + ',' + y + 'v' + h;
  return 'M' + x0 + ',' + y +
         'h' + dir * (aw - r) +
         'a' + r + ',' + r + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + dir * r + ',' + r +
         'v' + (h - 2 * r) +
         'a' + r + ',' + r + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + -dir * r + ',' + r +
         'H' + x0 + 'Z';
}

function legend(host, items) {
  var box = el('div', 'legend');
  items.forEach(function (it) {
    var i = el('div', 'item');
    var sw = el('span', it.line ? 'line-key' : 'swatch');
    sw.style.background = it.color;
    i.appendChild(sw);
    i.appendChild(document.createTextNode(it.label));
    box.appendChild(i);
  });
  host.appendChild(box);
  return box;
}

function scaleLegend(hostId, stops, fmt, note) {
  var host = $(hostId);
  if (!host) return;
  clear(host);
  var box = el('div', 'scale');
  box.appendChild(el('span', null, fmt(stops[0].lo)));
  var ramp = el('div', 'ramp');
  stops.forEach(function (st) {
    var i = document.createElement('i');
    i.style.background = st.color;
    i.title = fmt(st.lo) + ' – ' + fmt(st.hi);
    ramp.appendChild(i);
  });
  box.appendChild(ramp);
  box.appendChild(el('span', null, fmt(stops[stops.length - 1].hi)));
  if (note) box.appendChild(el('span', null, '· ' + note));
  host.appendChild(box);
}

// quantile bins for skewed magnitudes; returns {bins, colorOf}
function quantileBins(values, ramp, nBins) {
  var v = values.slice().sort(function (a, b) { return a - b; });
  var bins = [];
  for (var i = 0; i < nBins; i++) {
    var lo = quantile(v, i / nBins), hi = quantile(v, (i + 1) / nBins);
    bins.push({ lo: lo, hi: hi, color: rampColor(ramp, nBins === 1 ? 1 : i / (nBins - 1)) });
  }
  // collapse duplicate edges (happens when many areas share a value)
  var out = [bins[0]];
  for (var j = 1; j < bins.length; j++) {
    if (bins[j].hi <= out[out.length - 1].hi) { out[out.length - 1].hi = bins[j].hi; out[out.length - 1].color = bins[j].color; }
    else out.push(bins[j]);
  }
  return {
    bins: out,
    colorOf: function (val) {
      for (var k = 0; k < out.length; k++) if (val <= out[k].hi || k === out.length - 1) return out[k].color;
      return out[out.length - 1].color;
    }
  };
}

function divergingColor(v, maxAbs) {
  if (!isFinite(v) || maxAbs <= 0) return DIV[3];
  var t = Math.max(-1, Math.min(1, v / maxAbs));
  // 7-step diverging with a neutral centre; step, don't interpolate through grey
  if (t <= -0.66) return DIV[0];
  if (t <= -0.33) return DIV[1];
  if (t < -0.05) return DIV[2];
  if (t <= 0.05) return DIV[3];
  if (t < 0.33) return DIV[4];
  if (t < 0.66) return DIV[5];
  return DIV[6];
}

// --------------------------------------------------------------- table twin

function registerTable(id, cols, rows) { TABLES[id] = { cols: cols, rows: rows }; }

// A table of zone names is as unreadable as a chart of them. Where the rows are
// zones, insert what each one covers straight after the name.
function withCovers(grain, cols, rows, nameIndex) {
  if (grain !== 'zone') return { cols: cols, rows: rows };
  var at = (nameIndex || 0) + 1;
  var c2 = cols.slice();
  c2.splice(at, 0, 'Covers');
  var r2 = rows.map(function (r) {
    var out = r.slice();
    var mk = zoneMakeup(String(r[nameIndex || 0]), null, 4);
    out.splice(at, 0, mk.text || '—');
    return out;
  });
  return { cols: c2, rows: r2 };
}

function openTable(btn) {
  var id = btn.dataset.table, t = TABLES[id];
  if (!t) return;
  var wrap = el('div', 'tbl-scroll');
  wrap.id = 'tbl-' + id;
  wrap.style.marginTop = '12px';
  wrap.style.maxHeight = '340px';
  wrap.style.overflowY = 'auto';
  wrap.appendChild(makeTable(t.cols, t.rows));
  btn.parentNode.insertBefore(wrap, btn.nextSibling);
  btn.textContent = 'Hide table';
}

function buildTableTwins() {
  var btns = document.querySelectorAll('.tbl-toggle');
  for (var i = 0; i < btns.length; i++) {
    var btn = btns[i];
    if (!btn.dataset.wired) {
      btn.dataset.wired = '1';
      (function (b) {
        b.addEventListener('click', function () {
          var existing = document.getElementById('tbl-' + b.dataset.table);
          if (existing) { existing.remove(); b.textContent = 'Show table'; return; }
          openTable(b);
        });
      })(btn);
    }
    // An open table lives outside the chart host, so a re-render leaves it
    // untouched and showing the previous slice. Rebuild it from the data the
    // chart was just drawn from, so the two can never disagree.
    var open = document.getElementById('tbl-' + btn.dataset.table);
    if (open) {
      var t = TABLES[btn.dataset.table];
      if (t) {
        clear(open);
        open.appendChild(makeTable(t.cols, t.rows));
      } else {
        open.remove();
        btn.textContent = 'Show table';
      }
    }
  }
}

function makeTable(cols, rows) {
  var tbl = el('table', 'data');
  var thead = el('thead'), tr = el('tr');
  cols.forEach(function (c) { tr.appendChild(el('th', null, c)); });
  thead.appendChild(tr);
  tbl.appendChild(thead);
  var tb = el('tbody');
  rows.forEach(function (r) {
    var row = el('tr');
    r.forEach(function (cell, ci) {
      var td = el('td', ci === 0 ? 'name' : null, cell === null || cell === undefined ? '—' : String(cell));
      row.appendChild(td);
    });
    tb.appendChild(row);
  });
  tbl.appendChild(tb);
  return tbl;
}

// ==========================================================================
// PULSE
// ==========================================================================

function renderPulse() {
  var st = priceStats(slice);

  // hero -----------------------------------------------------------------
  $('heroValue').textContent = fmtInt(st.n);
  var yrs = state.y1 - state.y0 + 1;
  var note = [];
  note.push('sales of £550,000 or more between ' + state.y0 + ' and ' + state.y1 +
            (state.y1 === PARTIAL_YEAR ? ' (to June)' : '') + '.');
  if (st.n) note.push('Together worth ' + fmtCompact(st.total) + '.');
  $('heroNote').textContent = note.join(' ');

  // tiles ----------------------------------------------------------------
  var tiles = $('tiles');
  clear(tiles);
  var byYear = groupBy(slice, function (i) { return yearOf(C.date[i]); });
  var years = [];
  for (var y = state.y0; y <= state.y1; y++) years.push(y);
  var yearCounts = years.map(function (y) { return (byYear[y] || []).length; });
  // the median tile used to draw this same volume series under a price figure —
  // the two correlate at about -0.02, so it implied a trend that did not exist
  var yearMedians = years.map(function (y) {
    var p = (byYear[y] || []).map(function (i) { return C.price[i]; }).sort(function (a, b) { return a - b; });
    return p.length >= 3 ? quantile(p, 0.5) : null;
  });

  var mom = momentum('district');
  var win = mom.win;
  var recentN = 0, priorN = 0, recentP = [], priorP = [];
  if (win) {
    for (var i = 0; i < slice.length; i++) {
      var m = C.date[slice[i]];
      if (m >= win.recent0 && m <= win.recent1) { recentN++; recentP.push(C.price[slice[i]]); }
      else if (m >= win.prior0 && m <= win.prior1) { priorN++; priorP.push(C.price[slice[i]]); }
    }
  }
  recentP.sort(function (a, b) { return a - b; });
  priorP.sort(function (a, b) { return a - b; });

  var detached = 0, newb = 0, millionPlus = 0;
  for (var j = 0; j < slice.length; j++) {
    if (DICT.ptype[C.ptype[slice[j]]] === 'Detached') detached++;
    if (C.flags[slice[j]] & F_NEW) newb++;
    if (C.price[slice[j]] >= 1000000) millionPlus++;
  }

  var winLabel = win ? (win.w + '-month' ) : '';
  addTile(tiles, 'Median sale', fmtCompact(st.med),
    win && priorP.length ? deltaText(median(recentP), median(priorP), true, winLabel) : null, yearMedians, years, 'median');
  addTile(tiles, 'Middle half', st.n ? fmtCompact(st.p25) + ' – ' + fmtCompact(st.p75) : '—',
    { txt: '25th to 75th percentile', dir: 0 }, null, null);
  addTile(tiles, 'Sales per year', st.n ? fmtInt(st.n / Math.max(1, yrs - (state.y1 === PARTIAL_YEAR ? 0.5 : 0))) : '—',
    win && priorN ? deltaText(recentN, priorN, true, winLabel) : null, yearCounts, years, 'count');
  addTile(tiles, '£1m and over', st.n ? (millionPlus / st.n * 100).toFixed(1) + '%' : '—',
    { txt: fmtInt(millionPlus) + ' sales', dir: 0 }, null, null);
  addTile(tiles, 'Detached', st.n ? (detached / st.n * 100).toFixed(0) + '%' : '—',
    { txt: 'of all sales in the slice', dir: 0 }, null, null);
  addTile(tiles, 'New build', st.n ? (newb / st.n * 100).toFixed(1) + '%' : '—',
    { txt: fmtInt(newb) + ' sales', dir: 0 }, null, null);

  // the standfirst carries the live headline so the page never asserts a number
  // that the data no longer supports
  var sf = $('standfirstRsi');
  if (sf && RSI.ok) {
    var lastY = RSI.years[RSI.years.length - 1];
    var f13 = RSI.factor(RSI.base, lastY), f23 = RSI.factor(2023, lastY);
    sf.textContent = fmtPct((f13 - 1) * 100, 0) + ' since ' + RSI.base +
      (f23 !== null ? ', and ' + (Math.abs(f23 - 1) < 0.03 ? 'flat since 2023' :
        fmtPct((f23 - 1) * 100, 0) + ' since 2023') : '');
  }

  drawWave();
  drawIndexChart();
  drawPriceChart();
  drawMovers();
  drawSmallMultiples();
}

function deltaText(now, before, upGood, winLabel) {
  var pct = (now - before) / before * 100;
  return { txt: fmtPct(pct) + ' vs previous ' + winLabel, dir: pct > 0.5 ? 1 : (pct < -0.5 ? -1 : 0), good: upGood };
}

function addTile(host, label, value, delta, sparkVals, sparkYears, sparkKind) {
  var t = el('div', 'tile');
  t.appendChild(el('div', 'label', label));
  t.appendChild(el('div', 'value', value));
  if (delta) {
    var d = el('div', 'delta');
    // warm/cool, matching every chart on the page, rather than the app's only
    // green/red pair pointing the opposite way to the bars beneath it
    if (delta.dir === 1) d.style.color = DIV[5];
    if (delta.dir === -1) d.style.color = DIV[1];
    d.textContent = (delta.dir === 1 ? '▲ ' : delta.dir === -1 ? '▼ ' : '') + delta.txt;
    t.appendChild(d);
  }
  if (sparkVals && sparkVals.length > 1) t.appendChild(sparkline(sparkVals, 150, 26));
  host.appendChild(t);
}

function sparkline(vals, w, h, color) {
  vals = vals.filter(function (v) { return v !== null && v !== undefined && isFinite(v); });
  if (vals.length < 2) return s('svg', { class: 'spark', width: w, height: h });
  var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
  var x = linear(0, vals.length - 1, 1, w - 1), y = linear(min, max === min ? min + 1 : max, h - 2, 2);
  var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join('');
  var svg = s('svg', { class: 'spark', width: w, height: h, viewBox: '0 0 ' + w + ' ' + h }, [
    s('path', { d: d, fill: 'none', stroke: color || MUTED, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    s('circle', { cx: x(vals.length - 1), cy: y(vals[vals.length - 1]), r: 3, fill: color || ACCENT, stroke: SURFACE, 'stroke-width': 2 })
  ]);
  return svg;
}

// ------------------------------------------------------------------- wave

function drawWave() {
  var m = mount('waveChart', 300);
  if (!slice.length) return emptyChart(m);
  var pad = { t: 14, r: 16, b: 34, l: 52 };

  var byQ = {};
  for (var i = 0; i < slice.length; i++) {
    var mo = C.date[slice[i]];
    var q = Math.floor(mo / 3);
    byQ[q] = (byQ[q] || 0) + 1;
  }
  var qs = Object.keys(byQ).map(Number).sort(function (a, b) { return a - b; });
  var q0 = qs[0], q1 = qs[qs.length - 1];
  var series = [];
  for (var q = q0; q <= q1; q++) series.push({ q: q, n: byQ[q] || 0 });

  // 4-quarter trailing mean
  series.forEach(function (d, k) {
    var acc = 0, cnt = 0;
    for (var b = Math.max(0, k - 3); b <= k; b++) { acc += series[b].n; cnt++; }
    d.avg = acc / cnt;
  });

  var maxV = Math.max.apply(null, series.map(function (d) { return d.n; }));
  var x = linear(q0, q1 + 1, pad.l, m.w - pad.r);
  var y = linear(0, maxV * 1.08, m.h - pad.b, pad.t);
  var bw = Math.min(24, (x(q0 + 1) - x(q0)) - 2);

  var g = s('g');
  yAxis(g, y, niceTicks(0, maxV * 1.08, 4), pad.l, m.w - pad.r, fmtInt);

  series.forEach(function (d) {
    var cx = x(d.q) + (x(q0 + 1) - x(q0) - bw) / 2;
    var h = (m.h - pad.b) - y(d.n);
    var qy = BASE_YEAR + Math.floor(d.q / 4);
    var partial = qy === PARTIAL_YEAR;
    var path = s('path', { d: barPath(cx, y(d.n), bw, h, 4), fill: ACCENT, opacity: partial ? 0.45 : 0.85 });
    g.appendChild(path);
    var hit = s('rect', { class: 'hit', x: x(d.q), y: pad.t, width: x(d.q + 1) - x(d.q), height: m.h - pad.b - pad.t, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: 'Q' + (d.q % 4 + 1) + ' ' + qy,
        rows: [
          { k: 'Sales', v: fmtInt(d.n), color: ACCENT },
          { k: '4-quarter average', v: d.avg.toFixed(1), color: ACCENT_UI }
        ],
        foot: partial ? '2026 covers January to June only' : null
      };
    });
    hit.addEventListener('pointerenter', function () { path.setAttribute('opacity', 1); });
    hit.addEventListener('pointerleave', function () { path.setAttribute('opacity', partial ? 0.45 : 0.85); });
    g.appendChild(hit);
  });

  var d = series.map(function (dd, k) {
    var cx = x(dd.q) + (x(q0 + 1) - x(q0)) / 2;
    return (k ? 'L' : 'M') + cx.toFixed(1) + ',' + y(dd.avg).toFixed(1);
  }).join('');
  g.appendChild(s('path', { d: d, fill: 'none', stroke: ACCENT_UI, 'stroke-width': 2, 'stroke-linejoin': 'round' }));

  var ticks = [];
  for (var yy = Math.ceil(state.y0 / 2) * 2; yy <= state.y1; yy += 2) {
    var qq = (yy - BASE_YEAR) * 4;
    if (qq >= q0 && qq <= q1) ticks.push({ x: x(qq + 0.5), label: String(yy) });
  }
  xLabels(g, ticks, m.h - 12);
  m.svg.appendChild(g);

  var lg = legend(m.host, [
    { color: ACCENT, label: 'Sales in the quarter' },
    { color: ACCENT_UI, label: 'Four-quarter rolling average', line: true }
  ]);
  lg.style.marginTop = '10px';

  registerTable('waveChart', ['Quarter', 'Sales', '4-qtr average'],
    series.map(function (dd) {
      return ['Q' + (dd.q % 4 + 1) + ' ' + (BASE_YEAR + Math.floor(dd.q / 4)), fmtInt(dd.n), dd.avg.toFixed(1)];
    }).reverse());
}

function emptyChart(m, why) {
  var t = el('div', 'empty', why || (slice.length
    ? fmtInt(slice.length) + ' sales are in view, but too few areas clear this chart\u2019s sample threshold.'
    : 'No sales match the current filters.'));
  clear(m.host);
  m.host.appendChild(t);
  // drop the table twin too — it must never outlive the chart it mirrors
  delete TABLES[m.host.id];
}

// --------------------------------------------- repeat-sales index vs median

function drawIndexChart() {
  var host = $('indexChart');
  if (!host) return;
  if (!RSI.ok) {
    clear(host);
    host.appendChild(el('div', 'empty', 'Not enough repeat sales to build an index.'));
    return;
  }
  var years = RSI.years.filter(function (y) { return y >= RSI.base; });

  // Both series are region-wide and unfiltered. Mixing a filtered median with an
  // unfiltered index on one axis would compare two different populations.
  var byYear = {};
  for (var i = 0; i < N; i++) {
    var y = yearOf(C.date[i]);
    (byYear[y] || (byYear[y] = [])).push(C.price[i]);
  }
  var obs = {};
  years.forEach(function (y) {
    var p = (byYear[y] || []).slice().sort(function (a, b) { return a - b; });
    obs[y] = p.length ? quantile(p, 0.5) : null;
  });
  var obsBase = obs[RSI.base];
  var obsIdx = {};
  years.forEach(function (y) { obsIdx[y] = obs[y] ? obs[y] / obsBase * 100 : null; });

  var m = mount('indexChart', 340);
  var pad = { t: 18, r: 118, b: 34, l: 50 };

  var lo = 90, hi = 110;
  years.forEach(function (y) {
    var b = RSI.band[y];
    if (b) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); }
    lo = Math.min(lo, RSI.level[y], obsIdx[y] || 100);
    hi = Math.max(hi, RSI.level[y], obsIdx[y] || 100);
  });
  lo = Math.floor(lo / 10) * 10 - 2;
  hi = Math.ceil(hi / 10) * 10 + 2;

  var x = linear(years[0], years[years.length - 1], pad.l, m.w - pad.r);
  var yy = linear(lo, hi, m.h - pad.b, pad.t);
  var g = s('g');

  yAxis(g, yy, niceTicks(lo, hi, 5), pad.l, m.w - pad.r, function (v) { return String(Math.round(v)); });

  // 100 line = the base year
  var y100 = Math.round(yy(100)) + 0.5;
  g.appendChild(s('line', { x1: pad.l, x2: m.w - pad.r, y1: y100, y2: y100, stroke: '#3a4048', 'stroke-width': 1 }));

  // bootstrap band
  var up = [], dn = [];
  years.forEach(function (y) {
    var b = RSI.band[y];
    if (!b) return;
    up.push(x(y).toFixed(1) + ',' + yy(b.hi).toFixed(1));
    dn.unshift(x(y).toFixed(1) + ',' + yy(b.lo).toFixed(1));
  });
  if (up.length) g.appendChild(s('polygon', { points: up.concat(dn).join(' '), fill: ACCENT, opacity: 0.14 }));

  function line(vals, colour, width, dash) {
    var d = '', started = false;
    years.forEach(function (y) {
      if (vals[y] === null || vals[y] === undefined) return;
      d += (started ? 'L' : 'M') + x(y).toFixed(1) + ',' + yy(vals[y]).toFixed(1);
      started = true;
    });
    return s('path', { d: d, fill: 'none', stroke: colour, 'stroke-width': width,
                       'stroke-linejoin': 'round', 'stroke-dasharray': dash || null });
  }
  g.appendChild(line(obsIdx, MUTED, 2));
  g.appendChild(line(RSI.level, ACCENT, 2.5));

  var last = years[years.length - 1];
  [[RSI.level[last], ACCENT, 'Same houses', 650],
   [obsIdx[last], MUTED, 'Observed median', 500]].forEach(function (spec) {
    if (spec[0] === null || spec[0] === undefined) return;
    g.appendChild(s('circle', { cx: x(last), cy: yy(spec[0]), r: 4.5, fill: spec[1], stroke: SURFACE, 'stroke-width': 2 }));
    g.appendChild(s('text', { class: 'val', x: x(last) + 10, y: yy(spec[0]) - 3, fill: '#f4f2ee' },
      Math.round(spec[0]) ));
    g.appendChild(s('text', { class: 'lbl', x: x(last) + 10, y: yy(spec[0]) + 11, 'font-size': 10.5,
      fill: INK3 }, spec[2]));
  });

  // hover: what a comparable from this year is worth now
  years.forEach(function (y) {
    var hw = (m.w - pad.l - pad.r) / years.length;
    var hit = s('rect', { class: 'hit', x: x(y) - hw / 2, y: pad.t, width: hw, height: m.h - pad.b - pad.t, tabindex: 0 });
    bindTip(hit, function () {
      var f = RSI.factor(y, last);
      var rows = [
        { k: 'Same houses', v: Math.round(RSI.level[y]), color: ACCENT },
        { k: 'Observed median', v: obsIdx[y] ? Math.round(obsIdx[y]) : '—', color: MUTED }
      ];
      if (f !== null && y !== last) {
        rows.push({ k: 'A ' + y + ' sale, in today’s terms', v: fmtPct((f - 1) * 100, 1) });
      }
      rows.push({ k: 'Repeat sales informing ' + y, v: fmtInt(RSI.perYear[y]) });
      return {
        title: String(y) + (y === PARTIAL_YEAR ? ' (to June)' : ''),
        rows: rows,
        foot: 'Index set to 100 in ' + RSI.base
      };
    });
    g.appendChild(hit);
  });

  var ticks = yearTicks(years, m.w).map(function (yr) { return { x: x(yr), label: String(yr) }; });
  xLabels(g, ticks, m.h - 12);
  m.svg.appendChild(g);

  var lg = legend(m.host, [
    { color: ACCENT, label: 'The same houses, sold twice (' + fmtInt(RSI.pairs) + ' pairs)', line: true },
    { color: MUTED, label: 'Observed median of whatever sold that year', line: true },
    { color: '#4a3f2a', label: '90% confidence band' }
  ]);
  lg.style.marginTop = '10px';

  // the three readouts that actually matter when pricing a comparable
  var readout = $('rsiReadout');
  if (readout) {
    clear(readout);
    [[2019, 'A 2019 comparable'], [2023, 'A 2023 comparable'], [RSI.base, 'Since ' + RSI.base]].forEach(function (spec) {
      var f = RSI.factor(spec[0], last);
      if (f === null) return;
      var cell = el('div', 'rsi-cell');
      cell.appendChild(el('div', 'k', spec[1]));
      var v = el('div', 'v', fmtPct((f - 1) * 100, 1));
      v.style.color = Math.abs(f - 1) < 0.02 ? 'var(--ink)' : divergingColor((f - 1) * 100, 40);
      cell.appendChild(v);
      var obsF = (obsIdx[spec[0]] && obsIdx[last]) ? obsIdx[last] / obsIdx[spec[0]] : null;
      cell.appendChild(el('div', 'n', obsF ? 'median says ' + fmtPct((obsF - 1) * 100, 1) : ''));
      readout.appendChild(cell);
    });
  }

  registerTable('indexChart',
    ['Year', 'Same houses (index)', '90% band', 'Observed median (index)', 'Observed median', 'Repeat sales'],
    years.map(function (y) {
      var b = RSI.band[y];
      return [String(y) + (y === PARTIAL_YEAR ? ' (part)' : ''),
              RSI.level[y].toFixed(1),
              b ? b.lo.toFixed(1) + '–' + b.hi.toFixed(1) : '—',
              obsIdx[y] ? obsIdx[y].toFixed(1) : '—',
              obs[y] ? fmtMoney(obs[y]) : '—',
              fmtInt(RSI.perYear[y])];
    }));
}

// ------------------------------------------------------------ price by year

function drawPriceChart() {
  var m = mount('priceChart', 280);
  if (!slice.length) return emptyChart(m);
  var pad = { t: 14, r: 46, b: 34, l: 56 };

  var byYear = groupBy(slice, function (i) { return yearOf(C.date[i]); });
  var rows = [];
  for (var y = state.y0; y <= state.y1; y++) {
    var idx = byYear[y];
    if (!idx || idx.length < 3) continue;
    var st = priceStats(idx);
    rows.push({ year: y, med: st.med, p25: st.p25, p75: st.p75, n: st.n });
  }
  if (rows.length < 2) return emptyChart(m);

  var lo = Math.min.apply(null, rows.map(function (r) { return r.p25; }));
  var hi = Math.max.apply(null, rows.map(function (r) { return r.p75; }));
  var x = linear(rows[0].year, rows[rows.length - 1].year, pad.l, m.w - pad.r);
  var y = linear(lo * 0.96, hi * 1.04, m.h - pad.b, pad.t);

  var g = s('g');
  yAxis(g, y, niceTicks(lo * 0.96, hi * 1.04, 4), pad.l, m.w - pad.r, fmtCompact);

  var up = rows.map(function (r) { return x(r.year).toFixed(1) + ',' + y(r.p75).toFixed(1); });
  var dn = rows.slice().reverse().map(function (r) { return x(r.year).toFixed(1) + ',' + y(r.p25).toFixed(1); });
  g.appendChild(s('polygon', { points: up.concat(dn).join(' '), fill: ACCENT, opacity: 0.1 }));

  g.appendChild(s('path', {
    d: rows.map(function (r, i) { return (i ? 'L' : 'M') + x(r.year).toFixed(1) + ',' + y(r.med).toFixed(1); }).join(''),
    fill: 'none', stroke: ACCENT, 'stroke-width': 2, 'stroke-linejoin': 'round'
  }));

  var last = rows[rows.length - 1];
  g.appendChild(s('circle', { cx: x(last.year), cy: y(last.med), r: 4.5, fill: ACCENT, stroke: SURFACE, 'stroke-width': 2 }));
  g.appendChild(s('text', { class: 'val', x: x(last.year) + 9, y: y(last.med) + 4 }, fmtCompact(last.med)));

  rows.forEach(function (r) {
    var hw = (m.w - pad.l - pad.r) / rows.length;
    var hit = s('rect', { class: 'hit', x: x(r.year) - hw / 2, y: pad.t, width: hw, height: m.h - pad.b - pad.t, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: String(r.year) + (r.year === PARTIAL_YEAR ? ' (to June)' : ''),
        rows: [
          { k: 'Median', v: fmtMoney(r.med), color: ACCENT },
          { k: 'Middle half', v: fmtCompact(r.p25) + '–' + fmtCompact(r.p75) },
          { k: 'Sales', v: fmtInt(r.n) }
        ]
      };
    });
    g.appendChild(hit);
  });

  var ticks = yearTicks(rows.map(function (r) { return r.year; }), m.w)
    .map(function (yr) { return { x: x(yr), label: String(yr) }; });
  xLabels(g, ticks, m.h - 12);
  m.svg.appendChild(g);

  var lg = legend(m.host, [
    { color: ACCENT, label: 'Median price', line: true },
    { color: '#4a3f2a', label: 'Middle half of the market' }
  ]);
  lg.style.marginTop = '10px';

  registerTable('priceChart', ['Year', 'Sales', '25th pct', 'Median', '75th pct'],
    rows.map(function (r) { return [r.year + (r.year === PARTIAL_YEAR ? ' (part)' : ''), fmtInt(r.n), fmtMoney(r.p25), fmtMoney(r.med), fmtMoney(r.p75)]; }));
}

// ----------------------------------------------------------------- movers

function drawMovers() {
  var mo = momentum('zone');
  var host = $('moversChart');
  clear(host);
  if (!mo.win || mo.rows.length < 4) {
    $('moversSub').textContent = 'Not enough history in the current slice to compare two equal periods.';
    host.appendChild(el('div', 'empty', 'Widen the year range to see momentum.'));
    registerTable('moversChart', ['Area'], []);
    return;
  }
  var w = mo.win;
  // the region-wide baseline, so a single zone's number is interpretable
  var regRec = 0, regPri = 0;
  for (var ri = 0; ri < slice.length; ri++) {
    var rm = C.date[slice[ri]];
    if (rm >= w.recent0 && rm <= w.recent1) regRec++;
    else if (rm >= w.prior0 && rm <= w.prior1) regPri++;
  }
  var regChange = regPri ? (regRec - regPri) / regPri * 100 : null;
  $('moversSub').textContent =
    'Change in the number of £550k+ sales, ' + monthLabel(w.recent0) + '–' + monthLabel(w.recent1) +
    ' against the ' + w.w + ' months before it, with the counts in brackets. ' +
    (regChange !== null
      ? 'The whole slice went ' + fmtInt(regPri) + ' → ' + fmtInt(regRec) + ' (' + fmtPct(regChange, 0) +
        '), so read every zone against that. '
      : '') +
    'Zones need ' + MOVER_FLOOR_LABEL + ' sales in each window to rank.';

  // A 9 -> 19 zone used to outrank the largest real movement in the region.
  // Require a floor in BOTH windows so the ranking reflects size, not noise.
  var MOVER_FLOOR = MOVER_FLOOR_LABEL;
  var sorted = mo.rows.slice()
    .filter(function (r) { return Math.min(r.nRecent, r.nPrior) >= MOVER_FLOOR; })
    .sort(function (a, b) { return b.volChange - a.volChange; });
  if (sorted.length < 6) sorted = mo.rows.slice().sort(function (a, b) { return b.volChange - a.volChange; });
  var top = sorted.slice(0, 6);
  var bot = sorted.slice(-6).reverse();
  var rows = top.concat(bot).filter(function (r, i, arr) {
    return arr.findIndex(function (x) { return x.name === r.name; }) === i;
  });

  var m = mount('moversChart', Math.max(200, rows.length * 26 + 40));
  var pad = { t: 8, r: 60, b: 24, l: Math.max(140, Math.min(300, Math.round(m.w * 0.36))) };
  var maxAbs = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.volChange); }));
  var x = linear(-maxAbs, maxAbs, pad.l, m.w - pad.r);
  var rowH = (m.h - pad.t - pad.b) / rows.length;
  var bh = Math.min(16, rowH - 6);

  var g = s('g');
  g.appendChild(s('line', { x1: x(0), x2: x(0), y1: pad.t, y2: m.h - pad.b, stroke: '#2c313a', 'stroke-width': 1 }));

  rows.forEach(function (r, i) {
    var yy = pad.t + i * rowH + (rowH - bh) / 2;
    var col = divergingColor(r.volChange, maxAbs);
    var xw = x(r.volChange) - x(0);
    g.appendChild(s('path', { d: hBarPath(x(0), yy, xw, bh, 4), fill: col }));
    axisRowLabel(g, pad.l - 12, yy + bh - 3, r.name, 'zone', pad.l - 24);
    g.appendChild(s('text', {
      class: 'val', x: x(r.volChange) + (xw >= 0 ? 7 : -7), y: yy + bh - 3,
      'text-anchor': xw >= 0 ? 'start' : 'end'
    }, fmtPct(r.volChange, 0) + '  (' + r.nPrior + '→' + r.nRecent + ')'));

    // full-width hit area — the label gutter is now sized to the chart, so a
    // hardcoded offset would leave part of the row dead
    var hit = s('rect', { class: 'hit', x: 0, y: pad.t + i * rowH, width: m.w, height: rowH, tabindex: 0 });
    bindTip(hit, function () {
      var mk = zoneMakeup(r.name, null, 3);
      return {
        title: r.name + (mk.text ? ' — ' + mk.top.slice(0, 2).join(', ') : ''),
        rows: [
          { k: 'Sales, latest ' + w.w + ' months', v: fmtInt(r.nRecent), color: col },
          { k: 'Sales, previous ' + w.w + ' months', v: fmtInt(r.nPrior) },
          { k: 'Change', v: fmtPct(r.volChange, 0) },
          { k: 'Median now', v: fmtCompact(r.medRecent) }
        ],
        foot: r.district
      };
    });
    g.appendChild(hit);
  });
  m.svg.appendChild(g);

  var movTbl = withCovers('zone',
    ['Settlement zone', 'District', 'Sales now', 'Sales before', 'Volume change', 'Median now'],
    sorted.map(function (r) {
      return [r.name, r.district, fmtInt(r.nRecent), fmtInt(r.nPrior), fmtPct(r.volChange, 0), fmtCompact(r.medRecent)];
    }));
  registerTable('moversChart', movTbl.cols, movTbl.rows);
}

function truncate(str, n) { return str.length > n ? str.slice(0, n - 1) + '…' : str; }

// -------------------------------------------------------- small multiples

function drawSmallMultiples() {
  var host = $('smallMultiples');
  clear(host);
  var byD = groupBy(slice, function (i) { return DICT.district[C.district[i]]; });
  var names = DICT.district.slice().filter(function (n) { return byD[n]; });
  names.sort(function (a, b) { return byD[b].length - byD[a].length; });

  var title = $('smTitle');
  if (title) {
    var words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
    title.textContent = names.length === 1
      ? names[0] + ' on its own'
      : (words[names.length] || names.length) + ' districts' +
        (state.county ? ' in ' + state.county : '') + ', one story each';
  }
  if (!names.length) { host.appendChild(el('div', 'empty', 'No sales match the current filters.')); return; }

  var grid = el('div', 'grid g-4');
  var years = [];
  for (var y = state.y0; y <= state.y1; y++) years.push(y);

  names.forEach(function (name) {
    var idx = byD[name];
    var counts = {};
    for (var i = 0; i < idx.length; i++) counts[yearOf(C.date[idx[i]])] = (counts[yearOf(C.date[idx[i]])] || 0) + 1;
    var vals = years.map(function (y) { return counts[y] || 0; });
    var max = Math.max.apply(null, vals) || 1;
    var peakYear = years[vals.indexOf(max)];

    var cell = el('div');
    cell.style.padding = '2px 0 6px';
    var head = el('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.alignItems = 'baseline';
    head.style.marginBottom = '6px';
    var nm = el('div', null, name);
    nm.style.fontSize = '12.5px'; nm.style.fontWeight = '650';
    var ct = el('div', null, fmtInt(idx.length));
    ct.style.fontSize = '11.5px'; ct.style.color = 'var(--ink-3)'; ct.style.fontVariantNumeric = 'tabular-nums';
    head.appendChild(nm); head.appendChild(ct);
    cell.appendChild(head);

    var W = 200, H = 62, pb = 14;
    var x = linear(0, vals.length - 1, 2, W - 2);
    var yy = linear(0, max, H - pb, 4);
    var line = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + yy(v).toFixed(1); }).join('');
    var area = line + 'L' + x(vals.length - 1).toFixed(1) + ',' + (H - pb) + 'L' + x(0).toFixed(1) + ',' + (H - pb) + 'Z';

    var svg = s('svg', { width: '100%', height: H, viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' }, [
      s('line', { x1: 0, x2: W, y1: H - pb + 0.5, y2: H - pb + 0.5, stroke: '#2c313a', 'stroke-width': 1 }),
      s('path', { d: area, fill: ACCENT, opacity: 0.12 }),
      s('path', { d: line, fill: 'none', stroke: ACCENT, 'stroke-width': 2, 'stroke-linejoin': 'round', vectorEffect: 'non-scaling-stroke' }),
      // the final year is part-year; drawing it as a real slope reads as a crash
      (years[years.length - 1] === PARTIAL_YEAR && vals.length > 1
        ? s('line', { x1: x(vals.length - 2), y1: yy(vals[vals.length - 2]),
                      x2: x(vals.length - 1), y2: yy(vals[vals.length - 1]),
                      stroke: SURFACE, 'stroke-width': 3, opacity: 0.55,
                      vectorEffect: 'non-scaling-stroke' })
        : null),
      s('circle', { cx: x(vals.indexOf(max)), cy: yy(max), r: 3.5, fill: ACCENT_UI, stroke: SURFACE, 'stroke-width': 2 })
    ]);
    cell.appendChild(svg);

    var foot = el('div');
    foot.style.display = 'flex'; foot.style.justifyContent = 'space-between';
    foot.style.fontSize = '10.5px'; foot.style.color = 'var(--ink-3)';
    foot.style.fontVariantNumeric = 'tabular-nums'; foot.style.marginTop = '2px';
    foot.appendChild(el('span', null, String(years[0])));
    foot.appendChild(el('span', null, 'peak ' + peakYear + ' · ' + max));
    foot.appendChild(el('span', null, String(years[years.length - 1])));
    cell.appendChild(foot);

    cell.tabIndex = 0;
    bindTip(cell, function () {
      var st = priceStats(idx);
      return {
        title: name,
        rows: [
          { k: 'Sales in slice', v: fmtInt(idx.length), color: ACCENT },
          { k: 'Median', v: fmtMoney(st.med) },
          { k: 'Busiest year', v: peakYear + ' (' + max + ')' }
        ]
      };
    });
    grid.appendChild(cell);
  });
  host.appendChild(grid);
}

// ==========================================================================
// MAP
// ==========================================================================

var MAP_METRICS = [
  { key: 'volume',   label: 'Sales',        kind: 'seq' },
  { key: 'median',   label: 'Median price', kind: 'seq' },
  { key: 'momentum', label: 'Momentum',     kind: 'div' },
  { key: 'premium',  label: 'Premium',      kind: 'div' }
];

var proj = null;

// bounds of every shape, in equirectangular units corrected for latitude
var MAPB = (function () {
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  Object.keys(D.shapes).forEach(function (code) {
    D.shapes[code].forEach(function (ring) {
      ring.forEach(function (pt) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      });
    });
  });
  var kx = Math.cos(((minY + maxY) / 2) * Math.PI / 180);
  var sw = (maxX - minX) * kx, sh = maxY - minY;
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, kx: kx, sw: sw, sh: sh, aspect: sw / sh };
})();

function buildProjection(w, h) {
  var scale = Math.min(w / MAPB.sw, h / MAPB.sh) * 0.98;
  var ox = (w - MAPB.sw * scale) / 2 - MAPB.minX * MAPB.kx * scale;
  var oy = (h - MAPB.sh * scale) / 2 + MAPB.maxY * scale;
  return {
    px: function (lon) { return lon * MAPB.kx * scale + ox; },
    py: function (lat) { return oy - lat * scale; }
  };
}

function mapValues() {
  var g = groupBy(slice, function (i) { var v = DICT.pcd[C.pcd[i]]; return v === '—' ? null : v; });
  var regionMed = priceStats(slice).med;
  var mom = {};
  var win = windows();
  var out = {};
  Object.keys(g).forEach(function (code) {
    if (!D.shapes[code]) return;
    var idx = g[code];
    var st = priceStats(idx);
    var rec = 0, pri = 0;
    if (win) {
      for (var i = 0; i < idx.length; i++) {
        var m = C.date[idx[i]];
        if (m >= win.recent0 && m <= win.recent1) rec++;
        else if (m >= win.prior0 && m <= win.prior1) pri++;
      }
    }
    out[code] = {
      code: code,
      district: D.pcdOwner[code] || dominantDistrict(idx),
      n: idx.length,
      med: st.med, p25: st.p25, p75: st.p75,
      nRecent: rec, nPrior: pri,
      momentum: (win && pri >= MIN_WINDOW_SALES && rec + pri >= 12) ? (rec - pri) / pri * 100 : null,
      premium: regionMed ? (st.med - regionMed) / regionMed * 100 : null,
      idx: idx
    };
  });
  return { areas: out, regionMed: regionMed, win: win };
}

function renderMap() {
  // metric chips
  var chipHost = $('mapMetric');
  clear(chipHost);
  MAP_METRICS.forEach(function (mm) {
    var b = el('button', 'chip', mm.label);
    b.setAttribute('aria-pressed', state.mapMetric === mm.key ? 'true' : 'false');
    b.addEventListener('click', function () { state.mapMetric = mm.key; writeUrlState(); renderMap(); });
    chipHost.appendChild(b);
  });

  var mv = mapValues();
  var codes = Object.keys(mv.areas);
  var metric = state.mapMetric;
  // the map highlights whatever postcode district the app is scoped to
  var mapScoped = (state.area && state.area.kind === 'pcd') ? state.area.name : null;

  var subs = {
    volume: 'Number of £550k+ sales recorded in each postcode district. Size of market, not price.',
    median: 'Median £550k+ sale price in each postcode district — a read on how deep the top end goes.',
    momentum: mv.win
      ? 'Change in sales count, ' + monthLabel(mv.win.recent0) + '–' + monthLabel(mv.win.recent1) +
        ' against the ' + mv.win.w + ' months before. Grey areas have too few sales to judge.'
      : 'Not enough history in this slice to measure momentum.',
    premium: 'Each area\'s median against the ' + (isUnfiltered() ? 'regional median' : 'median of ' + baselineLabel(false)) +
             ' (' + fmtCompact(mv.regionMed) + '). Warm is dearer than that baseline, cool is cheaper.'
  };
  // caption is written after the scale block below, once `thin` is known

  // size the canvas to the region's own aspect so the map fills its column
  var availW = $('mapChart').clientWidth || 800;
  var mapH = Math.max(420, Math.min(780, Math.round(availW / MAPB.aspect)));
  var m = mount('mapChart', mapH);
  if (!codes.length) { emptyChart(m); clear($('mapRank')); return; }
  proj = buildProjection(m.w, mapH);

  // --- scale
  // A single sale used to set the whole scale: PE11 (n=1, £1,050,000) was rank
  // one by median, and its 59% premium made four of seven diverging steps
  // unreachable when the real spread among solid areas is about ±11%.
  var MAP_MIN = MIN_AREA_SALES;
  var solid = codes.filter(function (c) { return mv.areas[c].n >= MAP_MIN; });
  var thin = codes.length - solid.length;

  var valOf, colorOf, fmtV, stops;
  if (metric === 'volume' || metric === 'median') {
    valOf = function (a) { return metric === 'volume' ? a.n : a.med; };
    var vals = (metric === 'volume' ? codes : solid).map(function (c) { return valOf(mv.areas[c]); });
    var qb = quantileBins(vals, SEQ.slice(1), 6);
    colorOf = qb.colorOf;
    stops = qb.bins;
    fmtV = metric === 'volume' ? fmtInt : fmtCompact;
    scaleLegend('mapScale', stops, function (v) { return fmtV(v); }, 'six equal-sized groups of areas');
  } else {
    valOf = function (a) { return a[metric]; };
    var dv = solid.map(function (c) { return valOf(mv.areas[c]); }).filter(function (v) { return v !== null && isFinite(v); });
    var maxAbs = dv.length ? Math.max.apply(null, dv.map(Math.abs)) : 1;
    maxAbs = Math.max(maxAbs, 5);
    colorOf = function (v) { return v === null ? '#22262d' : divergingColor(v, maxAbs); };
    fmtV = function (v) { return fmtPct(v, 0); };
    stops = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1].map(function (t, i) {
      return { lo: t * maxAbs, hi: t * maxAbs, color: DIV[i] };
    });
    var sl = $('mapScale');
    clear(sl);
    var box = el('div', 'scale');
    box.appendChild(el('span', null, fmtPct(-maxAbs, 0)));
    var ramp = el('div', 'ramp');
    DIV.forEach(function (c) { var i2 = document.createElement('i'); i2.style.background = c; ramp.appendChild(i2); });
    box.appendChild(ramp);
    box.appendChild(el('span', null, fmtPct(maxAbs, 0)));
    box.appendChild(el('span', null, '· grey = no reading'));
    sl.appendChild(box);
  }

  $('mapSub').textContent = subs[metric] +
    (metric !== 'volume' && thin
      ? ' ' + thin + ' area' + (thin === 1 ? '' : 's') + ' with fewer than ' + MAP_MIN +
        ' sales are left grey — one sale cannot set a median.'
      : '');

  // --- shapes
  var g = s('g');
  var byArea = {};
  codes.sort(function (a, b) { return mv.areas[b].n - mv.areas[a].n; });

  Object.keys(D.shapes).forEach(function (code) {
    var a = mv.areas[code];
    var d = D.shapes[code].map(function (ring) {
      return ring.map(function (pt, i) {
        return (i ? 'L' : 'M') + proj.px(pt[0]).toFixed(1) + ',' + proj.py(pt[1]).toFixed(1);
      }).join('') + 'Z';
    }).join('');

    var tooThin = a && metric !== 'volume' && a.n < MAP_MIN;
    var fill = !a ? '#191d23' : (tooThin ? '#22262d' : colorOf(valOf(a)));
    var path = s('path', { class: 'map-shape', d: d, fill: fill, tabindex: a ? 0 : null });
    if (a) {
      byArea[code] = path;
      bindTip(path, function () {
        var rows = [
          { k: 'Sales', v: fmtInt(a.n), color: fill },
          { k: 'Median', v: fmtMoney(a.med) },
          { k: 'Middle half', v: fmtCompact(a.p25) + '–' + fmtCompact(a.p75) }
        ];
        if (a.momentum !== null) rows.push({ k: 'Momentum', v: fmtPct(a.momentum, 0) });
        if (a.premium !== null) rows.push({ k: 'vs ' + baselineLabel(true), v: fmtPct(a.premium, 0) });
        return { title: code + ' · ' + a.district, rows: rows,
                 foot: (state.area && state.area.name === code) ? 'Click to clear this scope'
                                                                  : 'Click to scope everything to ' + code };
      });
      path.addEventListener('pointerenter', function () { highlightArea(code, true); });
      path.addEventListener('pointerleave', function () { highlightArea(null, true); });
      path.addEventListener('click', function () { scopeTo('pcd', code); });
      if (mapScoped === code) path.classList.add('sel');
      else if (mapScoped) path.classList.add('dim');
    } else {
      path.style.cursor = 'default';
    }
    g.appendChild(path);
  });

  // Label priority, since all three kinds compete for the same canvas: the
  // cities and market towns you navigate by come first — they are exactly the
  // places the busiest postcode districts surround, so letting codes go first
  // loses Nottingham, Stamford and Oakham. Then the codes, then the fringe
  // towns that frame the edges of the map.
  var canPlace = labelPlacer(46, 15);

  function placeCode(code) {
    var rings = D.shapes[code];
    if (!rings) return;
    var big = rings[0], cx = 0, cy = 0, bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (var i = 0; i < big.length; i++) {
      var px = proj.px(big[i][0]), py = proj.py(big[i][1]);
      cx += px; cy += py;
      if (px < bx0) bx0 = px;
      if (px > bx1) bx1 = px;
      if (py < by0) by0 = py;
      if (py > by1) by1 = py;
    }
    cx /= big.length; cy /= big.length;
    if (bx1 - bx0 < 26 || by1 - by0 < 18) return;      // too small to hold a label
    if (!canPlace(cx, cy, 40, 14)) return;
    g.appendChild(s('text', { class: 'map-label', x: cx, y: cy, 'text-anchor': 'middle' }, code));
  }

  drawPlaces(g, canPlace, 1, 2);
  codes.slice(0, 26).forEach(placeCode);
  drawPlaces(g, canPlace, 3, 9);
  m.svg.appendChild(g);
  mapPaths = byArea;

  // --- ranked list
  var rankHost = $('mapRank');
  clear(rankHost);
  var metricLabel = MAP_METRICS.filter(function (x) { return x.key === metric; })[0].label;
  $('rankTitle').textContent = 'Postcode districts by ' + metricLabel.toLowerCase();

  var ranked = (metric === 'volume' ? codes : solid).filter(function (c) { return valOf(mv.areas[c]) !== null; })
    .sort(function (a, b) { return valOf(mv.areas[b]) - valOf(mv.areas[a]); })
    .slice(0, 18);

  ranked.forEach(function (code, i) {
    var a = mv.areas[code];
    var row = el('div', 'rank-row');
    row.tabIndex = 0;
    if (mapScoped === code) row.classList.add('hi');
    row.appendChild(el('div', 'n', String(i + 1)));
    var nm = el('div', 'nm', code);
    nm.appendChild(el('small', null, a.district + ' · ' + fmtInt(a.n) + ' sales'));
    row.appendChild(nm);
    // the value stays in ink; a swatch beside it carries the colour encoding
    var vv = el('div', 'vv');
    var sw = el('span');
    sw.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px;background:' + colorOf(valOf(a));
    vv.appendChild(sw);
    vv.appendChild(document.createTextNode(fmtV(valOf(a))));
    row.appendChild(vv);
    row.addEventListener('pointerenter', function () { highlightArea(code, false); row.classList.add('hi'); });
    row.addEventListener('pointerleave', function () { highlightArea(null, false); if (state.mapSel !== code) row.classList.remove('hi'); });
    row.addEventListener('click', function () { scopeTo('pcd', code); });
    rankHost.appendChild(row);
  });

  registerTable('mapChart',
    ['Postcode district', 'District', 'Sales', 'Median', 'Middle half', 'Momentum', 'vs ' + baselineLabel(true)],
    codes.map(function (c) {
      var a = mv.areas[c];
      return [c, a.district, fmtInt(a.n), fmtMoney(a.med),
              fmtCompact(a.p25) + '–' + fmtCompact(a.p75),
              a.momentum === null ? '—' : fmtPct(a.momentum, 0),
              a.premium === null ? '—' : fmtPct(a.premium, 0)];
    }));

  drawTreemap();
}

// Towns and cities, drawn as chrome rather than data: neutral ink, no fill from
// any scale, and transparent to the pointer so they never block a shape's hover.
function drawPlaces(g, canPlace, minRank, maxRank) {
  var places = (D.places || []).filter(function (p) { return p.r >= minRank && p.r <= maxRank; })
    .sort(function (a, b) { return a.r - b.r; });
  var layer = s('g', { class: 'places', 'pointer-events': 'none' });

  places.forEach(function (p) {
    var cx = proj.px(p.lon), cy = proj.py(p.lat);
    var city = p.t === 'city';
    var r = city ? 3.4 : 2.4;
    var fs = city ? 12 : 11;
    var w = p.n.length * fs * 0.55 + 12;          // rough advance width
    var gap = r + 5;

    // An unlabelled dot on a choropleth just reads as noise, so the marker only
    // goes down when its name fits too.
    if (!canPlace(cx + gap + w / 2, cy, w, 15)) return;

    // dark ring first, so the dot stays legible over a bright fill
    layer.appendChild(s('circle', { cx: cx, cy: cy, r: r + 1.7, fill: 'rgba(11,13,16,0.6)' }));
    layer.appendChild(s('circle', { cx: cx, cy: cy, r: r, fill: '#f4f2ee' }));
    layer.appendChild(s('text', {
      class: 'place-label' + (city ? ' place-city' : ''),
      x: cx + gap, y: cy + 3.8
    }, p.n));
  });
  g.appendChild(layer);
}

var mapPaths = {};
function highlightArea(code, fromMap) {
  Object.keys(mapPaths).forEach(function (c) {
    var p = mapPaths[c];
    if (!code) { p.style.filter = ''; p.style.opacity = ''; return; }
    if (c === code) { p.style.filter = 'brightness(1.35)'; p.style.opacity = '1'; }
    else { p.style.opacity = '0.5'; p.style.filter = ''; }
  });
  if (!fromMap) return;
}

// ---------------------------------------------------------------- treemap

function squarify(items, x, y, w, h) {
  // items: [{value}] pre-sorted descending. Returns items with rect fields.
  var out = [];
  var total = sum(items.map(function (d) { return d.value; }));
  if (!total || w <= 0 || h <= 0) return out;
  var scale = (w * h) / total;
  var rest = items.slice();
  var cx = x, cy = y, cw = w, ch = h;

  function worst(row, side) {
    var s0 = sum(row.map(function (d) { return d.value * scale; }));
    var mx = Math.max.apply(null, row.map(function (d) { return d.value * scale; }));
    var mn = Math.min.apply(null, row.map(function (d) { return d.value * scale; }));
    return Math.max(side * side * mx / (s0 * s0), (s0 * s0) / (side * side * mn));
  }

  while (rest.length) {
    var side = Math.min(cw, ch);
    var row = [rest.shift()];
    while (rest.length && worst(row.concat([rest[0]]), side) <= worst(row, side)) row.push(rest.shift());
    var rowSum = sum(row.map(function (d) { return d.value * scale; }));
    if (cw >= ch) {
      var rw = rowSum / ch, oy = cy;
      row.forEach(function (d) {
        var rh = (d.value * scale) / rw;
        out.push({ item: d, x: cx, y: oy, w: rw, h: rh });
        oy += rh;
      });
      cx += rw; cw -= rw;
    } else {
      var rh2 = rowSum / cw, ox = cx;
      row.forEach(function (d) {
        var rw2 = (d.value * scale) / rh2;
        out.push({ item: d, x: ox, y: cy, w: rw2, h: rh2 });
        ox += rw2;
      });
      cy += rh2; ch -= rh2;
    }
  }
  return out;
}

function drawTreemap() {
  var m = mount('treemap', 480);
  if (!slice.length) return emptyChart(m);

  var byD = groupBy(slice, function (i) { return DICT.district[C.district[i]]; });
  var districts = Object.keys(byD).map(function (name) {
    return { name: name, value: byD[name].length, idx: byD[name] };
  }).sort(function (a, b) { return b.value - a.value; });

  // Colour carries the share of sales at £1m+ rather than the median: across
  // settlement zones the medians sit inside a £570k–£750k band, so a quantile
  // ramp on them would dramatise £3k differences. Prime share spreads properly.
  var maxPrime = 0;
  districts.forEach(function (d) {
    var zg = groupBy(d.idx, function (i) { return DICT.zone[C.zone[i]]; });
    d.zones = Object.keys(zg).map(function (z) {
      var st = priceStats(zg[z]);
      var prime = shareAbove(zg[z], 1000000) * 100;
      if (prime > maxPrime) maxPrime = prime;
      return { name: z, value: zg[z].length, med: st.med, prime: prime, stats: st };
    }).sort(function (a, b) { return b.value - a.value; });
  });
  maxPrime = Math.max(maxPrime, 5);

  var ramp6 = SEQ.slice(1);
  var bins = [];
  for (var bi = 0; bi < 6; bi++) {
    bins.push({ lo: maxPrime * bi / 6, hi: maxPrime * (bi + 1) / 6, color: ramp6[bi] });
  }
  var qb = {
    bins: bins,
    colorOf: function (v) {
      var k = Math.min(5, Math.floor(v / maxPrime * 6));
      return ramp6[k < 0 ? 0 : k];
    }
  };
  scaleLegend('treeScale', bins, function (v) { return Math.round(v) + '%'; },
              'block colour = share of sales at £1m and over');

  var g = s('g');
  var cells = squarify(districts, 0, 0, m.w, m.h);
  var HEAD = 20;

  cells.forEach(function (c) {
    var d = c.item;
    g.appendChild(s('rect', { x: c.x, y: c.y, width: Math.max(0, c.w - 2), height: Math.max(0, c.h - 2), fill: '#1a1e25', rx: 4 }));
    if (c.w > 70 && c.h > 34) {
      var cnt = fmtInt(d.value);
      var cntW = cnt.length * 6 + 14;
      // the count only goes in when it will not run into the district name
      var nameRoom = c.w - 16 - (c.w > d.name.length * 7 + cntW ? cntW : 0);
      g.appendChild(s('text', { class: 'lbl-strong', x: c.x + 8, y: c.y + 14 }, truncate(d.name, Math.floor(nameRoom / 6.9))));
      if (c.w > d.name.length * 7 + cntW) {
        g.appendChild(s('text', { class: 'lbl', x: c.x + c.w - 10, y: c.y + 14, 'text-anchor': 'end', 'font-size': 10.5 }, cnt));
      }
    }
    var inner = squarify(d.zones, c.x + 3, c.y + HEAD, Math.max(0, c.w - 8), Math.max(0, c.h - HEAD - 5));
    inner.forEach(function (z) {
      var col = qb.colorOf(z.item.prime);
      var rect = s('rect', {
        x: z.x, y: z.y, width: Math.max(0, z.w - 2), height: Math.max(0, z.h - 2),
        fill: col, rx: 2, tabindex: 0, style: 'cursor:pointer'
      });
      bindTip(rect, function () {
        var mk = zoneMakeup(z.item.name, d.name, 5);
        return {
          title: z.item.name + (mk.text ? ' — ' + mk.top.slice(0, 2).join(', ') : ''),
          rows: [
            { k: 'Sales', v: fmtInt(z.item.value), color: col },
            { k: 'At £1m and over', v: z.item.prime.toFixed(1) + '%' },
            { k: 'Median', v: fmtMoney(z.item.med) },
            { k: 'Middle half', v: fmtCompact(z.item.stats.p25) + '–' + fmtCompact(z.item.stats.p75) },
            { k: 'Dearest sale', v: fmtCompact(z.item.stats.max) }
          ],
          foot: d.name + (mk.text ? ' · covers ' + mk.text : '')
        };
      });
      rect.addEventListener('click', function () { scopeTo('zone', z.item.name); });
      rect.addEventListener('pointerenter', function () { rect.setAttribute('stroke', '#f4f2ee'); rect.setAttribute('stroke-width', 1.5); });
      rect.addEventListener('pointerleave', function () { rect.removeAttribute('stroke'); });
      g.appendChild(rect);
      if (z.w > 62 && z.h > 22) {
        var ink = inkOn(col);
        // A zone name alone is not a place. Give it a second line where the tile
        // is tall enough, fold it onto one line where it is not, and only fall
        // back to the bare name when neither fits — the tooltip still has it.
        var mk = zoneMakeup(z.item.name, d.name, 3);
        var wideRoom = Math.floor((z.w - 8) / 5.6);
        var twoLine = z.h > 38 && mk.text;
        var inline = !twoLine && mk.text &&
                     (z.item.name.length + mk.top[0].length + 3) <= wideRoom;
        g.appendChild(s('text', {
          x: z.x + 5, y: z.y + 14, 'font-size': 10, 'font-weight': 600,
          fill: ink, 'pointer-events': 'none'
        }, truncate(inline ? z.item.name + ' · ' + mk.top[0] : z.item.name, wideRoom)));
        if (twoLine) {
          var room = Math.floor((z.w - 8) / 5.0);
          if (room > 8) {
            g.appendChild(s('text', {
              x: z.x + 5, y: z.y + 26, 'font-size': 9, 'font-weight': 400,
              fill: ink, opacity: 0.72, 'pointer-events': 'none'
            }, truncate(mk.top.join(', '), room)));
          }
        }
      }
    });
  });
  m.svg.appendChild(g);

  var rows = [];
  districts.forEach(function (d) {
    d.zones.forEach(function (z) {
      rows.push([z.name, d.name, fmtInt(z.value), z.prime.toFixed(1) + '%', fmtMoney(z.med),
                 fmtCompact(z.stats.p25) + '–' + fmtCompact(z.stats.p75), fmtCompact(z.stats.max)]);
    });
  });
  var treeTbl = withCovers('zone',
    ['Settlement zone', 'District', 'Sales', '£1m+ share', 'Median', 'Middle half', 'Dearest'], rows);
  registerTable('treemap', treeTbl.cols, treeTbl.rows);
}

// ==========================================================================
// MOMENTUM
// ==========================================================================

var GRAINS = [['zone', 'Settlement zones'], ['district', 'Districts'],
              ['pcd', 'Postcode districts'], ['sector', 'Postcode sectors'], ['settlement', 'Villages']];

// Build the grain control once per card and update it in place on every later
// render. It lives in the card head, which is NOT cleared between renders, so
// re-appending it stacked up a fresh row of chips on every grain click and
// every filter change.
function mountGrainControl(head, onChange) {
  var box = head.querySelector('.grain-control');
  if (!box) {
    box = el('div', 'chip-row grain-control');
    box.style.marginTop = '10px';
    GRAINS.forEach(function (g) {
      var b = el('button', 'chip', g[1]);
      b.dataset.grain = g[0];
      b.addEventListener('click', function () {
        if (state.grain === g[0]) return;
        state.grain = g[0];
        writeUrlState();
        onChange();
      });
      box.appendChild(b);
    });
    var lbl = el('span', 'ctl-label', 'Detail');
    lbl.style.cssText = 'align-self:center;margin-right:2px';
    box.insertBefore(lbl, box.firstChild);
    bindHelp(lbl, 'grain');
    head.appendChild(box);
  }
  var chips = box.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    if (!chips[i].dataset.grain) continue;
    chips[i].setAttribute('aria-pressed', chips[i].dataset.grain === state.grain ? 'true' : 'false');
  }
  return box;
}

function renderMomentum() {
  var mo = momentum(state.grain);
  var sub = $('scatterSub');
  clear(sub);
  if (!mo.win) {
    sub.textContent = 'Widen the year range — momentum needs two equal periods of at least six months each.';
    clear($('scatter')); clear($('moversTable'));
    $('scatter').appendChild(el('div', 'empty', 'Not enough history in this slice.'));
    $('moversTable').appendChild(el('div', 'empty', 'Momentum needs a longer year range than the one selected.'));
    mountGrainControl(sub.parentNode, renderMomentum);
    drawBump();
    return;
  }
  var w = mo.win;
  sub.appendChild(document.createTextNode(
    'Each bubble is one ' + grainNoun(state.grain) + ', placed by how busy it has become (across) and ' +
    'what it costs (up). Bubble size is sales in the last ' + w.w + ' months, ' +
    monthLabel(w.recent0) + '–' + monthLabel(w.recent1) + '; right of centre means busier than the ' + w.w +
    ' months before. Click a bubble to scope the whole app to it. An area needs ' + minSalesFor(state.grain) +
    ' sales in the slice and ' + MIN_WINDOW_SALES + ' in each window to appear — ' +
    fmtInt(mo.rows.length) + ' of ' + fmtInt(mo.considered) + ' qualify.'));
  mountGrainControl(sub.parentNode, renderMomentum);

  drawScatter(mo);
  drawMoversTable(mo);
  drawBump();
}

function drawScatter(mo) {
  var m = mount('scatter', 480);
  var rows = mo.rows;
  if (rows.length < 3) return emptyChart(m, fmtInt(slice.length) + ' sales in view. ' +
    rows.length + ' of ' + mo.considered + ' ' + grainNoun(state.grain, true) +
    ' clear ' + minSalesFor(state.grain) + ' sales with ' + MIN_WINDOW_SALES +
    ' in each window; this chart needs 3. Try a coarser detail level.');
  var pad = { t: 22, r: 30, b: 48, l: 74 };

  // The y-axis used to be change-in-median. A permutation test kills it: shuffle
  // which sales fall in each window and the spread across zones is essentially
  // unchanged, so the vertical scatter was noise wearing the authority of a
  // chart. Median LEVEL is a far more stable estimate than median CHANGE, and
  // it answers a question you actually have: where is activity growing, and at
  // what price point. Change-in-median survives only as a table column.
  var xMax = Math.max(20, Math.ceil(Math.max.apply(null, rows.map(function (r) { return Math.abs(r.volChange); })) / 10) * 10);
  var meds = rows.map(function (r) { return r.med; });
  var yLo = Math.min.apply(null, meds) * 0.94, yHi = Math.max.apply(null, meds) * 1.06;
  var x = linear(-xMax, xMax, pad.l, m.w - pad.r);
  var y = logScale(yLo, yHi, m.h - pad.b, pad.t);
  var maxN = Math.max.apply(null, rows.map(function (r) { return r.nRecent; }));
  var rOf = function (n) { return 5 + 20 * Math.sqrt(n / maxN); };

  var g = s('g');
  g.appendChild(s('rect', { x: x(0), y: pad.t, width: m.w - pad.r - x(0), height: m.h - pad.b - pad.t,
                            fill: '#e66767', opacity: 0.04 }));
  g.appendChild(s('rect', { x: pad.l, y: pad.t, width: x(0) - pad.l, height: m.h - pad.b - pad.t,
                            fill: '#3987e5', opacity: 0.04 }));

  priceTicks(yLo, yHi).forEach(function (t) {
    var yy = Math.round(y(t)) + 0.5;
    g.appendChild(s('line', { x1: pad.l, x2: m.w - pad.r, y1: yy, y2: yy, stroke: '#23272e' }));
    g.appendChild(s('text', { class: 'lbl', x: pad.l - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: INK3 }, fmtCompact(t)));
  });
  niceTicks(-xMax, xMax, 6).forEach(function (t) {
    var xx = Math.round(x(t)) + 0.5;
    g.appendChild(s('line', { x1: xx, x2: xx, y1: pad.t, y2: m.h - pad.b, stroke: '#23272e' }));
    g.appendChild(s('text', { class: 'lbl', x: xx, y: m.h - pad.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: INK3 }, fmtPct(t, 0)));
  });
  g.appendChild(s('line', { x1: x(0), x2: x(0), y1: pad.t, y2: m.h - pad.b, stroke: '#2c313a', 'stroke-width': 1 }));

  var baseMed = priceStats(slice).med;
  if (baseMed > yLo && baseMed < yHi) {
    g.appendChild(s('line', { x1: pad.l, x2: m.w - pad.r, y1: y(baseMed), y2: y(baseMed), stroke: ACCENT_UI, opacity: 0.5 }));
    g.appendChild(s('text', { class: 'lbl', x: m.w - pad.r, y: y(baseMed) - 5, 'text-anchor': 'end',
                              fill: ACCENT_UI, 'font-size': 10.5 }, 'median of sales in view ' + fmtCompact(baseMed)));
  }

  g.appendChild(s('text', { class: 'lbl', x: m.w - pad.r, y: m.h - pad.b - 6, 'text-anchor': 'end', fill: '#e66767', 'font-weight': 650 }, 'Busier than before →'));
  g.appendChild(s('text', { class: 'lbl', x: pad.l, y: m.h - pad.b - 6, 'text-anchor': 'start', fill: '#7fb0ee', 'font-weight': 650 }, '← Quieter than before'));
  g.appendChild(s('text', { class: 'lbl', x: m.w / 2, y: m.h - 10, 'text-anchor': 'middle' }, 'Change in number of sales'));
  g.appendChild(s('text', { class: 'lbl', x: -(m.h / 2), y: 14, transform: 'rotate(-90)', 'text-anchor': 'middle' }, 'Median price (log scale)'));

  var ordered = rows.slice().sort(function (a, b) { return b.nRecent - a.nRecent; });
  ordered.forEach(function (r) {
    var cx = x(Math.max(-xMax, Math.min(xMax, r.volChange)));
    var cy = y(r.med);
    var sel = (state.area && state.area.name === r.name) ||
              (state.district && r.district === state.district) || false;
    var col = sel ? ACCENT_UI : ACCENT;
    var c = s('circle', {
      cx: cx, cy: cy, r: rOf(r.nRecent),
      fill: col, 'fill-opacity': sel ? 0.6 : 0.28, stroke: col, 'stroke-width': 1.6, tabindex: 0,
      style: 'cursor:pointer'
    });
    bindTip(c, function () {
      return {
        title: r.name + (state.grain === 'zone' ? ' — ' + zoneMakeup(r.name, null, 2).top.join(', ') : ''),
        rows: [
          { k: 'Median price', v: fmtMoney(r.med), color: col },
          { k: 'Sales, last ' + mo.win.w + ' months', v: fmtInt(r.nRecent) },
          { k: 'Previous ' + mo.win.w + ' months', v: fmtInt(r.nPrior) },
          { k: 'Change in sales', v: fmtPct(r.volChange, 0) }
        ],
        foot: (state.grain === 'district' ? '' : r.district + ' · ') + 'click to scope to this area'
      };
    });
    (function (nm) { c.addEventListener('click', function () { scopeTo(state.grain, nm); }); })(r.name);
    c.addEventListener('pointerenter', function () { c.setAttribute('fill-opacity', 0.6); });
    c.addEventListener('pointerleave', function () { c.setAttribute('fill-opacity', sel ? 0.6 : 0.28); });
    g.appendChild(c);
  });

  var extremes = rows.slice().sort(function (a, b) {
    return (Math.abs(b.volChange) * b.nRecent) - (Math.abs(a.volChange) * a.nRecent);
  }).slice(0, 10);
  var canLabel = labelPlacer(120, 15);
  extremes.forEach(function (r) {
    var cx = x(Math.max(-xMax, Math.min(xMax, r.volChange)));
    var cy = y(r.med);
    if (!canLabel(cx, cy)) return;
    var rr = rOf(r.nRecent);
    var right = cx < m.w / 2;
    g.appendChild(s('text', {
      class: 'lbl', x: cx + (right ? rr + 6 : -rr - 6), y: cy + 4,
      'text-anchor': right ? 'start' : 'end', fill: '#f4f2ee', 'font-size': 11.5, 'font-weight': 600,
      'pointer-events': 'none', 'paint-order': 'stroke', stroke: 'rgba(20,23,28,0.85)', 'stroke-width': 3
    }, areaLabelText(r.name, state.grain, 42)));
  });

  m.svg.appendChild(g);

  // "Median change" lives here rather than on the chart's y-axis: at these
  // sample sizes it is not distinguishable from chance, so it is a number to
  // look up, not a position to read.
  var scatTbl = withCovers(state.grain,
    [grainNoun(state.grain), 'Sales now', 'Sales before', 'Volume change', 'Median now', 'Median change'],
    rows.slice().sort(function (a, b) { return b.volChange - a.volChange; }).map(function (r) {
      return [r.name, fmtInt(r.nRecent), fmtInt(r.nPrior), fmtPct(r.volChange, 0), fmtMoney(r.medRecent), fmtPct(r.medChange)];
    }));
  registerTable('scatter', scatTbl.cols, scatTbl.rows);
}

// a signed value in ink, with a small diverging bar carrying the colour —
// text never wears the data colour
function deltaCell(value, maxAbs, text) {
  var td = el('td');
  var box = el('div');
  box.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:9px';
  var W = 42, H = 9, half = W / 2;
  var t = Math.max(-1, Math.min(1, (value || 0) / maxAbs));
  var bw = Math.max(1.5, Math.abs(t) * half);
  box.appendChild(s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H }, [
    s('line', { x1: half, x2: half, y1: 0, y2: H, stroke: '#3a4048' }),
    s('rect', { x: t >= 0 ? half : half - bw, y: 1.5, width: bw, height: H - 3, rx: 1.5,
                fill: divergingColor(value, maxAbs) })
  ]));
  var v = el('span', null, text);
  v.style.cssText = 'min-width:50px;text-align:right;color:var(--ink);font-weight:650';
  box.appendChild(v);
  td.appendChild(box);
  return td;
}

function drawMoversTable(mo) {
  var host = $('moversTable');
  clear(host);
  if (!mo.rows.length) { host.appendChild(el('div', 'empty', 'No areas clear the sample threshold.')); return; }

  var years = [];
  for (var y = state.y0; y <= state.y1; y++) years.push(y);
  var kf = keyFor(state.grain);
  var g = groupBy(slice, kf);

  var cols = [
    { k: 'name', label: grainNoun(state.grain), num: false },
    { k: 'n', label: 'Sales' },
    { k: 'med', label: 'Median' },
    { k: 'volChange', label: 'Volume Δ' },
    { k: 'medChange', label: 'Price Δ' },
    { k: 'trend', label: 'Sales per year', num: false }
  ];

  var sortKey = state._moverSort || 'volChange';
  var dir = state._moverDir === undefined ? -1 : state._moverDir;
  var rows = mo.rows.slice().sort(function (a, b) {
    var av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  var tbl = el('table', 'data');
  var thead = el('thead'), tr = el('tr');
  cols.forEach(function (c) {
    var th = el('th', c.k === sortKey ? 'sorted' : null,
      c.label + (c.k === sortKey ? (dir < 0 ? ' ↓' : ' ↑') : ''));
    if (c.k !== 'trend') {
      th.addEventListener('click', function () {
        if (state._moverSort === c.k) state._moverDir = -dir; else { state._moverSort = c.k; state._moverDir = -1; }
        drawMoversTable(mo);
      });
    } else { th.style.cursor = 'default'; }
    tr.appendChild(th);
  });
  thead.appendChild(tr); tbl.appendChild(thead);

  var tb = el('tbody');
  rows.forEach(function (r) {
    var row = el('tr');
    var tdName = el('td', 'name');
    tdName.style.cursor = 'pointer';
    tdName.title = 'Scope everything to ' + r.name;
    (function (nm) { tdName.addEventListener('click', function () { scopeTo(state.grain, nm); }); })(r.name);
    tdName.appendChild(document.createTextNode(r.name));
    if (state.grain !== 'district') {
      var note = r.district;
      if (state.grain === 'zone') {
        var mk = zoneMakeup(r.name, null, 3);
        if (mk.text) note = mk.top.join(', ') + ' · ' + r.district;
      }
      var sm = el('small', null, ' · ' + note);
      sm.style.color = 'var(--ink-3)';
      sm.style.fontWeight = '400';
      tdName.appendChild(sm);
    }
    row.appendChild(tdName);
    row.appendChild(el('td', null, fmtInt(r.n)));
    row.appendChild(el('td', null, fmtCompact(r.med)));

    row.appendChild(deltaCell(r.volChange, 60, fmtPct(r.volChange, 0)));
    row.appendChild(deltaCell(r.medChange, 30, fmtPct(r.medChange)));

    var counts = {};
    (g[r.name] || []).forEach(function (i) { var yy = yearOf(C.date[i]); counts[yy] = (counts[yy] || 0) + 1; });
    var vals = years.map(function (yy) { return counts[yy] || 0; });
    var tdT = el('td');
    tdT.style.textAlign = 'left';
    if (vals.length > 1) tdT.appendChild(sparkline(vals, 130, 22));
    row.appendChild(tdT);
    tb.appendChild(row);
  });
  tbl.appendChild(tb);
  host.appendChild(tbl);
}

// -------------------------------------------------------------- bump chart

function drawBump() {
  var m = mount('bump', 360);
  // fixed 168px gutters on a 293px chart used to invert the scale and draw
  // time backwards; scale them to the space actually available
  var gut = Math.max(56, Math.min(168, Math.round(m.w * 0.17)));
  var pad = { t: 18, r: gut, b: 30, l: gut };
  var years = [];
  for (var y = state.y0; y <= state.y1; y++) years.push(y);
  if (years.length < 2 || !slice.length) return emptyChart(m);

  var byD = groupBy(slice, function (i) { return DICT.district[C.district[i]]; });
  var names = Object.keys(byD);
  if (names.length < 2) return emptyChart(m);

  var ranks = {};   // name -> [{year, rank, n}]
  years.forEach(function (yr) {
    var counts = names.map(function (n) {
      var c = 0, idx = byD[n];
      for (var i = 0; i < idx.length; i++) if (yearOf(C.date[idx[i]]) === yr) c++;
      return { name: n, n: c };
    }).sort(function (a, b) { return b.n - a.n; });
    counts.forEach(function (c, i) {
      (ranks[c.name] || (ranks[c.name] = [])).push({ year: yr, rank: i + 1, n: c.n });
    });
  });

  var x = linear(years[0], years[years.length - 1], pad.l, m.w - pad.r);
  var yy = linear(1, names.length, pad.t, m.h - pad.b);

  var g = s('g');
  yearTicks(years, m.w).forEach(function (yr) {
    g.appendChild(s('text', { class: 'lbl', x: x(yr), y: m.h - 10, 'text-anchor': 'middle', 'font-size': 11 }, String(yr)));
  });

  var lines = {};
  names.forEach(function (n) {
    var pts = ranks[n];
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p.year).toFixed(1) + ',' + yy(p.rank).toFixed(1); }).join('');
    var isSel = state.district === n;
    var path = s('path', {
      d: d, fill: 'none', stroke: isSel ? ACCENT_UI : MUTED,
      'stroke-width': isSel ? 3 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: state.district ? (isSel ? 1 : 0.35) : 0.85
    });
    lines[n] = path;
    g.appendChild(path);
    pts.forEach(function (p) {
      g.appendChild(s('circle', { cx: x(p.year), cy: yy(p.rank), r: 3.2, fill: isSel ? ACCENT_UI : MUTED, stroke: SURFACE, 'stroke-width': 2 }));
    });

    var first = pts[0], last = pts[pts.length - 1];
    [[first, pad.l - 10, 'end'], [last, m.w - pad.r + 10, 'start']].forEach(function (spec) {
      g.appendChild(s('text', {
        class: 'lbl', x: spec[1], y: yy(spec[0].rank) + 4, 'text-anchor': spec[2],
        fill: isSel ? '#f4f2ee' : 'var(--ink-2)', 'font-size': 11.5, 'font-weight': isSel ? 650 : 500
      }, truncate(n, 20)));
    });

    var hit = s('path', { d: d, fill: 'none', stroke: 'transparent', 'stroke-width': 18, style: 'cursor:pointer', tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: n,
        rows: pts.filter(function (p, i) { return i === 0 || i === pts.length - 1; }).map(function (p) {
          return { k: String(p.year), v: '#' + p.rank + ' · ' + fmtInt(p.n) + ' sales', color: isSel ? ACCENT_UI : MUTED };
        }),
        foot: 'Rank by number of £550k+ sales that year'
      };
    });
    hit.addEventListener('pointerenter', function () { path.setAttribute('stroke', ACCENT_UI); path.setAttribute('opacity', 1); });
    hit.addEventListener('pointerleave', function () {
      path.setAttribute('stroke', isSel ? ACCENT_UI : MUTED);
      path.setAttribute('opacity', state.district ? (isSel ? 1 : 0.35) : 0.85);
    });
    g.appendChild(hit);
  });
  m.svg.appendChild(g);

  registerTable('bump', ['District'].concat(years.map(String)),
    names.map(function (n) {
      return [n].concat(ranks[n].map(function (p) { return '#' + p.rank + ' (' + p.n + ')'; }));
    }));
}

// ==========================================================================
// VALUE
// ==========================================================================

function renderValue() {
  drawDist();
  drawPremium();
  drawLadder();
}

function areaStats(grain, minN) {
  var kf = keyFor(grain);
  var g = groupBy(slice, kf);
  var out = [];
  Object.keys(g).forEach(function (name) {
    if (g[name].length < (minN || minSalesFor(grain))) return;
    var st = priceStats(g[name]);
    out.push({
      name: name, district: grain === 'district' ? name : dominantDistrict(g[name]),
      n: st.n, p10: st.p10, p25: st.p25, med: st.med, p75: st.p75, p90: st.p90, max: st.max
    });
  });
  return out;
}

function drawDist() {
  var host = $('distChart');
  var head = host.parentNode.querySelector('.card-head');
  mountGrainControl(head, renderValue);

  var all = areaStats(state.grain);
  var capped = all.length > MAX_DIST_ROWS;
  var rows = all.slice();
  if (capped) {
    // keep the busiest areas, then order those by median for reading
    rows.sort(function (a, b) { return b.n - a.n; });
    rows = rows.slice(0, MAX_DIST_ROWS);
  }
  rows.sort(function (a, b) { return b.med - a.med; });

  var capNote = $('distNote');
  if (capNote) {
    capNote.textContent = capped
      ? 'Showing the ' + MAX_DIST_ROWS + ' ' + grainNoun(state.grain, true) + ' with the most sales, of ' +
        all.length + ' that clear ' + minSalesFor(state.grain) + ' sales in the slice. The table below has them all.'
      : all.length + ' ' + grainNoun(state.grain, true) + ' with at least ' + minSalesFor(state.grain) +
        ' sales in the slice.';
  }
  var m = mount('distChart', Math.max(220, rows.length * 22 + 56));
  if (!rows.length) return emptyChart(m, fmtInt(slice.length) + ' sales in view, but no ' +
    grainNoun(state.grain) + ' reaches ' + minSalesFor(state.grain) +
    ' sales — a quartile box on a handful of sales would mislead. Try a coarser detail level.');
  // the label gutter has to hold the zone name AND what it covers
  var pad = { t: 24, r: 84, b: 34, l: Math.max(150, Math.min(340, Math.round(m.w * 0.30))) };

  var lo = Math.min.apply(null, rows.map(function (r) { return r.p10; }));
  var hi = Math.max.apply(null, rows.map(function (r) { return r.p90; }));
  var x = logScale(lo * 0.97, hi * 1.05, pad.l, m.w - pad.r);
  var rowH = (m.h - pad.t - pad.b) / rows.length;
  var bh = Math.min(13, rowH - 5);

  var regionMed = priceStats(slice).med;
  var g = s('g');
  priceTicks(lo * 0.97, hi * 1.05).forEach(function (t) {
    var xx = Math.round(x(t)) + 0.5;
    g.appendChild(s('line', { x1: xx, x2: xx, y1: pad.t, y2: m.h - pad.b, stroke: '#23272e' }));
    g.appendChild(s('text', { class: 'lbl', x: xx, y: m.h - pad.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: INK3 }, fmtCompact(t)));
  });
  g.appendChild(s('line', { x1: x(regionMed), x2: x(regionMed), y1: pad.t - 4, y2: m.h - pad.b, stroke: ACCENT_UI, 'stroke-width': 1, opacity: 0.55 }));
  g.appendChild(s('text', { class: 'lbl', x: x(regionMed), y: pad.t - 10, 'text-anchor': 'middle', fill: ACCENT_UI, 'font-size': 10.5 }, (isUnfiltered() ? 'region median ' : 'median of sales in view ') + fmtCompact(regionMed)));

  rows.forEach(function (r, i) {
    var cy = pad.t + i * rowH + rowH / 2;
    g.appendChild(s('line', { x1: x(r.p10), x2: x(r.p90), y1: cy, y2: cy, stroke: MUTED, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    g.appendChild(s('path', { d: hBarPath(x(r.p25), cy - bh / 2, x(r.p75) - x(r.p25), bh, 3), fill: ACCENT, opacity: 0.55 }));
    g.appendChild(s('circle', { cx: x(r.med), cy: cy, r: 4.2, fill: ACCENT_UI, stroke: SURFACE, 'stroke-width': 2 }));
    axisRowLabel(g, pad.l - 12, cy + 4, r.name, state.grain, pad.l - 24);
    g.appendChild(s('text', { class: 'val', x: m.w - pad.r + 10, y: cy + 4, 'text-anchor': 'start' }, fmtCompact(r.med)));

    var hit = s('rect', { class: 'hit', x: 0, y: pad.t + i * rowH, width: m.w, height: rowH, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: r.name + (state.grain === 'zone' ? ' — ' + zoneMakeup(r.name, null, 2).top.join(', ') : ''),
        rows: [
          { k: 'Median', v: fmtMoney(r.med), color: ACCENT_UI },
          { k: 'Middle half', v: fmtMoney(r.p25) + ' – ' + fmtMoney(r.p75) },
          { k: '10th–90th', v: fmtCompact(r.p10) + ' – ' + fmtCompact(r.p90) },
          { k: 'Sales', v: fmtInt(r.n) },
          { k: 'vs ' + baselineLabel(true), v: fmtPct((r.med - regionMed) / regionMed * 100, 0) }
        ],
        foot: state.grain === 'district' ? null : r.district
      };
    });
    g.appendChild(hit);
  });
  m.svg.appendChild(g);

  var lg = legend(m.host, [
    { color: ACCENT_UI, label: 'Median' },
    { color: '#8a6524', label: 'Middle half (25th–75th)' },
    { color: MUTED, label: '10th–90th percentile', line: true }
  ]);
  lg.style.marginTop = '12px';

  var distTbl = withCovers(state.grain,
    [grainNoun(state.grain), 'Sales', '10th', '25th', 'Median', '75th', '90th', 'Dearest'],
    all.slice().sort(function (a, b) { return b.med - a.med; }).map(function (r) {
      return [r.name, fmtInt(r.n), fmtCompact(r.p10), fmtCompact(r.p25), fmtMoney(r.med), fmtCompact(r.p75), fmtCompact(r.p90), fmtCompact(r.max)];
    }));
  registerTable('distChart', distTbl.cols, distTbl.rows);
}

function drawPremium() {
  var rows = areaStats(state.grain);
  var regionMed = priceStats(slice).med;
  rows.forEach(function (r) { r.prem = (r.med - regionMed) / regionMed * 100; });
  rows.sort(function (a, b) { return b.prem - a.prem; });
  var show = rows.length > 16 ? rows.slice(0, 8).concat(rows.slice(-8)) : rows;

  $('premSub').textContent = 'Each ' + grainNoun(state.grain) + '\'s median against the median of ' +
    baselineLabel(false) + ' (' + fmtCompact(regionMed) + ').' +
    (rows.length > 16 ? ' Showing the eight dearest and eight cheapest of ' + rows.length + '.' : '');

  var m = mount('premChart', Math.max(200, show.length * 24 + 34));
  if (!show.length) return emptyChart(m);
  var pad = { t: 8, r: 56, b: 22, l: Math.max(150, Math.min(330, Math.round(m.w * 0.38))) };
  var maxAbs = Math.max.apply(null, show.map(function (r) { return Math.abs(r.prem); })) || 1;
  var x = linear(-maxAbs, maxAbs, pad.l, m.w - pad.r);
  var rowH = (m.h - pad.t - pad.b) / show.length;
  var bh = Math.min(14, rowH - 5);

  var g = s('g');
  g.appendChild(s('line', { x1: x(0), x2: x(0), y1: pad.t, y2: m.h - pad.b, stroke: '#2c313a' }));
  show.forEach(function (r, i) {
    var yv = pad.t + i * rowH + (rowH - bh) / 2;
    var col = divergingColor(r.prem, maxAbs);
    g.appendChild(s('path', { d: hBarPath(x(0), yv, x(r.prem) - x(0), bh, 4), fill: col }));
    axisRowLabel(g, pad.l - 12, yv + bh - 2, r.name, state.grain, pad.l - 24);
    g.appendChild(s('text', {
      class: 'val', x: x(r.prem) + (r.prem >= 0 ? 7 : -7), y: yv + bh - 2,
      'text-anchor': r.prem >= 0 ? 'start' : 'end'
    }, fmtPct(r.prem, 0)));
    var hit = s('rect', { class: 'hit', x: 0, y: pad.t + i * rowH, width: m.w, height: rowH, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: r.name,
        rows: [
          { k: 'Median', v: fmtMoney(r.med), color: col },
          { k: 'vs ' + baselineLabel(true), v: fmtPct(r.prem, 0) },
          { k: 'Sales', v: fmtInt(r.n) }
        ],
        foot: state.grain === 'district' ? null : r.district
      };
    });
    g.appendChild(hit);
  });
  m.svg.appendChild(g);

  var premTbl = withCovers(state.grain,
    [grainNoun(state.grain), 'Sales', 'Median', 'vs ' + baselineLabel(true)],
    rows.map(function (r) { return [r.name, fmtInt(r.n), fmtMoney(r.med), fmtPct(r.prem, 0)]; }));
  registerTable('premChart', premTbl.cols, premTbl.rows);
}

function drawLadder() {
  var byD = groupBy(slice, function (i) { return DICT.district[C.district[i]]; });
  var names = Object.keys(byD).sort(function (a, b) {
    var sa = shareAbove(byD[a], 1000000), sb = shareAbove(byD[b], 1000000);
    return sb - sa;
  });
  var m = mount('ladderChart', Math.max(180, names.length * 30 + 30));
  if (!names.length) return emptyChart(m);
  var pad = { t: 6, r: 16, b: 24, l: 150 };
  var x = linear(0, 100, pad.l, m.w - pad.r);
  var rowH = (m.h - pad.t - pad.b) / names.length;
  var bh = Math.min(18, rowH - 8);

  var g = s('g');
  [0, 25, 50, 75, 100].forEach(function (t) {
    var xx = Math.round(x(t)) + 0.5;
    g.appendChild(s('line', { x1: xx, x2: xx, y1: pad.t, y2: m.h - pad.b, stroke: '#23272e' }));
    g.appendChild(s('text', { class: 'lbl', x: xx, y: m.h - pad.b + 15, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK3 }, t + '%'));
  });

  names.forEach(function (name, i) {
    var idx = byD[name];
    var counts = BANDS.map(function (b) {
      var c = 0;
      for (var k = 0; k < idx.length; k++) { var p = C.price[idx[k]]; if (p >= b.lo && p < b.hi) c++; }
      return c;
    });
    var tot = sum(counts) || 1;
    var yv = pad.t + i * rowH + (rowH - bh) / 2;
    var acc = 0;
    counts.forEach(function (c, bi) {
      var w0 = c / tot * 100;
      if (w0 <= 0) { acc += w0; return; }
      var x0 = x(acc), x1 = x(acc + w0);
      var isFirst = bi === 0 || acc === 0;
      var isLast = acc + w0 >= 99.999;
      var w1 = Math.max(0, x1 - x0 - (isLast ? 0 : 2));
      var rect = s('rect', {
        x: x0, y: yv, width: w1, height: bh, fill: LADDER[bi],
        rx: (isFirst || isLast) ? 4 : 0, tabindex: 0, style: 'cursor:pointer'
      });
      bindTip(rect, function () {
        return {
          title: name,
          rows: [{ k: BANDS[bi].label, v: fmtInt(c) + ' sales · ' + w0.toFixed(1) + '%', color: LADDER[bi] },
                 { k: 'All £550k+ sales', v: fmtInt(tot) }]
        };
      });
      g.appendChild(rect);
      // only label a segment when the text genuinely fits
      var txt = Math.round(w0) + '%';
      if (w1 > txt.length * 7 + 12 && bh >= 14) {
        g.appendChild(s('text', {
          x: x0 + w1 / 2, y: yv + bh / 2 + 3.5, 'text-anchor': 'middle', 'font-size': 10.5,
          'font-weight': 650, fill: inkOn(LADDER[bi]), 'pointer-events': 'none'
        }, txt));
      }
      acc += w0;
    });
    g.appendChild(s('text', { class: 'lbl', x: pad.l - 12, y: yv + bh - 4, 'text-anchor': 'end' }, truncate(name, 22)));
  });
  m.svg.appendChild(g);

  var lgHost = $('ladderLegend');
  clear(lgHost);
  legend(lgHost, BANDS.map(function (b, i) { return { color: LADDER[i], label: b.label }; }));

  registerTable('ladderChart', ['District', 'Sales'].concat(BANDS.map(function (b) { return b.label; })),
    names.map(function (name) {
      var idx = byD[name];
      var counts = BANDS.map(function (b) {
        var c = 0;
        for (var k = 0; k < idx.length; k++) { var p = C.price[idx[k]]; if (p >= b.lo && p < b.hi) c++; }
        return c;
      });
      var tot = sum(counts) || 1;
      return [name, fmtInt(tot)].concat(counts.map(function (c) { return fmtInt(c) + ' (' + (c / tot * 100).toFixed(1) + '%)'; }));
    }));
}

function shareAbove(idx, threshold) {
  var c = 0;
  for (var i = 0; i < idx.length; i++) if (C.price[idx[i]] >= threshold) c++;
  return c / (idx.length || 1);
}

// ==========================================================================
// RHYTHM
// ==========================================================================

function renderRhythm() {
  drawHeatGrid();
  drawSeason();
  drawPeak();
}

function drawHeatGrid() {
  var m = mount('heatGrid', 0);
  var years = [];
  for (var y = state.y0; y <= state.y1; y++) years.push(y);
  var cellH = 22, pad = { t: 26, r: 10, b: 8, l: 46 };
  var height = pad.t + years.length * cellH + pad.b;
  clear(m.host);
  var w = m.host.clientWidth || 900;
  var svg = s('svg', { width: w, height: height, viewBox: '0 0 ' + w + ' ' + height });
  m.host.appendChild(svg);

  var cellW = (w - pad.l - pad.r) / 12;
  var counts = {};
  var vals = [];
  for (var i = 0; i < slice.length; i++) {
    var mo = C.date[slice[i]];
    counts[mo] = (counts[mo] || 0) + 1;
  }
  years.forEach(function (yr) {
    for (var mm = 0; mm < 12; mm++) {
      var key = (yr - BASE_YEAR) * 12 + mm;
      if (key <= LAST_MONTH && key >= 0) vals.push(counts[key] || 0);
    }
  });
  var maxV = Math.max.apply(null, vals.concat([1]));

  var g = s('g');
  MONTHS.forEach(function (nm, i) {
    g.appendChild(s('text', { class: 'lbl', x: pad.l + cellW * (i + 0.5), y: pad.t - 9, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK3 }, nm));
  });
  years.forEach(function (yr, ri) {
    g.appendChild(s('text', { class: 'lbl', x: pad.l - 10, y: pad.t + ri * cellH + cellH / 2 + 4, 'text-anchor': 'end', 'font-size': 11 }, String(yr)));
    for (var mm = 0; mm < 12; mm++) {
      var key = (yr - BASE_YEAR) * 12 + mm;
      var future = key > LAST_MONTH || key < 0;
      var partial = !future && yr === PARTIAL_YEAR;
      var n = counts[key] || 0;
      // sqrt, not linear: one stamp-duty-deadline month at 278 sales was
      // compressing three quarters of the grid into the bottom two steps
      var col = future ? 'transparent' : rampColor(SEQ, Math.sqrt(n / maxV));
      var rect = s('rect', {
        x: pad.l + mm * cellW + 1, y: pad.t + ri * cellH + 1,
        width: cellW - 2, height: cellH - 2, rx: 3,
        fill: col, stroke: future ? '#1a1e25' : (partial ? '#3a4048' : 'none'),
        'stroke-dasharray': future ? '2 2' : (partial ? '2 2' : null),
        tabindex: future ? null : 0, style: future ? '' : 'cursor:default'
      });
      g.appendChild(rect);
      if (!future) {
        (function (n2, yr2, mm2, col2) {
          bindTip(rect, function () {
            return {
              title: MONTHS[mm2] + ' ' + yr2,
              rows: [{ k: 'Sales at £550k+', v: fmtInt(n2), color: col2 }],
              foot: n2 === maxV ? 'The busiest month in this slice' : null
            };
          });
        })(n, yr, mm, col);
        if (cellW > 30 && n > 0) {
          g.appendChild(s('text', {
            x: pad.l + mm * cellW + cellW / 2, y: pad.t + ri * cellH + cellH / 2 + 3.5,
            'text-anchor': 'middle', 'font-size': 9.5, fill: inkOn(col), 'pointer-events': 'none',
            opacity: Math.sqrt(n / maxV) > 0.28 ? 1 : 0.75
          }, String(n)));
        }
      }
    }
  });
  svg.appendChild(g);

  scaleLegend('heatScale', [0, 1, 2, 3, 4, 5, 6].map(function (i) {
    return { lo: Math.round(maxV * Math.pow(i / 7, 2)), hi: Math.round(maxV * Math.pow((i + 1) / 7, 2)), color: SEQ[i] };
  }), function (v) { return fmtInt(v); }, 'sales in the month (square-root scale)');

  registerTable('heatGrid', ['Year'].concat(MONTHS),
    years.map(function (yr) {
      return [String(yr)].concat(MONTHS.map(function (_, mm) {
        var key = (yr - BASE_YEAR) * 12 + mm;
        return key > LAST_MONTH ? '—' : fmtInt(counts[key] || 0);
      }));
    }));
}

function drawSeason() {
  var m = mount('seasonChart', 260);
  if (!slice.length) return emptyChart(m);
  var pad = { t: 16, r: 12, b: 34, l: 44 };
  var counts = new Array(12).fill(0);
  for (var i = 0; i < slice.length; i++) counts[C.date[slice[i]] % 12]++;
  var tot = sum(counts) || 1;
  var shares = counts.map(function (c) { return c / tot * 100; });
  var maxV = Math.max.apply(null, shares);
  var x = linear(0, 12, pad.l, m.w - pad.r);
  var y = linear(0, maxV * 1.12, m.h - pad.b, pad.t);
  var bw = Math.min(24, (x(1) - x(0)) - 6);

  var g = s('g');
  yAxis(g, y, niceTicks(0, maxV * 1.12, 4), pad.l, m.w - pad.r, function (v) { return v.toFixed(0) + '%'; });
  g.appendChild(s('line', { x1: pad.l, x2: m.w - pad.r, y1: y(100 / 12), y2: y(100 / 12), stroke: ACCENT_UI, opacity: 0.5 }));
  g.appendChild(s('text', { class: 'lbl', x: m.w - pad.r, y: y(100 / 12) - 5, 'text-anchor': 'end', fill: ACCENT_UI, 'font-size': 10.5 }, 'even split'));

  // The old caption asserted that completions cluster at quarter-ends and that
  // this was "useful for timing an offer". Neither survives the data: the spread
  // is a point or two, and price does not vary by month — a quiet month is not a
  // cheap month. Say what is actually true, computed from the slice in view.
  var sub = $('seasonSub');
  if (sub) {
    var qEnd = (counts[2] + counts[5] + counts[8] + counts[11]) / tot * 100;
    var rest = 100 - qEnd;
    var medByMonth = [];
    for (var mi = 0; mi < 12; mi++) {
      var pm = [];
      for (var si = 0; si < slice.length; si++) if (C.date[slice[si]] % 12 === mi) pm.push(C.price[slice[si]]);
      pm.sort(function (a, b) { return a - b; });
      medByMonth.push(pm.length >= 12 ? quantile(pm, 0.5) : null);
    }
    var valid = medByMonth.filter(function (v) { return v !== null; });
    var spread = valid.length > 3
      ? (Math.max.apply(null, valid) - Math.min.apply(null, valid)) / quantile(valid.slice().sort(function (a, b) { return a - b; }), 0.5) * 100
      : null;
    sub.textContent = 'Share of sales in the slice completing in each calendar month. A quarter-end month ' +
      'averages ' + (qEnd / 4).toFixed(1) + '% of the year against ' + (rest / 8).toFixed(1) +
      '% for the other eight — next to nothing, against the 8.3% an even split would give. ' +
      (spread !== null
        ? 'And the median barely moves between months (a ' + spread.toFixed(0) + '% spread across the year), so ' +
          'a quiet month is not a cheap month — do not read this as a lever on price.'
        : 'Too few sales here to compare prices between months.');
  }

  var peak = shares.indexOf(maxV);
  shares.forEach(function (v, i) {
    var cx = x(i) + (x(1) - x(0) - bw) / 2;
    var h = (m.h - pad.b) - y(v);
    g.appendChild(s('path', { d: barPath(cx, y(v), bw, h, 4), fill: i === peak ? ACCENT_UI : ACCENT, opacity: i === peak ? 1 : 0.75 }));
    if (i === peak) g.appendChild(s('text', { class: 'val', x: cx + bw / 2, y: y(v) - 7, 'text-anchor': 'middle' }, v.toFixed(1) + '%'));
    g.appendChild(s('text', { class: 'lbl', x: cx + bw / 2, y: m.h - 14, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK3 }, MONTHS[i]));
    var hit = s('rect', { class: 'hit', x: x(i), y: pad.t, width: x(1) - x(0), height: m.h - pad.b - pad.t, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: MONTHS[i],
        rows: [{ k: 'Share of sales', v: v.toFixed(1) + '%', color: ACCENT },
               { k: 'Sales', v: fmtInt(counts[i]) }]
      };
    });
    g.appendChild(hit);
  });
  m.svg.appendChild(g);

  registerTable('seasonChart', ['Month', 'Sales', 'Share'],
    MONTHS.map(function (nm, i) { return [nm, fmtInt(counts[i]), shares[i].toFixed(1) + '%']; }));
}

function drawPeak() {
  // each district's latest 12 months of volume against its best-ever 12 months
  var byD = groupBy(slice, function (i) { return DICT.district[C.district[i]]; });
  var names = Object.keys(byD);
  var lo = Infinity, hi = -Infinity;
  for (var i = 0; i < slice.length; i++) {
    var mm = C.date[slice[i]];
    if (mm < lo) lo = mm;
    if (mm > hi) hi = mm;
  }
  if (!names.length || hi - lo < 24) {
    var m0 = mount('peakChart', 120);
    $('peakSub').textContent = 'Needs at least two years of history in the slice.';
    return emptyChart(m0);
  }
  $('peakSub').textContent = 'Sales in the last twelve months (' + monthLabel(hi - 11) + '–' + monthLabel(hi) +
    ') as a share of each district\'s busiest twelve months since ' + yearOf(lo) + '. 100% means it is at its own record.';

  var rows = names.map(function (n) {
    var idx = byD[n];
    var series = {};
    for (var k = 0; k < idx.length; k++) { var mo = C.date[idx[k]]; series[mo] = (series[mo] || 0) + 1; }
    var best = 0, bestEnd = hi;
    for (var end = lo + 11; end <= hi; end++) {
      var acc = 0;
      for (var q = end - 11; q <= end; q++) acc += series[q] || 0;
      if (acc > best) { best = acc; bestEnd = end; }
    }
    var now = 0;
    for (var q2 = hi - 11; q2 <= hi; q2++) now += series[q2] || 0;
    return { name: n, now: now, best: best, bestEnd: bestEnd, pct: best ? now / best * 100 : 0 };
  }).sort(function (a, b) { return b.pct - a.pct; });

  var m = mount('peakChart', Math.max(180, rows.length * 26 + 30));
  var pad = { t: 8, r: 54, b: 22, l: 150 };
  var x = linear(0, 100, pad.l, m.w - pad.r);
  var rowH = (m.h - pad.t - pad.b) / rows.length;
  var bh = Math.min(15, rowH - 6);

  var g = s('g');
  [0, 25, 50, 75, 100].forEach(function (t) {
    var xx = Math.round(x(t)) + 0.5;
    g.appendChild(s('line', { x1: xx, x2: xx, y1: pad.t, y2: m.h - pad.b, stroke: t === 100 ? '#2c313a' : '#23272e' }));
    g.appendChild(s('text', { class: 'lbl', x: xx, y: m.h - pad.b + 15, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK3 }, t + '%'));
  });
  rows.forEach(function (r, i) {
    var yv = pad.t + i * rowH + (rowH - bh) / 2;
    g.appendChild(s('rect', { x: pad.l, y: yv, width: x(100) - pad.l, height: bh, fill: '#1d2129', rx: 4 }));
    g.appendChild(s('path', { d: hBarPath(pad.l, yv, x(r.pct) - pad.l, bh, 4), fill: ACCENT }));
    g.appendChild(s('text', { class: 'lbl', x: pad.l - 12, y: yv + bh - 3, 'text-anchor': 'end' }, truncate(r.name, 22)));
    g.appendChild(s('text', { class: 'val', x: m.w - pad.r + 8, y: yv + bh - 3 }, Math.round(r.pct) + '%'));
    var hit = s('rect', { class: 'hit', x: 0, y: pad.t + i * rowH, width: m.w, height: rowH, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: r.name,
        rows: [
          { k: 'Last 12 months', v: fmtInt(r.now) + ' sales', color: ACCENT },
          { k: 'Best 12 months', v: fmtInt(r.best) + ' sales' },
          { k: 'Peak ended', v: monthLabel(r.bestEnd) }
        ]
      };
    });
    g.appendChild(hit);
  });
  m.svg.appendChild(g);

  registerTable('peakChart', ['District', 'Last 12 months', 'Best 12 months', 'Peak ended', 'Share of peak'],
    rows.map(function (r) { return [r.name, fmtInt(r.now), fmtInt(r.best), monthLabel(r.bestEnd), Math.round(r.pct) + '%']; }));
}

// ==========================================================================
// SALES TABLE
// ==========================================================================

function renderSales() {
  var host = $('salesTable');
  clear(host);
  var q = state.salesQuery.trim().toLowerCase();
  var rows = slice;
  if (q) {
    rows = rows.filter(function (i) {
      return C.address[i].toLowerCase().indexOf(q) >= 0 ||
             DICT.settlement[C.settlement[i]].toLowerCase().indexOf(q) >= 0 ||
             DICT.pcd[C.pcd[i]].toLowerCase().indexOf(q) >= 0 ||
             DICT.zone[C.zone[i]].toLowerCase().indexOf(q) >= 0;
    });
  }

  var sc = state.salesSort;
  var getters = {
    date: function (i) { return C.date[i]; },
    price: function (i) { return C.price[i]; },
    address: function (i) { return C.address[i]; },
    district: function (i) { return DICT.district[C.district[i]]; },
    zone: function (i) { return DICT.zone[C.zone[i]]; },
    pcd: function (i) { return DICT.pcd[C.pcd[i]]; },
    ptype: function (i) { return DICT.ptype[C.ptype[i]]; }
  };
  var gf = getters[sc.col];
  rows = rows.slice().sort(function (a, b) {
    var av = gf(a), bv = gf(b);
    if (typeof av === 'string') return av.localeCompare(bv) * sc.dir;
    return (av - bv) * sc.dir;
  });

  if (state.repeatOnly) rows = rows.filter(function (i) { var h = RSI.repeatsOf[C.address[i]]; return h && h.length > 1; });
  var shown = rows.slice(0, state.salesLimit);
  $('salesSub').textContent = 'Showing ' + fmtInt(shown.length) + ' of ' + fmtInt(rows.length) +
    ' sales in the current slice, newest first by default. Click a column head to sort, an address to open the ' +
    'Land Registry record, or the ↺ badge on a property that has sold more than once to see its own history.';

  var cols = [
    { k: 'date', label: 'Date' },
    { k: 'price', label: 'Price' },
    { k: 'address', label: 'Address' },
    { k: 'ptype', label: 'Type' },
    { k: 'zone', label: 'Settlement zone' },
    { k: 'district', label: 'District' },
    { k: 'pcd', label: 'Postcode' }
  ];
  var tbl = el('table', 'data');
  var thead = el('thead'), tr = el('tr');
  cols.forEach(function (c) {
    var th = el('th', c.k === sc.col ? 'sorted' : null, c.label + (c.k === sc.col ? (sc.dir < 0 ? ' ↓' : ' ↑') : ''));
    th.addEventListener('click', function () {
      if (sc.col === c.k) sc.dir = -sc.dir; else { sc.col = c.k; sc.dir = (c.k === 'date' || c.k === 'price') ? -1 : 1; }
      renderSales();
    });
    tr.appendChild(th);
  });
  thead.appendChild(tr); tbl.appendChild(thead);

  var tb = el('tbody');
  var lastYear = RSI.years[RSI.years.length - 1];
  shown.forEach(function (i) {
    var row = el('tr');
    var history = RSI.repeatsOf[C.address[i]];
    var mo = C.date[i];

    var tdD = el('td', null, MONTHS[mo % 12] + ' ' + yearOf(mo));
    row.appendChild(tdD);

    var tdP = el('td');
    var pw = el('div');
    pw.style.cssText = 'display:flex;align-items:baseline;justify-content:flex-end;gap:8px';
    var main = el('span', null, fmtMoney(C.price[i]));
    main.style.cssText = 'color:var(--ink);font-weight:650';
    pw.appendChild(main);
    // Restating a past price in today's money using the repeat-sales rate. Off by
    // default, both figures always shown, rounded to £10k because the confidence
    // band on the factor alone is about ±4%. It is a historical fact re-expressed,
    // not a valuation, and it deliberately has no input box.
    if (state.todayMoney) {
      var f = RSI.factor(yearOf(mo), lastYear);
      if (f !== null && Math.abs(f - 1) > 0.005) {
        var today = Math.round(C.price[i] * f / 10000) * 10000;
        var t = el('span', null, '≈' + fmtCompact(today));
        t.style.cssText = 'color:var(--accent);font-weight:650;font-size:11.5px';
        t.title = 'The same money in ' + lastYear + ' terms, using the region-wide repeat-sales index (±4%). Not a valuation of this house.';
        pw.appendChild(t);
      }
    }
    tdP.appendChild(pw);
    row.appendChild(tdP);

    var tdA = el('td', 'addr');
    // a real link, so right-click and open-in-new-tab work
    var a = document.createElement('a');
    a.href = 'http://landregistry.data.gov.uk/data/ppi/transaction/' + C.txn[i] + '/current';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = C.address[i];
    a.style.cssText = 'color:var(--ink);text-decoration:none';
    tdA.appendChild(a);
    if (history && history.length > 1) {
      var badge = el('button', 'repeat-badge', '↺ ' + history.length + ' sales');
      badge.title = 'This exact property sold ' + history.length + ' times — click for its history';
      (function (addr) {
        badge.addEventListener('click', function (ev) {
          ev.stopPropagation();
          state.openHistory = (state.openHistory === addr) ? null : addr;
          renderSales();
        });
      })(C.address[i]);
      tdA.appendChild(badge);
    }
    row.appendChild(tdA);

    row.appendChild(el('td', null, DICT.ptype[C.ptype[i]] + ((C.flags[i] & F_NEW) ? ' · new' : '')));
    var zName = DICT.zone[C.zone[i]];
    var tdZ = el('td', null, zName);
    var zmk = zoneMakeup(zName, null, 4);
    if (zmk.text) tdZ.title = zName + ' covers ' + zmk.text;
    row.appendChild(tdZ);
    row.appendChild(el('td', null, DICT.district[C.district[i]]));
    row.appendChild(el('td', null, DICT.pcd[C.pcd[i]]));
    tb.appendChild(row);

    // the same house, sold twice: the most informative record in the file,
    // because size, plot, street and aspect are all held constant
    if (history && state.openHistory === C.address[i]) {
      var hr = el('tr', 'history-row');
      var td = el('td');
      td.colSpan = 7;
      var box = el('div', 'history');
      box.appendChild(el('div', 'h-title', 'Every recorded sale of this property'));
      history.forEach(function (j, k) {
        var line = el('div', 'h-line');
        line.appendChild(el('span', 'h-date', MONTHS[C.date[j] % 12] + ' ' + yearOf(C.date[j])));
        line.appendChild(el('span', 'h-price', fmtMoney(C.price[j])));
        if (k > 0) {
          var prev = history[k - 1];
          var yrs = (C.date[j] - C.date[prev]) / 12;
          var chg = (C.price[j] / C.price[prev] - 1) * 100;
          var ann = yrs > 0.4 ? (Math.pow(C.price[j] / C.price[prev], 1 / yrs) - 1) * 100 : null;
          var d = el('span', 'h-delta', fmtPct(chg, 1) + ' over ' + yrs.toFixed(1) + ' yrs' +
                     (ann !== null ? ' · ' + fmtPct(ann, 1) + '/yr' : ''));
          d.style.color = divergingColor(chg, 60);
          line.appendChild(d);
        } else {
          line.appendChild(el('span', 'h-delta', 'first recorded sale'));
        }
        box.appendChild(line);
      });
      box.appendChild(el('div', 'h-note',
        'Falls are under-counted: a house that dropped below £550,000 leaves this extract entirely, ' +
        'while every rise stays in. Across the region 10% of repeat pairs resold lower.'));
      td.appendChild(box);
      hr.appendChild(td);
      tb.appendChild(hr);
    }
  });
  tbl.appendChild(tb);
  host.appendChild(tbl);
  if (rows.length > shown.length) {
    var more = el('button', 'btn', 'Show ' + fmtInt(Math.min(400, rows.length - shown.length)) + ' more of ' +
                  fmtInt(rows.length - shown.length) + ' remaining');
    more.style.cssText = 'margin-top:14px;width:100%';
    more.addEventListener('click', function () { state.salesLimit += 400; renderSales(); });
    host.appendChild(more);
  }
  if (!shown.length) host.appendChild(el('div', 'empty', 'No sales match the current filters and search.'));
}

// ==========================================================================
// CONTROLS + ROUTER
// ==========================================================================

// how many rows each flag keeps on its own, so the help can be concrete
var FLAG_COUNTS = (function () {
  var c = { search: 0, newb: 0 };
  for (var i = 0; i < N; i++) {
    if (C.flags[i] & F_SEARCH) c.search++;
    if (C.flags[i] & F_NEW) c.newb++;
  }
  return c;
})();

var HELP = {
  slice: {
    title: 'Sales of a home only',
    body: 'Every figure here is built from sales of a single dwelling. ' +
          fmtInt(EXCLUDED.total) + ' of the ' + fmtInt(EXCLUDED.ofFile) + ' records in the Land ' +
          'Registry extract are set aside before anything is counted — almost all of them because ' +
          'they are not houses at all. Repossessions, buy-to-lets and purchases by companies are ' +
          'kept: they are unverified by Land Registry but they transact at market price, and their ' +
          'prices sit right on top of the verified ones.',
    foot: ['Set aside:'].concat(EXCLUDED.reasons.map(function (r) {
      return fmtInt(r[1]) + ' · ' + r[0];
    }))
  },
  search: {
    title: 'Search area',
    body: 'Narrows everything to the postcodes flagged in the extract as inside your search geography, ' +
          'so the charts describe only the ground you are actually buying on. Leave it off to see how ' +
          'your search area compares with the rest of the region — several districts, Rushcliffe and ' +
          'South Kesteven especially, extend well beyond it.',
    foot: 'Keeps ' + fmtInt(FLAG_COUNTS.search) + ' of ' + fmtInt(N) + ' sales · off by default'
  },
  newBuild: {
    title: 'New build',
    body: 'Shows only sales of newly built property — useful for what developers are actually achieving ' +
          'in each area. Treat the volumes with care: Price Paid misses many plot sales made under ' +
          'option agreements, so new build is under-counted here rather than simply rare.',
    foot: 'Keeps ' + fmtInt(FLAG_COUNTS.newb) + ' of ' + fmtInt(N) + ' sales · off by default'
  },
  years: {
    title: 'Year range',
    body: 'The window every chart on every tab is computed over. Both ends of the data are partial — ' +
          '2010 starts in July, 2026 stops on 22 June — so 2026 is drawn faded wherever it appears. ' +
          'Momentum always compares two equal-length windows rather than calendar years, so a part ' +
          'year can never flatter or punish an area.',
    foot: 'Drag either handle'
  },
  county: {
    title: 'County',
    body: 'Rolls the eight districts up into their counties: ' +
          COUNTIES.map(function (c) { return c.name + ' (' + c.districts.join(', ') + ')'; }).join('; ') +
          '. Choosing one narrows the District list beside it to that county alone. Worth knowing that ' +
          'Leicestershire is represented here by Melton only, and Rutland is a single unitary authority, ' +
          'so for those two a county and a district selection come to the same thing.',
    foot: null
  },
  district: {
    title: 'District',
    body: 'Limits everything to one of the eight local authority districts. Settlement zones and ' +
          'postcode districts stay grouped underneath it, so you can pick a district here and then ' +
          'switch the Momentum and Value tabs to zone-level detail within it.',
    foot: null
  },
  grain: {
    title: 'Detail level',
    body: 'How finely the charts group sales. Districts are the eight local authorities. ' +
          '“Settlement zones” are the source data’s own grouping of villages that trade as one market — ' +
          'useful, but the names are its names, not official places, and one of them is a trap: ' +
          '“Town” is not a town. It means “the town this district revolves around”, so it is Stamford ' +
          'and the Deepings in South Kesteven but Oakham and Uppingham in Rutland, and it spans six ' +
          'districts in total. Every zone now shows the settlements it covers. Postcode districts and ' +
          'sectors are postal geography, which splits a big town that is a single row everywhere else. ' +
          'Villages are the finest unit and the one you actually shop in.',
    foot: null
  },
  village: {
    title: 'Village',
    body: 'Scopes everything to one village or settlement — start typing and the list suggests only ' +
          'places that exist under your other filters, busiest first. It matches on part of a name, so ' +
          '“burton” finds every Burton. At a £550k floor most villages record only a handful of sales ' +
          'in sixteen years, so expect the Momentum tab to go quiet at this level while Pulse, Value ' +
          'and Sales stay useful.',
    foot: 'Clear the box to drop the filter'
  },
  ptype: {
    title: 'Property type',
    body: 'The Land Registry’s own classification. “Other” — commercial, agricultural and mixed-use ' +
          'property — is not listed, because every such record is set aside before the app loads it. ' +
          'What remains is houses and flats.',
    foot: null
  },
  bands: {
    title: 'Price band',
    body: 'Filters to one or more price bands; they combine, so £1m–2m and £2m+ together give you ' +
          'everything over a million. Select none for all sales at £550k and over. Handy for asking ' +
          'where the genuine prime market is, rather than where the volume is.',
    foot: 'Click again to clear a band'
  }
};

function bindHelp(node, key) {
  var h = HELP[key];
  if (!node || !h) return;
  node.style.cursor = 'help';
  node.addEventListener('pointerenter', function (e) { tipShowHelp(e, h.title, h.body, h.foot); });
  node.addEventListener('pointermove', tipMove);
  node.addEventListener('pointerleave', tipHide);
  node.addEventListener('focus', function () {
    var r = node.getBoundingClientRect();
    tipShowHelp({ clientX: r.left, clientY: r.bottom + 4 }, h.title, h.body, h.foot);
  });
  node.addEventListener('blur', tipHide);
}

// The district list is dependent on the county: with no county chosen it shows
// all eight grouped under their county, and with one chosen it narrows to that
// county's districts so the two controls can never disagree.
function rebuildDistrictOptions() {
  var dsel = $('fDistrict');
  clear(dsel);
  var visible = state.county
    ? (COUNTIES.filter(function (c) { return c.name === state.county; })[0] || { districts: [] }).districts
    : DICT.district.slice().sort();

  var all = document.createElement('option');
  all.value = '';
  all.textContent = visible.length === 1
    ? visible[0] + ' — the only district'
    : 'All ' + visible.length + ' districts' + (state.county ? ' in ' + state.county : '');
  dsel.appendChild(all);

  if (state.county) {
    // with one district the "all" row already is that district; a second row
    // offering the same slice under another name is just noise
    if (visible.length > 1) {
      visible.forEach(function (d) {
        var o = document.createElement('option');
        o.value = d; o.textContent = d;
        dsel.appendChild(o);
      });
    }
  } else {
    COUNTIES.forEach(function (c) {
      var grp = document.createElementNS('http://www.w3.org/1999/xhtml', 'optgroup');
      grp.label = c.name;
      c.districts.forEach(function (d) {
        var o = document.createElement('option');
        o.value = d; o.textContent = d;
        grp.appendChild(o);
      });
      dsel.appendChild(grp);
    });
  }
  dsel.value = state.district;
}

function initControls() {
  var dsel = $('fDistrict');
  var csel = $('fCounty');

  COUNTIES.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c.name;
    // name the district only where it differs from the county — "Rutland (Rutland)" helps nobody
    o.textContent = (c.districts.length === 1 && c.districts[0] !== c.name)
      ? c.name + ' (' + c.districts[0] + ' only)'
      : c.name;
    csel.appendChild(o);
  });
  csel.firstChild.textContent = 'All ' + COUNTIES.length + ' counties';

  csel.addEventListener('change', function () {
    state.county = csel.value;
    // a district outside the new county would silently zero the page
    if (state.district && state.county && COUNTY_OF[state.district] !== state.county) state.district = '';
    rebuildDistrictOptions();
    refresh();
  });

  rebuildDistrictOptions();
  dsel.addEventListener('change', function () { state.district = dsel.value; refresh(); });

  var tsel = $('fType');
  var typeCounts = {};
  for (var i = 0; i < N; i++) typeCounts[DICT.ptype[C.ptype[i]]] = (typeCounts[DICT.ptype[C.ptype[i]]] || 0) + 1;
  DICT.ptype.slice().sort(function (a, b) { return typeCounts[b] - typeCounts[a]; }).forEach(function (t) {
    var o = document.createElement('option');
    o.value = t; o.textContent = t;
    tsel.appendChild(o);
  });
  tsel.addEventListener('change', function () { state.ptype = tsel.value; refresh(); });

  var bh = $('fBands');
  BANDS.forEach(function (b) {
    var btn = el('button', 'chip', b.label);
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', function () {
      if (state.bands[b.key]) delete state.bands[b.key]; else state.bands[b.key] = true;
      btn.setAttribute('aria-pressed', state.bands[b.key] ? 'true' : 'false');
      refresh();
    });
    bh.appendChild(btn);
  });

  function toggle(id, key) {
    var btn = $(id);
    btn.addEventListener('click', function () {
      state[key] = !state[key];
      btn.setAttribute('aria-pressed', state[key] ? 'true' : 'false');
      refresh();
    });
  }
  toggle('fSearch', 'search');

  // New build cycles all -> only -> exclude. aria-pressed cannot express three
  // states, so the label carries it and aria-pressed tracks "is filtering".
  var nb = $('fNew');
  function paintNewBuild() {
    nb.textContent = state.newBuild === 1 ? 'New build only'
                   : state.newBuild === -1 ? 'Excluding new build' : 'New build';
    nb.setAttribute('aria-pressed', state.newBuild ? 'true' : 'false');
  }
  nb.addEventListener('click', function () {
    state.newBuild = state.newBuild === 0 ? 1 : (state.newBuild === 1 ? -1 : 0);
    paintNewBuild();
    refresh();
  });
  PAINT_NEW_BUILD = paintNewBuild;
  paintNewBuild();

  var yf = $('yrFrom'), yt = $('yrTo');
  yf.max = yt.max = LAST_YEAR;
  yf.value = state.y0; yt.value = state.y1;
  function yearChanged() {
    var a = +yf.value, b = +yt.value;
    if (a > b) { if (this === yf) { b = a; yt.value = b; } else { a = b; yf.value = a; } }
    state.y0 = a; state.y1 = b;
    $('yrFromV').textContent = a;
    $('yrToV').textContent = b;
    refresh();
  }
  yf.addEventListener('input', yearChanged);
  yt.addEventListener('input', yearChanged);

  $('reset').addEventListener('click', function () {
    state.y0 = BASE_YEAR; state.y1 = LAST_YEAR;
    state.county = ''; state.district = ''; state.village = ''; state.area = null;
    state.ptype = ''; state.bands = {};
    state.search = false; state.newBuild = 0; state.grain = 'zone';
    state.mapSel = null; state.salesQuery = ''; state.salesLimit = 400;
    state.todayMoney = false; state.repeatOnly = false; state.openHistory = null;
    $('fToday').setAttribute('aria-pressed', 'false');
    $('fRepeat').setAttribute('aria-pressed', 'false');
    yf.value = BASE_YEAR; yt.value = LAST_YEAR;
    $('yrFromV').textContent = BASE_YEAR; $('yrToV').textContent = LAST_YEAR;
    csel.value = ''; tsel.value = ''; $('fVillage').value = '';
    rebuildDistrictOptions();
    $('salesSearch').value = '';
    var chips = $('fBands').querySelectorAll('.chip');
    for (var k = 0; k < chips.length; k++) chips[k].setAttribute('aria-pressed', 'false');
    $('fSearch').setAttribute('aria-pressed', 'false');
    if (PAINT_NEW_BUILD) PAINT_NEW_BUILD();
    refresh();
  });

  var tabs = document.querySelectorAll('.tab');
  for (var t = 0; t < tabs.length; t++) {
    (function (tab) {
      tab.addEventListener('click', function () {
        state.view = tab.dataset.view;
        writeUrlState();
        for (var k = 0; k < tabs.length; k++) tabs[k].setAttribute('aria-selected', tabs[k] === tab ? 'true' : 'false');
        showView();
      });
    })(tabs[t]);
  }

  // hover / focus explanations for the controls that need one
  bindHelp($('sliceCount'), 'slice');
  bindHelp($('fSearch'), 'search');
  bindHelp($('fNew'), 'newBuild');
  bindHelp($('fCounty'), 'county');
  bindHelp($('fDistrict'), 'district');
  bindHelp($('fVillage'), 'village');
  bindHelp($('fType'), 'ptype');
  bindHelp($('fBands'), 'bands');
  bindHelp(document.querySelector('.ctl.range .ctl-label'), 'years');
  // the group labels are the obvious thing to point at, so make them work too
  var labels = document.querySelectorAll('#controls .ctl-label');
  for (var li = 0; li < labels.length; li++) {
    var txt = labels[li].textContent.trim().toLowerCase();
    if (txt === 'county') bindHelp(labels[li], 'county');
    else if (txt === 'district') bindHelp(labels[li], 'district');
    else if (txt === 'village') bindHelp(labels[li], 'village');
    else if (txt === 'type') bindHelp(labels[li], 'ptype');
    else if (txt === 'band') bindHelp(labels[li], 'bands');
  }

  var vsel = $('fVillage');
  var villageTimer = null;
  vsel.addEventListener('input', function () {
    openAreaMenu(vsel.value);
    clearTimeout(villageTimer);
    villageTimer = setTimeout(function () {
      var typed = vsel.value.trim();
      var exact = AREA_INDEX[typed.toLowerCase()];
      if (exact) {
        // an exact hit scopes cleanly to that one area rather than pooling
        // every settlement whose name merely contains the text
        state.area = { kind: exact.kind, name: exact.name };
        state.village = '';
        if (state.grain === exact.kind) state.grain = 'settlement';
      } else {
        state.area = null;
        state.village = typed.toLowerCase();
      }
      refresh();
    }, 220);
  });
  vsel.addEventListener('focus', function () { openAreaMenu(vsel.value); });
  vsel.addEventListener('blur', function () { setTimeout(closeAreaMenu, 120); });
  vsel.addEventListener('keydown', function (ev) {
    var menu = $('areaMenu');
    var opts = menu.querySelectorAll('.area-opt');
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (menu.hidden) { openAreaMenu(vsel.value); return; }
      ev.preventDefault();
      var next = areaHi + (ev.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) next = opts.length - 1;
      if (next >= opts.length) next = 0;
      setAreaHi(next);
    } else if (ev.key === 'Enter') {
      if (!menu.hidden && areaHi >= 0 && opts[areaHi]) { ev.preventDefault(); opts[areaHi].dispatchEvent(new MouseEvent('mousedown')); }
      else closeAreaMenu();
    } else if (ev.key === 'Escape') {
      closeAreaMenu();
    }
  });

  $('dlCsv').addEventListener('click', downloadCsv);
  var todayBtn = $('fToday');
  todayBtn.addEventListener('click', function () {
    state.todayMoney = !state.todayMoney;
    todayBtn.setAttribute('aria-pressed', state.todayMoney ? 'true' : 'false');
    writeUrlState();
    renderSales();
  });
  var repeatBtn = $('fRepeat');
  repeatBtn.addEventListener('click', function () {
    state.repeatOnly = !state.repeatOnly;
    repeatBtn.setAttribute('aria-pressed', state.repeatOnly ? 'true' : 'false');
    state.salesLimit = 400;
    writeUrlState();
    renderSales();
  });

  var search = $('salesSearch');
  var searchTimer = null;
  search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.salesQuery = search.value; renderSales(); }, 160);
  });
}

// ------------------------------------------------------- export + URL state

// The end product of this tool is a list of specific sold prices you can name
// in a conversation. Export the WHOLE filtered set, not the rows on screen.
function downloadCsv() {
  var head = ['date', 'price', 'address', 'settlement', 'street', 'postcode_district', 'postcode_sector',
              'settlement_zone', 'district', 'county', 'property_type', 'new_build',
              'in_search_geography', 'land_registry_url'];
  if (state.todayMoney) head.splice(2, 0, 'price_in_' + RSI.years[RSI.years.length - 1] + '_money');
  var lastY = RSI.years[RSI.years.length - 1];
  var q = function (v) {
    v = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  var lines = [head.join(',')];
  for (var k = 0; k < slice.length; k++) {
    var i = slice[k];
    var mo = C.date[i], y = yearOf(mo), mth = (mo % 12) + 1;
    var iso = y + '-' + (mth < 10 ? '0' : '') + mth + '-' + (C.day[i] < 10 ? '0' : '') + C.day[i];
    var row = [iso, C.price[i]];
    if (state.todayMoney) {
      var f = RSI.factor(y, lastY);
      row.push(f === null ? '' : Math.round(C.price[i] * f / 10000) * 10000);
    }
    row = row.concat([
      C.address[i], DICT.settlement[C.settlement[i]], DICT.street[C.street[i]],
      DICT.pcd[C.pcd[i]], DICT.sector[C.sector[i]], DICT.zone[C.zone[i]],
      DICT.district[C.district[i]], COUNTY_OF[DICT.district[C.district[i]]] || '',
      DICT.ptype[C.ptype[i]], (C.flags[i] & F_NEW) ? 'yes' : 'no',
      (C.flags[i] & F_SEARCH) ? 'yes' : 'no',
      'http://landregistry.data.gov.uk/data/ppi/transaction/' + C.txn[i] + '/current'
    ]);
    lines.push(row.map(q).join(','));
  }
  var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'east-midlands-550k-' + fmtInt(slice.length).replace(/,/g, '') + '-sales.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

// Serialise the filter state into the URL so a reload, a bookmark or a link
// reproduces exactly this view. Over weeks of a search, "is this week's reading
// comparable to last week's" matters more than it sounds: a one-year shift in
// the year slider changes which villages clear the sample threshold.
var STATE_KEYS = ['y0', 'y1', 'county', 'district', 'village', 'ptype', 'search',
                  'newBuild', 'view', 'grain', 'mapMetric', 'todayMoney', 'repeatOnly'];
var restoringState = false;
function writeUrlState() {
  if (restoringState) return;
  var parts = [];
  STATE_KEYS.forEach(function (k) {
    var v = state[k];
    if (v === '' || v === false || v === null || v === undefined) return;
    if (k === 'newBuild' && v === 0) return;
    if (k === 'y0' && v === BASE_YEAR) return;
    if (k === 'y1' && v === LAST_YEAR) return;
    if (k === 'view' && v === 'pulse') return;
    if (k === 'grain' && v === 'zone') return;
    if (k === 'mapMetric' && v === 'volume') return;
    parts.push(k + '=' + encodeURIComponent(v));
  });
  if (state.area) parts.push('area=' + encodeURIComponent(state.area.kind + '~' + state.area.name));
  var bands = Object.keys(state.bands);
  if (bands.length) parts.push('bands=' + encodeURIComponent(bands.join(',')));
  var hash = parts.length ? '#' + parts.join('&') : '';
  try {
    history.replaceState(null, '', location.pathname + location.search + hash);
  } catch (e) {
    // file:// refuses replaceState; assigning the hash still works there
    if (location.hash !== hash) location.hash = hash;
  }
}
function readUrlState() {
  var h = location.hash.replace(/^#/, '');
  if (!h) return false;
  restoringState = true;
  h.split('&').forEach(function (pair) {
    var eq = pair.indexOf('=');
    if (eq < 0) return;
    var k = pair.slice(0, eq), v = decodeURIComponent(pair.slice(eq + 1));
    if (k === 'bands') { state.bands = {}; v.split(',').forEach(function (b) { state.bands[b] = true; }); return; }
    if (k === 'area') {
      var t = v.split('~');
      if (t.length === 2) state.area = { kind: t[0], name: t[1] };
      return;
    }
    if (STATE_KEYS.indexOf(k) < 0) return;
    if (k === 'y0' || k === 'y1' || k === 'newBuild') state[k] = parseInt(v, 10) || 0;
    else if (k === 'search' || k === 'todayMoney' || k === 'repeatOnly') state[k] = (v === 'true' || v === '1');
    else state[k] = v;
  });
  restoringState = false;
  return true;
}

// Push a restored-from-URL state back into the controls, so the widgets agree
// with what the charts are showing.
function syncControlsFromState() {
  $('yrFrom').value = state.y0; $('yrTo').value = state.y1;
  $('yrFromV').textContent = state.y0; $('yrToV').textContent = state.y1;
  $('fCounty').value = state.county;
  rebuildDistrictOptions();
  $('fType').value = state.ptype;
  $('fVillage').value = state.area ? state.area.name : state.village;
  $('fSearch').setAttribute('aria-pressed', state.search ? 'true' : 'false');
  $('fToday').setAttribute('aria-pressed', state.todayMoney ? 'true' : 'false');
  $('fRepeat').setAttribute('aria-pressed', state.repeatOnly ? 'true' : 'false');
  if (PAINT_NEW_BUILD) PAINT_NEW_BUILD();
  var chips = $('fBands').querySelectorAll('.chip');
  for (var k = 0; k < chips.length; k++) {
    chips[k].setAttribute('aria-pressed', state.bands[BANDS[k].key] ? 'true' : 'false');
  }
  var tabs = document.querySelectorAll('.tab');
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].setAttribute('aria-selected', tabs[t].dataset.view === state.view ? 'true' : 'false');
  }
  ['pulse', 'map', 'momentum', 'value', 'rhythm', 'sales'].forEach(function (v) {
    $('v-' + v).hidden = v !== state.view;
  });
}

function showView() {
  ['pulse', 'map', 'momentum', 'value', 'rhythm', 'sales'].forEach(function (v) {
    $('v-' + v).hidden = v !== state.view;
  });
  renderActive();
}

function renderActive() {
  // a re-render removes whatever mark the pointer was over, so its pointerleave
  // never arrives and the tooltip would hang around over the new chart
  tipHide();
  if (state.view === 'pulse') renderPulse();
  else if (state.view === 'map') renderMap();
  else if (state.view === 'momentum') renderMomentum();
  else if (state.view === 'value') renderValue();
  else if (state.view === 'rhythm') renderRhythm();
  else if (state.view === 'sales') renderSales();
  buildTableTwins();
}

// The village suggestions list only offers villages that exist under the other
// filters, so it can never suggest something that returns nothing. Rebuilt only
// when one of those filters actually changes — 700-odd nodes per keystroke would
// be wasteful.
var villageSig = null;
var AREA_ENTRIES = [];
function rebuildVillageList() {
  var sig = [state.y0, state.y1, state.county, state.district, state.ptype,
             state.search, state.newBuild, Object.keys(state.bands).sort().join()].join('|');
  if (sig === villageSig) return;
  villageSig = sig;

  // one list across villages, zones, postcode districts and sectors, so a single
  // box scopes to any of the units the charts actually aggregate by
  var counts = {}, settleHome = {};
  for (var i = 0; i < N; i++) {
    if (!passes(i, true)) continue;
    for (var k = 0; k < AREA_KINDS.length; k++) {
      var kind = AREA_KINDS[k].kind, nm = areaValue(kind, i);
      if (!nm || nm === '—') continue;
      if (!counts[kind]) counts[kind] = {};
      counts[kind][nm] = (counts[kind][nm] || 0) + 1;
    }
    var sn = DICT.settlement[C.settlement[i]];
    if (!settleHome[sn]) settleHome[sn] = { d: DICT.district[C.district[i]], z: DICT.zone[C.zone[i]] };
  }
  // keyed by kind then name, so an area name containing a space or any
  // separator character cannot corrupt the lookup
  var entries = [];
  Object.keys(counts).forEach(function (kind) {
    Object.keys(counts[kind]).forEach(function (nm) {
      entries.push({ kind: kind, name: nm, n: counts[kind][nm] });
    });
  });
  entries.sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });

  AREA_INDEX = {};
  AREA_ENTRIES = [];
  entries.forEach(function (e) {
    if (e.kind === 'zone') {
      // A zone holding exactly one settlement is that settlement under another
      // name — "Louth Town" and "Louth" are the same 73 sales. Offering both
      // just asks the reader to pick between identical things.
      var mk = zoneMakeup(e.name, null, 4);
      if (mk.names.length === 1) return;
      e.sub = 'covers ' + mk.text;
    } else if (e.kind === 'sector') {
      e.sub = 'part of postcode district ' + e.name.split(' ')[0];
    } else if (e.kind === 'pcd') {
      e.sub = 'postal area, may cross district lines';
    } else {
      var home = settleHome[e.name];
      if (home) {
        // naming the zone is only useful when it groups this village with others
        var zm = zoneMakeup(home.z, null, 2);
        e.sub = 'in ' + home.d + (zm.names.length > 1 ? ' · ' + home.z + ' zone' : '');
      } else e.sub = '';
    }
    var lower = e.name.toLowerCase();
    // first kind to claim a name wins the plain-text lookup; villages are first
    // in AREA_KINDS so "Oakham" resolves to the village, not a zone of that name
    if (!AREA_INDEX[lower]) AREA_INDEX[lower] = e;
    AREA_ENTRIES.push(e);
  });
}

// ---- the suggestion menu -------------------------------------------------
var areaHi = -1;
function areaMatches(q) {
  q = q.trim().toLowerCase();
  if (!q) return AREA_ENTRIES.slice(0, 40);
  var exact = [], starts = [], contains = [];
  for (var i = 0; i < AREA_ENTRIES.length; i++) {
    var e = AREA_ENTRIES[i], nm = e.name.toLowerCase();
    if (nm === q) { exact.push(e); continue; }
    var at = nm.indexOf(q);
    if (at === 0) starts.push(e);
    else if (at > 0) contains.push(e);
  }
  // typing "louth" wants Louth, not Louth Wolds — shortest name is the most
  // precise match, and only then does size decide
  starts.sort(function (a, b) { return a.name.length - b.name.length || b.n - a.n; });
  return exact.concat(starts, contains);
}
function closeAreaMenu() {
  var menu = $('areaMenu');
  menu.hidden = true;
  areaHi = -1;
  $('fVillage').setAttribute('aria-expanded', 'false');
}
function openAreaMenu(q) {
  var menu = $('areaMenu');
  var hits = areaMatches(q);
  clear(menu);
  if (!hits.length) {
    menu.appendChild(el('div', 'a-empty', 'No area matches “' + q + '” under the current filters.'));
  }
  hits.slice(0, 30).forEach(function (e, i) {
    var b = el('button', 'area-opt');
    b.type = 'button';
    b.setAttribute('role', 'option');
    var line = el('div');
    line.appendChild(el('span', 'a-name', e.name));
    line.appendChild(el('span', 'a-kind', areaKindLabel(e.kind)));
    b.appendChild(line);
    var sub = el('span', 'a-sub');
    sub.appendChild(el('span', 'a-n', fmtInt(e.n) + ' sale' + (e.n === 1 ? '' : 's')));
    if (e.sub) sub.appendChild(document.createTextNode(' · ' + e.sub));
    b.appendChild(sub);
    b.addEventListener('mousedown', function (ev) {
      ev.preventDefault();          // keep focus so blur does not race the click
      pickArea(e);
    });
    b.addEventListener('pointerenter', function () { setAreaHi(i); });
    menu.appendChild(b);
  });
  if (hits.length > 30) {
    menu.appendChild(el('div', 'a-more', fmtInt(hits.length - 30) + ' more — keep typing to narrow'));
  }
  menu.hidden = false;
  // the Area control sits near the right edge of the filter bar, so a
  // left-anchored menu runs off screen — flip it when it would
  menu.style.left = '0';
  menu.style.right = 'auto';
  var r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 10) {
    menu.style.left = 'auto';
    menu.style.right = '0';
  }
  areaHi = -1;
  $('fVillage').setAttribute('aria-expanded', 'true');
}
function setAreaHi(i) {
  var opts = $('areaMenu').querySelectorAll('.area-opt');
  for (var k = 0; k < opts.length; k++) opts[k].classList.toggle('on', k === i);
  areaHi = i;
  if (opts[i]) opts[i].scrollIntoView({ block: 'nearest' });
}
function pickArea(e) {
  $('fVillage').value = e.name;
  state.area = { kind: e.kind, name: e.name };
  state.village = '';
  if (state.grain === e.kind) state.grain = 'settlement';
  closeAreaMenu();
  refresh();
}

var AREA_INDEX = {};
var PAINT_NEW_BUILD = null;

function refresh() {
  rebuildSlice();
  rebuildVillageList();
  writeUrlState();
  var pct = (slice.length / N * 100).toFixed(0);
  var sc = $('sliceCount');
  clear(sc);
  var b = el('b', null, fmtInt(slice.length));
  sc.appendChild(b);
  sc.appendChild(document.createTextNode(' of ' + fmtInt(N) + ' home sales (' + pct + '%)'));
  // scoping to a zone that spans districts mixes places that are nowhere near
  // each other — "Town" pools Stamford with Skegness
  if (state.area && state.area.kind === 'zone') {
    var ds = zoneSpread(state.area.name);
    if (ds.length > 1) {
      var warn = el('span', null, ' · spans ' + ds.length + ' districts');
      warn.style.color = 'var(--accent)';
      warn.title = state.area.name + ' covers ' + zoneMakeup(state.area.name, null, 8).text +
                   ', across ' + ds.join(', ') + '. It is a classification, not one place.';
      warn.style.cursor = 'help';
      sc.appendChild(warn);
    }
  }
  renderActive();
}

var resizeTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderActive, 180);
});

// Exposed so the index can be audited from the console rather than taken on
// trust — EM_DEBUG.rsi.level is the full annual series.
window.EM_DEBUG = { rsi: RSI, state: state };

readUrlState();
initControls();
syncControlsFromState();
refresh();

})();
