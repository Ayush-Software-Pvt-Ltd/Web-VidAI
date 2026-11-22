/* Apna Trader design kit helpers (1920x1080 layout). Deterministic: seeded RNG only, no clocks. */
window.AT = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const C = { ink: "#070b14", deep: "#0d1424", line: "#1c2740", bull: "#1fd17a", bear: "#ff4757",
    gold: "#ffc531", sky: "#4da3ff", white: "#ffffff", steel: "#8a96ad" };

  // mulberry32 seeded random
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function div(cls, parent) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    if (parent) parent.appendChild(d);
    return d;
  }

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // A random-walk OHLC series: n candles starting at `start`, seeded. trend > 0 drifts up.
  function series(n, opts) {
    const o = Object.assign({ seed: 3, start: 100, vol: 2.2, trend: 0 }, opts || {});
    const r = rng(o.seed);
    const out = [];
    let p = o.start;
    for (let i = 0; i < n; i++) {
      const open = p;
      const close = open + (r() - 0.5) * 2 * o.vol + o.trend;
      const high = Math.max(open, close) + r() * o.vol * 0.8;
      const low = Math.min(open, close) - r() * o.vol * 0.8;
      out.push({ o: open, h: high, l: low, c: close });
      p = close;
    }
    return out;
  }

  // Candlestick chart as an <svg> of size w x h appended to `host` at (x, y).
  // data: array of {o,h,l,c}. Returns { svg, candles: [g...], yOf(price) }.
  // Animate `candles` (e.g. stagger scaleY from 0) to draw it in.
  function candles(host, data, x, y, w, h, opts) {
    const o = Object.assign({ gap: 0.35, pad: 0.08, wick: 3 }, opts || {});
    const svg = svgEl("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h });
    svg.style.cssText = "position:absolute;left:" + x + "px;top:" + y + "px;overflow:visible;";
    host.appendChild(svg);
    let lo = Infinity, hi = -Infinity;
    data.forEach(function (d) { lo = Math.min(lo, d.l); hi = Math.max(hi, d.h); });
    const span = (hi - lo) || 1;
    const yOf = function (p) { return h * o.pad + (h * (1 - 2 * o.pad)) * (1 - (p - lo) / span); };
    const step = w / data.length;
    const bw = step * (1 - o.gap);
    const gs = data.map(function (d, i) {
      const up = d.c >= d.o;
      const col = up ? C.bull : C.bear;
      const cx = step * i + step / 2;
      const g = svgEl("g", {}, svg);
      svgEl("line", { x1: cx, x2: cx, y1: yOf(d.h), y2: yOf(d.l), stroke: col, "stroke-width": o.wick, "stroke-linecap": "round" }, g);
      const top = yOf(Math.max(d.o, d.c));
      const bh = Math.max(3, Math.abs(yOf(d.o) - yOf(d.c)));
      svgEl("rect", { x: cx - bw / 2, y: top, width: bw, height: bh, rx: Math.min(4, bw / 4), fill: col }, g);
      g.cx = cx;
      g.mid = (yOf(d.h) + yOf(d.l)) / 2;
      return g;
    });
    return { svg: svg, candles: gs, yOf: yOf, step: step };
  }

  // Draw candles in left to right (scale from their middle), starting at `at`, over `dur`.
  function drawCandles(tl, chart, at, dur) {
    const n = chart.candles.length;
    chart.candles.forEach(function (g, i) {
      const origin = g.cx + " " + g.mid;          // same origin in from and to, or GSAP shifts the candle
      tl.fromTo(g, { opacity: 0, scaleY: 0.1, svgOrigin: origin },
        { opacity: 1, scaleY: 1, duration: 0.22, ease: "power2.out", svgOrigin: origin },
        at + (dur * i) / Math.max(1, n));
    });
  }

  // Moving background inside `host`, animated for `dur` seconds: drifting grid, green and
  // red glows, and a faint candlestick tape scrolling right to left behind everything.
  // opts: { seed, tape (true), glow (true) }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 11, tape: true, glow: true }, opts || {});
    const wrap = div("at-bg");
    const grid = div("at-grid", wrap);
    grid.setAttribute("data-layout-allow-overflow", "");
    let gg = null, gr = null;
    if (o.glow) {
      gg = div("at-glow at-glow-g", wrap);
      gr = div("at-glow at-glow-r", wrap);
      [gg, gr].forEach(function (g) { g.setAttribute("data-layout-allow-overflow", ""); });
    }
    let tape = null;
    if (o.tape) {
      tape = div("at-tape", wrap);
      tape.setAttribute("data-layout-allow-overflow", "");
      const n = 64;
      const w = 2880;
      tape.style.width = w + "px";
      candles(tape, series(n, { seed: o.seed, start: 100, vol: 2.4, trend: 0.15 }), 0, 330, w, 520, { gap: 0.45 });
    }
    div("at-vignette", wrap);
    host.insertBefore(wrap, host.firstChild);
    tl.fromTo(grid, { x: 0, y: 0 }, { x: -120, y: -60, duration: dur, ease: "none" }, 0);
    if (gg) {
      tl.fromTo(gg, { x: -60, y: -30, scale: 1 }, { x: 80, y: 60, scale: 1.12, duration: dur, ease: "sine.inOut" }, 0);
      tl.fromTo(gr, { x: 50, y: 20, scale: 1.08 }, { x: -70, y: -40, scale: 0.96, duration: dur, ease: "sine.inOut" }, 0);
    }
    if (tape) tl.fromTo(tape, { x: 0 }, { x: -60 * dur, duration: dur, ease: "none" }, 0);
    return wrap;
  }

  // Slow push-in on a camera wrapper for the whole duration.
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.05, duration: dur, ease: "none", transformOrigin: "50% 50%" }, 0);
  }

  // Shrink an element's font-size until it fits maxW x maxH. Use on inline-block / inline-flex
  // elements (measures scrollWidth / scrollHeight, so matras count).
  function fit(el, maxW, maxH, minPx) {
    let px = parseFloat(getComputedStyle(el).fontSize);
    const floor = minPx || 36;
    while (px > floor && (el.scrollWidth > maxW || (maxH && el.scrollHeight > maxH))) {
      px -= 2;
      el.style.fontSize = px + "px";
    }
    return px;
  }

  // Split an element's text into inline-block word spans (for word-by-word entrances).
  // Colour words AFTER splitting (the text is rebuilt).
  function words(el) {
    const parts = el.textContent.trim().split(/\s+/);
    el.textContent = "";
    return parts.map(function (w, i) {
      const s = document.createElement("span");
      s.textContent = w;
      s.style.display = "inline-block";
      el.appendChild(s);
      if (i < parts.length - 1) el.appendChild(document.createTextNode(" "));
      return s;
    });
  }

  // Indian digit grouping: 158460 -> "1,58,460".
  function inr(n, decimals) {
    const neg = n < 0;
    const fixed = Math.abs(n).toFixed(decimals || 0);
    const parts = fixed.split(".");
    const s = parts[0];
    let out = s;
    if (s.length > 3) {
      out = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
    }
    return (neg ? "-" : "") + out + (parts[1] ? "." + parts[1] : "");
  }

  // Count a number inside `el` from `from` to `to` (formatter optional, default Indian grouping).
  function count(tl, el, from, to, at, dur, fmt) {
    const o = { v: from };
    const f = fmt || function (v) { return inr(v); };
    el.textContent = f(from);
    tl.to(o, { v: to, duration: dur, ease: "power2.out", onUpdate: function () { el.textContent = f(o.v); } }, at);
    return o;
  }

  // Wait for every kit font weight (JS-built text may need weights document.fonts.ready skips).
  function fonts() {
    return Promise.all(["500 60px Hind", "600 60px Hind", "700 60px Hind", "600 60px Rajdhani", "700 60px Rajdhani"]
      .map(function (f) { return document.fonts.load(f); })).then(function () { return document.fonts.ready; });
  }

  return { C: C, rng: rng, div: div, svgEl: svgEl, series: series, candles: candles, drawCandles: drawCandles,
    bg: bg, push: push, fit: fit, words: words, inr: inr, count: count, fonts: fonts };
})();
