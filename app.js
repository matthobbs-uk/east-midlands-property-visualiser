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
  return cand.filter(function (v) { return v >= lo && v <= hi; });
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
function yearTicks(years) {
  var first = years[0], last = years[years.length - 1];
  return years.filter(function (y) {
    if (y === first || y === last) return true;
    if (y % 3 !== 0) return false;
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
  ptype: '',
  bands: {},          // key -> true
  search: false,
  newBuild: false,
  view: 'pulse',
  mapMetric: 'volume',
  mapSel: null,
  grain: 'zone',      // zone | district for momentum + value
  salesSort: { col: 'date', dir: -1 },
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
  if (state.newBuild && !(C.flags[i] & F_NEW)) return false;
  if (state.county && COUNTY_OF[DICT.district[C.district[i]]] !== state.county) return false;
  if (state.district && DICT.district[C.district[i]] !== state.district) return false;
  if (state.ptype && DICT.ptype[C.ptype[i]] !== state.ptype) return false;
  if (state.village && !skipVillage &&
      DICT.settlement[C.settlement[i]].toLowerCase().indexOf(state.village) < 0) return false;
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

function keyFor(grain) {
  if (grain === 'district') return function (i) { return DICT.district[C.district[i]]; };
  if (grain === 'pcd') return function (i) { var v = DICT.pcd[C.pcd[i]]; return v === '—' ? null : v; };
  if (grain === 'settlement') return function (i) { return DICT.settlement[C.settlement[i]]; };
  return function (i) { return DICT.zone[C.zone[i]]; };
}
function grainNoun(grain, plural) {
  var m = { district: 'district', zone: 'settlement zone', pcd: 'postcode district', settlement: 'village' };
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
  if (!win) return { win: null, rows: [] };
  var kf = keyFor(grain);
  var g = groupBy(slice, kf);
  var rows = [];
  Object.keys(g).forEach(function (name) {
    var idx = g[name];
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
  return { win: win, rows: rows };
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
    win && priorP.length ? deltaText(median(recentP), median(priorP), true, winLabel) : null, yearCounts, years, 'median');
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

  drawWave();
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
    if (delta.dir === 1) d.className = 'delta delta-up';
    if (delta.dir === -1) d.className = 'delta delta-down';
    d.textContent = (delta.dir === 1 ? '▲ ' : delta.dir === -1 ? '▼ ' : '') + delta.txt;
    t.appendChild(d);
  }
  if (sparkVals && sparkVals.length > 1) t.appendChild(sparkline(sparkVals, 150, 26));
  host.appendChild(t);
}

function sparkline(vals, w, h, color) {
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

function emptyChart(m) {
  var t = el('div', 'empty', 'No sales match the current filters.');
  clear(m.host);
  m.host.appendChild(t);
  // drop the table twin too — it must never outlive the chart it mirrors
  delete TABLES[m.host.id];
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

  var ticks = yearTicks(rows.map(function (r) { return r.year; }))
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
  $('moversSub').textContent =
    'Change in the number of £550k+ sales, ' + monthLabel(w.recent0) + '–' + monthLabel(w.recent1) +
    ' against the ' + w.w + ' months before it. Settlement zones with at least ' + MIN_AREA_SALES +
    ' sales in the slice.';

  var sorted = mo.rows.slice().sort(function (a, b) { return b.volChange - a.volChange; });
  var top = sorted.slice(0, 6);
  var bot = sorted.slice(-6).reverse();
  var rows = top.concat(bot).filter(function (r, i, arr) {
    return arr.findIndex(function (x) { return x.name === r.name; }) === i;
  });

  var m = mount('moversChart', Math.max(200, rows.length * 26 + 40));
  var pad = { t: 8, r: 60, b: 24, l: 150 };
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
    g.appendChild(s('text', { class: 'lbl', x: pad.l - 12, y: yy + bh - 3, 'text-anchor': 'end' }, truncate(r.name, 22)));
    g.appendChild(s('text', {
      class: 'val', x: x(r.volChange) + (xw >= 0 ? 7 : -7), y: yy + bh - 3,
      'text-anchor': xw >= 0 ? 'start' : 'end'
    }, fmtPct(r.volChange, 0)));

    var hit = s('rect', { class: 'hit', x: pad.l - 145, y: pad.t + i * rowH, width: m.w - pad.l + 140, height: rowH, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: r.name,
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

  registerTable('moversChart', ['Settlement zone', 'District', 'Sales now', 'Sales before', 'Volume change', 'Median now'],
    sorted.map(function (r) {
      return [r.name, r.district, fmtInt(r.nRecent), fmtInt(r.nPrior), fmtPct(r.volChange, 0), fmtCompact(r.medRecent)];
    }));
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
    b.addEventListener('click', function () { state.mapMetric = mm.key; renderMap(); });
    chipHost.appendChild(b);
  });

  var mv = mapValues();
  var codes = Object.keys(mv.areas);
  var metric = state.mapMetric;

  var subs = {
    volume: 'Number of £550k+ sales recorded in each postcode district. Size of market, not price.',
    median: 'Median £550k+ sale price in each postcode district — a read on how deep the top end goes.',
    momentum: mv.win
      ? 'Change in sales count, ' + monthLabel(mv.win.recent0) + '–' + monthLabel(mv.win.recent1) +
        ' against the ' + mv.win.w + ' months before. Grey areas have too few sales to judge.'
      : 'Not enough history in this slice to measure momentum.',
    premium: 'Each area\'s median against the regional median of ' + fmtCompact(mv.regionMed) +
             '. Warm is dearer than the region, cool is cheaper.'
  };
  $('mapSub').textContent = subs[metric];

  // size the canvas to the region's own aspect so the map fills its column
  var availW = $('mapChart').clientWidth || 800;
  var mapH = Math.max(420, Math.min(780, Math.round(availW / MAPB.aspect)));
  var m = mount('mapChart', mapH);
  if (!codes.length) { emptyChart(m); clear($('mapRank')); return; }
  proj = buildProjection(m.w, mapH);

  // --- scale
  var valOf, colorOf, fmtV, stops;
  if (metric === 'volume' || metric === 'median') {
    valOf = function (a) { return metric === 'volume' ? a.n : a.med; };
    var vals = codes.map(function (c) { return valOf(mv.areas[c]); });
    var qb = quantileBins(vals, SEQ.slice(1), 6);
    colorOf = qb.colorOf;
    stops = qb.bins;
    fmtV = metric === 'volume' ? fmtInt : fmtCompact;
    scaleLegend('mapScale', stops, function (v) { return fmtV(v); }, 'six equal-sized groups of areas');
  } else {
    valOf = function (a) { return a[metric]; };
    var dv = codes.map(function (c) { return valOf(mv.areas[c]); }).filter(function (v) { return v !== null && isFinite(v); });
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

    var fill = a ? colorOf(valOf(a)) : '#191d23';
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
        if (a.premium !== null) rows.push({ k: 'vs region', v: fmtPct(a.premium, 0) });
        return { title: code + ' · ' + a.district, rows: rows, foot: 'Click to pin this area' };
      });
      path.addEventListener('pointerenter', function () { highlightArea(code, true); });
      path.addEventListener('pointerleave', function () { highlightArea(null, true); });
      path.addEventListener('click', function () {
        state.mapSel = state.mapSel === code ? null : code;
        renderMap();
      });
      if (state.mapSel === code) path.classList.add('sel');
      else if (state.mapSel) path.classList.add('dim');
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

  var ranked = codes.filter(function (c) { return valOf(mv.areas[c]) !== null; })
    .sort(function (a, b) { return valOf(mv.areas[b]) - valOf(mv.areas[a]); })
    .slice(0, 18);

  ranked.forEach(function (code, i) {
    var a = mv.areas[code];
    var row = el('div', 'rank-row');
    row.tabIndex = 0;
    if (state.mapSel === code) row.classList.add('hi');
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
    row.addEventListener('click', function () { state.mapSel = state.mapSel === code ? null : code; renderMap(); });
    rankHost.appendChild(row);
  });

  registerTable('mapChart',
    ['Postcode district', 'District', 'Sales', 'Median', 'Middle half', 'Momentum', 'vs region'],
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
        return {
          title: z.item.name,
          rows: [
            { k: 'Sales', v: fmtInt(z.item.value), color: col },
            { k: 'At £1m and over', v: z.item.prime.toFixed(1) + '%' },
            { k: 'Median', v: fmtMoney(z.item.med) },
            { k: 'Middle half', v: fmtCompact(z.item.stats.p25) + '–' + fmtCompact(z.item.stats.p75) },
            { k: 'Dearest sale', v: fmtCompact(z.item.stats.max) }
          ],
          foot: d.name
        };
      });
      rect.addEventListener('pointerenter', function () { rect.setAttribute('stroke', '#f4f2ee'); rect.setAttribute('stroke-width', 1.5); });
      rect.addEventListener('pointerleave', function () { rect.removeAttribute('stroke'); });
      g.appendChild(rect);
      if (z.w > 62 && z.h > 22) {
        g.appendChild(s('text', {
          x: z.x + 5, y: z.y + 14, 'font-size': 10, 'font-weight': 600,
          fill: inkOn(col), 'pointer-events': 'none'
        }, truncate(z.item.name, Math.floor((z.w - 8) / 5.6))));
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
  registerTable('treemap', ['Settlement zone', 'District', 'Sales', '£1m+ share', 'Median', 'Middle half', 'Dearest'], rows);
}

// ==========================================================================
// MOMENTUM
// ==========================================================================

var GRAINS = [['zone', 'Settlement zones'], ['district', 'Districts'],
              ['pcd', 'Postcode districts'], ['settlement', 'Villages']];

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
        onChange();
      });
      box.appendChild(b);
    });
    head.appendChild(box);
  }
  var chips = box.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
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
    'Each bubble is one ' + grainNoun(state.grain) + ', sized by how many £550k+ sales it has seen in the last ' +
    w.w + ' months (' + monthLabel(w.recent0) + '–' + monthLabel(w.recent1) + '). Right means more sales than the ' +
    w.w + ' months before; up means a higher median. Areas with fewer than ' + minSalesFor(state.grain) +
    ' sales in the slice are left out as too thin to read.'));
  mountGrainControl(sub.parentNode, renderMomentum);

  drawScatter(mo);
  drawMoversTable(mo);
  drawBump();
}

function drawScatter(mo) {
  var m = mount('scatter', 480);
  var rows = mo.rows;
  if (rows.length < 3) return emptyChart(m);
  var pad = { t: 20, r: 30, b: 46, l: 62 };

  var xMax = Math.max(20, Math.ceil(Math.max.apply(null, rows.map(function (r) { return Math.abs(r.volChange); })) / 10) * 10);
  var yMax = Math.max(10, Math.ceil(Math.max.apply(null, rows.map(function (r) { return Math.abs(r.medChange); })) / 5) * 5);
  var x = linear(-xMax, xMax, pad.l, m.w - pad.r);
  var y = linear(-yMax, yMax, m.h - pad.b, pad.t);
  var maxN = Math.max.apply(null, rows.map(function (r) { return r.nRecent; }));
  var rOf = function (n) { return 5 + 20 * Math.sqrt(n / maxN); };

  var g = s('g');
  // quadrant wash + grid
  g.appendChild(s('rect', { x: x(0), y: pad.t, width: m.w - pad.r - x(0), height: y(0) - pad.t, fill: '#e66767', opacity: 0.05 }));
  g.appendChild(s('rect', { x: pad.l, y: y(0), width: x(0) - pad.l, height: m.h - pad.b - y(0), fill: '#3987e5', opacity: 0.05 }));

  yAxis(g, y, niceTicks(-yMax, yMax, 5), pad.l, m.w - pad.r, function (v) { return fmtPct(v, 0); });
  niceTicks(-xMax, xMax, 6).forEach(function (t) {
    var xx = Math.round(x(t)) + 0.5;
    g.appendChild(s('line', { x1: xx, x2: xx, y1: pad.t, y2: m.h - pad.b, stroke: '#23272e' }));
    g.appendChild(s('text', { class: 'lbl', x: xx, y: m.h - pad.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: INK3 }, fmtPct(t, 0)));
  });
  g.appendChild(s('line', { x1: x(0), x2: x(0), y1: pad.t, y2: m.h - pad.b, stroke: '#2c313a', 'stroke-width': 1 }));
  g.appendChild(s('line', { x1: pad.l, x2: m.w - pad.r, y1: y(0), y2: y(0), stroke: '#2c313a', 'stroke-width': 1 }));

  g.appendChild(s('text', { class: 'lbl', x: m.w - pad.r, y: pad.t + 4, 'text-anchor': 'end', fill: '#e66767', 'font-weight': 650 }, 'Heating · more sales, higher prices'));
  g.appendChild(s('text', { class: 'lbl', x: pad.l, y: m.h - pad.b - 6, 'text-anchor': 'start', fill: '#7fb0ee', 'font-weight': 650 }, 'Cooling · fewer sales, softer prices'));
  g.appendChild(s('text', { class: 'lbl', x: m.w / 2, y: m.h - 10, 'text-anchor': 'middle' }, 'Change in number of sales'));
  g.appendChild(s('text', { class: 'lbl', x: -(m.h / 2), y: 14, transform: 'rotate(-90)', 'text-anchor': 'middle' }, 'Change in median price'));

  // draw big bubbles first so small ones stay clickable
  var ordered = rows.slice().sort(function (a, b) { return b.nRecent - a.nRecent; });
  ordered.forEach(function (r) {
    var cx = x(Math.max(-xMax, Math.min(xMax, r.volChange)));
    var cy = y(Math.max(-yMax, Math.min(yMax, r.medChange)));
    var sel = (state.district && r.district === state.district) || false;
    var col = sel ? ACCENT_UI : ACCENT;
    var c = s('circle', {
      cx: cx, cy: cy, r: rOf(r.nRecent),
      fill: col, 'fill-opacity': 0.28, stroke: col, 'stroke-width': 1.6, tabindex: 0
    });
    bindTip(c, function () {
      return {
        title: r.name,
        rows: [
          { k: 'Sales, last ' + mo.win.w + ' months', v: fmtInt(r.nRecent), color: col },
          { k: 'Previous ' + mo.win.w + ' months', v: fmtInt(r.nPrior) },
          { k: 'Volume change', v: fmtPct(r.volChange, 0) },
          { k: 'Median now', v: fmtMoney(r.medRecent) },
          { k: 'Median change', v: fmtPct(r.medChange) }
        ],
        foot: state.grain === 'district' ? null : r.district
      };
    });
    c.addEventListener('pointerenter', function () { c.setAttribute('fill-opacity', 0.55); });
    c.addEventListener('pointerleave', function () { c.setAttribute('fill-opacity', 0.28); });
    g.appendChild(c);
  });

  // direct-label the extremes only
  var extremes = rows.slice().sort(function (a, b) {
    return (Math.abs(b.volChange) + Math.abs(b.medChange) * 2) - (Math.abs(a.volChange) + Math.abs(a.medChange) * 2);
  }).slice(0, 9);
  var canLabel = labelPlacer(120, 15);
  extremes.forEach(function (r) {
    var cx = x(Math.max(-xMax, Math.min(xMax, r.volChange)));
    var cy = y(Math.max(-yMax, Math.min(yMax, r.medChange)));
    if (!canLabel(cx, cy)) return;
    var rr = rOf(r.nRecent);
    var right = cx < m.w / 2;
    g.appendChild(s('text', {
      class: 'lbl', x: cx + (right ? rr + 6 : -rr - 6), y: cy + 4,
      'text-anchor': right ? 'start' : 'end', fill: '#f4f2ee', 'font-size': 11.5, 'font-weight': 600,
      'pointer-events': 'none', 'paint-order': 'stroke', stroke: 'rgba(20,23,28,0.85)', 'stroke-width': 3
    }, truncate(r.name, 20)));
  });

  m.svg.appendChild(g);

  registerTable('scatter',
    [grainNoun(state.grain), 'Sales now', 'Sales before', 'Volume change', 'Median now', 'Median change'],
    rows.slice().sort(function (a, b) { return b.volChange - a.volChange; }).map(function (r) {
      return [r.name, fmtInt(r.nRecent), fmtInt(r.nPrior), fmtPct(r.volChange, 0), fmtMoney(r.medRecent), fmtPct(r.medChange)];
    }));
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
    tdName.appendChild(document.createTextNode(r.name));
    if (state.grain !== 'district') {
      var sm = el('small', null, ' · ' + r.district);
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
  var pad = { t: 18, r: 168, b: 30, l: 168 };
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
  yearTicks(years).forEach(function (yr) {
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
  if (!rows.length) return emptyChart(m);
  var pad = { t: 24, r: 84, b: 34, l: 172 };

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
  g.appendChild(s('text', { class: 'lbl', x: x(regionMed), y: pad.t - 10, 'text-anchor': 'middle', fill: ACCENT_UI, 'font-size': 10.5 }, 'region median ' + fmtCompact(regionMed)));

  rows.forEach(function (r, i) {
    var cy = pad.t + i * rowH + rowH / 2;
    g.appendChild(s('line', { x1: x(r.p10), x2: x(r.p90), y1: cy, y2: cy, stroke: MUTED, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    g.appendChild(s('path', { d: hBarPath(x(r.p25), cy - bh / 2, x(r.p75) - x(r.p25), bh, 3), fill: ACCENT, opacity: 0.55 }));
    g.appendChild(s('circle', { cx: x(r.med), cy: cy, r: 4.2, fill: ACCENT_UI, stroke: SURFACE, 'stroke-width': 2 }));
    g.appendChild(s('text', { class: 'lbl', x: pad.l - 12, y: cy + 4, 'text-anchor': 'end' }, truncate(r.name, 26)));
    g.appendChild(s('text', { class: 'val', x: m.w - pad.r + 10, y: cy + 4, 'text-anchor': 'start' }, fmtCompact(r.med)));

    var hit = s('rect', { class: 'hit', x: 0, y: pad.t + i * rowH, width: m.w, height: rowH, tabindex: 0 });
    bindTip(hit, function () {
      return {
        title: r.name,
        rows: [
          { k: 'Median', v: fmtMoney(r.med), color: ACCENT_UI },
          { k: 'Middle half', v: fmtMoney(r.p25) + ' – ' + fmtMoney(r.p75) },
          { k: '10th–90th', v: fmtCompact(r.p10) + ' – ' + fmtCompact(r.p90) },
          { k: 'Sales', v: fmtInt(r.n) },
          { k: 'vs region', v: fmtPct((r.med - regionMed) / regionMed * 100, 0) }
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

  registerTable('distChart', [grainNoun(state.grain), 'Sales', '10th', '25th', 'Median', '75th', '90th', 'Dearest'],
    all.slice().sort(function (a, b) { return b.med - a.med; }).map(function (r) {
      return [r.name, fmtInt(r.n), fmtCompact(r.p10), fmtCompact(r.p25), fmtMoney(r.med), fmtCompact(r.p75), fmtCompact(r.p90), fmtCompact(r.max)];
    }));
}

function drawPremium() {
  var rows = areaStats(state.grain);
  var regionMed = priceStats(slice).med;
  rows.forEach(function (r) { r.prem = (r.med - regionMed) / regionMed * 100; });
  rows.sort(function (a, b) { return b.prem - a.prem; });
  var show = rows.length > 16 ? rows.slice(0, 8).concat(rows.slice(-8)) : rows;

  $('premSub').textContent = 'Each ' + grainNoun(state.grain) + '\'s median against the regional median of ' +
    fmtCompact(regionMed) + '.' + (rows.length > 16 ? ' Showing the eight dearest and eight cheapest of ' + rows.length + '.' : '');

  var m = mount('premChart', Math.max(200, show.length * 24 + 34));
  if (!show.length) return emptyChart(m);
  var pad = { t: 8, r: 56, b: 22, l: 160 };
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
    g.appendChild(s('text', { class: 'lbl', x: pad.l - 12, y: yv + bh - 2, 'text-anchor': 'end' }, truncate(r.name, 24)));
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
          { k: 'vs region', v: fmtPct(r.prem, 0) },
          { k: 'Sales', v: fmtInt(r.n) }
        ],
        foot: state.grain === 'district' ? null : r.district
      };
    });
    g.appendChild(hit);
  });
  m.svg.appendChild(g);

  registerTable('premChart', [grainNoun(state.grain), 'Sales', 'Median', 'vs region'],
    rows.map(function (r) { return [r.name, fmtInt(r.n), fmtMoney(r.med), fmtPct(r.prem, 0)]; }));
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
      var n = counts[key] || 0;
      var col = future ? 'transparent' : rampColor(SEQ, n / maxV);
      var rect = s('rect', {
        x: pad.l + mm * cellW + 1, y: pad.t + ri * cellH + 1,
        width: cellW - 2, height: cellH - 2, rx: 3,
        fill: col, stroke: future ? '#1a1e25' : 'none', 'stroke-dasharray': future ? '2 2' : null,
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
            opacity: n / maxV > 0.12 ? 1 : 0.6
          }, String(n)));
        }
      }
    }
  });
  svg.appendChild(g);

  scaleLegend('heatScale', [0, 1, 2, 3, 4, 5, 6].map(function (i) {
    return { lo: Math.round(maxV * i / 6), hi: Math.round(maxV * (i + 1) / 6), color: SEQ[i] };
  }), function (v) { return fmtInt(v); }, 'sales in the month');

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

  var LIMIT = 400;
  var shown = rows.slice(0, LIMIT);
  $('salesSub').textContent = 'Showing ' + fmtInt(shown.length) + ' of ' + fmtInt(rows.length) +
    ' sales in the current slice, newest first by default. Click a column head to sort; click a row to open the Land Registry record.';

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
  shown.forEach(function (i) {
    var row = el('tr');
    row.style.cursor = 'pointer';
    row.title = 'Open the Land Registry record';
    row.addEventListener('click', function () {
      window.open('http://landregistry.data.gov.uk/data/ppi/transaction/' + C.txn[i] + '/current', '_blank', 'noopener');
    });
    var mo = C.date[i];
    row.appendChild(el('td', null, MONTHS[mo % 12] + ' ' + yearOf(mo)));
    var tdP = el('td', null, fmtMoney(C.price[i]));
    tdP.style.color = 'var(--ink)';
    tdP.style.fontWeight = '650';
    row.appendChild(tdP);
    row.appendChild(el('td', 'addr', C.address[i]));
    row.appendChild(el('td', null, DICT.ptype[C.ptype[i]] + ((C.flags[i] & F_NEW) ? ' · new' : '')));
    row.appendChild(el('td', null, DICT.zone[C.zone[i]]));
    row.appendChild(el('td', null, DICT.district[C.district[i]]));
    row.appendChild(el('td', null, DICT.pcd[C.pcd[i]]));
    tb.appendChild(row);
  });
  tbl.appendChild(tb);
  host.appendChild(tbl);
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
  toggle('fNew', 'newBuild');

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
    state.county = ''; state.district = ''; state.village = ''; state.ptype = ''; state.bands = {};
    state.search = false; state.newBuild = false;
    state.mapSel = null; state.salesQuery = '';
    yf.value = BASE_YEAR; yt.value = LAST_YEAR;
    $('yrFromV').textContent = BASE_YEAR; $('yrToV').textContent = LAST_YEAR;
    csel.value = ''; tsel.value = ''; $('fVillage').value = '';
    rebuildDistrictOptions();
    $('salesSearch').value = '';
    var chips = $('fBands').querySelectorAll('.chip');
    for (var k = 0; k < chips.length; k++) chips[k].setAttribute('aria-pressed', 'false');
    $('fSearch').setAttribute('aria-pressed', 'false');
    $('fNew').setAttribute('aria-pressed', 'false');
    refresh();
  });

  var tabs = document.querySelectorAll('.tab');
  for (var t = 0; t < tabs.length; t++) {
    (function (tab) {
      tab.addEventListener('click', function () {
        state.view = tab.dataset.view;
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
    clearTimeout(villageTimer);
    villageTimer = setTimeout(function () {
      state.village = vsel.value.trim().toLowerCase();
      refresh();
    }, 180);
  });

  var search = $('salesSearch');
  var searchTimer = null;
  search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.salesQuery = search.value; renderSales(); }, 160);
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
function rebuildVillageList() {
  var sig = [state.y0, state.y1, state.county, state.district, state.ptype,
             state.search, state.newBuild, Object.keys(state.bands).sort().join()].join('|');
  if (sig === villageSig) return;
  villageSig = sig;

  var counts = {};
  for (var i = 0; i < N; i++) {
    if (!passes(i, true)) continue;
    var nm = DICT.settlement[C.settlement[i]];
    counts[nm] = (counts[nm] || 0) + 1;
  }
  var names = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a] || a.localeCompare(b);
  });

  var list = $('villageList');
  clear(list);
  names.forEach(function (nm) {
    var o = document.createElement('option');
    o.value = nm;
    o.label = nm + ' — ' + counts[nm] + ' sale' + (counts[nm] === 1 ? '' : 's');
    list.appendChild(o);
  });
}

function refresh() {
  rebuildSlice();
  rebuildVillageList();
  var pct = (slice.length / N * 100).toFixed(0);
  var sc = $('sliceCount');
  clear(sc);
  var b = el('b', null, fmtInt(slice.length));
  sc.appendChild(b);
  sc.appendChild(document.createTextNode(' of ' + fmtInt(N) + ' home sales (' + pct + '%)'));
  renderActive();
}

var resizeTimer = null;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderActive, 180);
});

initControls();
refresh();

})();
