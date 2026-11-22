/* Moi Phone PORTRAIT (9:16) design kit helpers.  Global `MP9`.  See README.md.
   Deterministic: seeded RNG only, no clocks.  Layout is 1080x1920.
   Everything on screen keeps moving to the last frame (slow drifts, no idle wobble loops). */
window.MP9 = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const C = { ink: "#0d1117", paper: "#f5f1e8", green: "#3be37a", amber: "#ffb547", red: "#ff6b6b", muted: "#a7b0ba" };

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
  function px(el, o) {
    Object.keys(o).forEach(function (k) { el.style[k] = (typeof o[k] === "number") ? (o[k] + "px") : o[k]; });
    return el;
  }
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }

  // Wait for every Mukta weight the kit uses (document.fonts.ready alone can resolve before a
  // weight used only by JS-built text has loaded), then resolve.  Use instead of fonts.ready.
  function ready() {
    const w = ["400", "600", "700", "800"];
    return Promise.all(w.map(function (x) { return document.fonts.load(x + " 100px Mukta", "अब India"); }))
      .then(function () { return document.fonts.ready; });
  }

  // Portrait ink background inside `host` (inserted as its first child), animated for `dur` s:
  // drifting green glow, a big ring outline with a green arc sweeping round it, slow-rising dots.
  // opts: { seed, ring, ringX, ringY, ringR, glowX, glowY, dots, arcSpeed (deg/s) }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, ring: true, ringX: 860, ringY: 1480, ringR: 560, glowX: 540, glowY: 820, dots: 14, arcSpeed: 60 }, opts || {});
    const r = rng(o.seed);
    const wrap = div("m9-bg");
    const glow = px(div("m9-glow", wrap), { left: o.glowX - 700, top: o.glowY - 700 });
    glow.setAttribute("data-layout-allow-overflow", "");
    let ring = null, arc = null;
    if (o.ring) {
      const S = 2 * o.ringR;
      ring = px(div("m9-ring", wrap), { left: o.ringX - o.ringR, top: o.ringY - o.ringR, width: S, height: S });
      ring.setAttribute("data-layout-allow-overflow", "");
      arc = svgEl("svg", { width: S, height: S, viewBox: "0 0 " + S + " " + S, class: "m9-arc", "data-layout-allow-overflow": "" }, wrap);
      px(arc, { left: o.ringX - o.ringR, top: o.ringY - o.ringR });
      const rr = o.ringR - 14;
      const len = 2 * Math.PI * rr;
      svgEl("circle", { cx: o.ringR, cy: o.ringR, r: rr, fill: "none", stroke: "rgba(59,227,122,0.38)", "stroke-width": 28, "stroke-linecap": "round", "stroke-dasharray": (len * 0.15) + " " + len }, arc);
    }
    const dots = [];
    for (let i = 0; i < o.dots; i++) {
      const size = 4 + Math.round(r() * 7);
      const d = px(div("m9-dot", wrap), { width: size, height: size, left: Math.round(70 + r() * 930), top: Math.round(520 + r() * 1300) });
      // rise is capped so a dot never leaves the frame, whatever the duration
      dots.push({ el: d, rise: Math.min(380, (40 + r() * 70) * dur / 3), op: 0.10 + r() * 0.30, drift: (r() - 0.5) * 50 });
    }
    host.insertBefore(wrap, host.firstChild);
    tl.fromTo(glow, { x: -50, y: -80, scale: 1 }, { x: 60, y: 90, scale: 1.14, duration: dur, ease: "sine.inOut" }, 0);
    if (ring) {
      tl.fromTo(ring, { scale: 0.96 }, { scale: 1.02, duration: dur, ease: "sine.inOut" }, 0);
      tl.fromTo(arc, { rotation: -120, scale: 0.96 }, { rotation: -120 + o.arcSpeed * dur, scale: 1.02, duration: dur, ease: "none" }, 0);
    }
    dots.forEach(function (d) {
      tl.fromTo(d.el, { y: 0, x: 0, opacity: d.op }, { y: -d.rise, x: d.drift, opacity: d.op * 0.5, duration: dur, ease: "none" }, 0);
    });
    return wrap;
  }

  // Slow push-in on a camera wrapper (.m9-cam) for the whole duration.
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.04, duration: dur, ease: "none", transformOrigin: "50% 50%" }, 0);
  }

  // Shrink an element's font-size (2 px steps) until it fits maxW x maxH.  Measures scrollWidth,
  // so use it on inline-block / inline-flex elements, or a block exactly maxW wide.
  function fit(el, maxW, maxH, minPx) {
    let p = parseFloat(getComputedStyle(el).fontSize);
    const floor = minPx || 40;
    while (p > floor && (el.scrollWidth > maxW || (maxH && el.scrollHeight > maxH))) {
      p -= 2;
      el.style.fontSize = p + "px";
    }
    return p;
  }

  // After wrapping (e.g. text-wrap: balance with a max-width), a block keeps the full max-width
  // and leaves empty space beside the lines.  Set its width to the widest rendered line.
  function shrinkWrap(el) {
    const rg = document.createRange();
    rg.selectNodeContents(el);
    let l = Infinity, r = -Infinity;
    Array.prototype.forEach.call(rg.getClientRects(), function (x) { if (x.width > 0) { l = Math.min(l, x.left); r = Math.max(r, x.right); } });
    if (r > l) el.style.width = Math.ceil(r - l + 2) + "px";
    return r - l;
  }

  // Split an element's text into inline-block word spans (for word-by-word entrances).
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

  // Fill `el` from text where *word* marks green words (spans with class m9-hl, or `cls`).
  // Safe: builds text nodes, never innerHTML.  Returns the highlighted spans.
  function rich(el, text, cls) {
    el.textContent = "";
    const hl = [];
    String(text).split(/(\*[^*]+\*)/).forEach(function (part) {
      if (!part) return;
      if (part[0] === "*" && part.length > 2) {
        const s = document.createElement("span");
        s.className = cls || "m9-hl";
        s.textContent = part.slice(1, -1);
        el.appendChild(s);
        hl.push(s);
      } else {
        el.appendChild(document.createTextNode(part.replace(/\*/g, "")));
      }
    });
    return hl;
  }

  // Count a number from `from` to `to` inside `el` between `at` and `at + dur`.
  function count(tl, el, from, to, at, dur, opts) {
    const o = Object.assign({ commas: true, decimals: 0, prefix: "", suffix: "" }, opts || {});
    const st = { v: from };
    const show = function () {
      const v = o.decimals ? st.v.toFixed(o.decimals) : Math.round(st.v);
      el.textContent = o.prefix + (o.commas ? Number(v).toLocaleString("en-IN") : String(v)) + o.suffix;
    };
    show();
    tl.fromTo(st, { v: from }, { v: to, duration: dur, ease: "power2.out", onUpdate: show }, at);
  }

  // Absolute placement shared by phone() and card(): left/top, or cx/cy (centre).
  function place(el, o, w, h) {
    if (o.cx != null) el.style.left = (o.cx - w / 2) + "px"; else if (o.left != null) el.style.left = o.left + "px";
    if (o.cy != null) el.style.top = (o.cy - h / 2) + "px"; else if (o.top != null) el.style.top = o.top + "px";
  }

  // A drawn modern iPhone front: titanium frame, black bezel, Dynamic Island, side button on the
  // right edge, action + volume buttons on the left.  Height = 2.05 x width.
  // opts: { width (px, default 460), left, top | cx, cy, screenBg, id }
  // Returns { el, screen, island, w, h }.  Fill `screen` (a flex column) with content or an <img>.
  function phone(host, opts) {
    const o = Object.assign({ width: 460, screenBg: "linear-gradient(180deg, #1b222d 0%, #0f141b 100%)" }, opts || {});
    const w = o.width, h = Math.round(w * 2.05);
    const el = px(div("m9-phone"), { width: w, height: h, borderRadius: Math.round(w * 0.165) });
    if (o.id) el.id = o.id;
    place(el, o, w, h);
    const f = Math.max(3, Math.round(w * 0.022));          // titanium thickness
    const b = Math.max(4, Math.round(w * 0.03));           // black bezel
    const bezel = px(div("m9-phone-bezel", el), { left: f, top: f, right: f, bottom: f, borderRadius: Math.round(w * 0.145) });
    const screen = px(div("m9-phone-screen", bezel), { left: b, top: b, right: b, bottom: b, borderRadius: Math.round(w * 0.12), background: o.screenBg });
    const iw = Math.round(w * 0.3), ih = Math.round(w * 0.088);
    const island = px(div("m9-phone-island", bezel), { width: iw, height: ih, top: b + Math.round(w * 0.035), left: Math.round((w - 2 * f - iw) / 2) });
    const bw = Math.max(3, Math.round(w * 0.014));
    const side = px(div("m9-phone-btn", el), { left: w - 1, top: Math.round(h * 0.25), width: bw, height: Math.round(h * 0.13) });
    const act = px(div("m9-phone-btn", el), { left: 1 - bw, top: Math.round(h * 0.17), width: bw, height: Math.round(h * 0.045) });
    const v1 = px(div("m9-phone-btn", el), { left: 1 - bw, top: Math.round(h * 0.25), width: bw, height: Math.round(h * 0.075) });
    const v2 = px(div("m9-phone-btn", el), { left: 1 - bw, top: Math.round(h * 0.345), width: bw, height: Math.round(h * 0.075) });
    [side, act, v1, v2].forEach(function (x) { x.setAttribute("data-layout-allow-overflow", ""); });
    host.appendChild(el);
    return { el: el, screen: screen, island: island, w: w, h: h };
  }

  // A drawn generic credit card (no real logos): rounded, gradient, gold chip, contactless mark,
  // label top-left, "•••• 5035" bottom-left, kind text bottom-right.  Height = width / 1.586.
  // opts: { width (default 520), left, top | cx, cy, label ("Axis Bank"), digits ("5035"),
  //         kind ("CREDIT"), colors ([c1, c2] gradient, default deep magenta to burgundy), id }
  // Returns { el, sheen, w, h }.  Sweep `sheen` with x (from -0.5w to 1.6w) for a glint.
  function card(host, opts) {
    const o = Object.assign({ width: 520, label: "Axis Bank", digits: "5035", kind: "CREDIT", colors: ["#9b1d55", "#4d0b2c"] }, opts || {});
    const w = o.width, h = Math.round(w / 1.586);
    const el = px(div("m9-card"), { width: w, height: h, borderRadius: Math.round(w * 0.055) });
    if (o.id) el.id = o.id;
    el.style.background =
      "radial-gradient(120% 90% at 100% 0%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 55%)," +
      "radial-gradient(90% 120% at 0% 100%, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 60%)," +
      "linear-gradient(135deg, " + o.colors[0] + " 0%, " + o.colors[1] + " 100%)";
    place(el, o, w, h);
    const pad = Math.round(w * 0.07);
    const label = px(div("m9-card-label", el), { left: pad, top: Math.round(pad * 0.7), fontSize: Math.round(w * 0.074) });
    label.textContent = o.label;
    const cl = icon("contactless", Math.round(w * 0.11), { color: C.paper, stroke: 5 });
    px(cl, { position: "absolute", right: pad, top: Math.round(pad * 0.85) });
    el.appendChild(cl);
    const cw = Math.round(w * 0.15), ch = Math.round(w * 0.115);
    const chip = px(div("m9-card-chip", el), { left: pad, top: Math.round(h * 0.38), width: cw, height: ch, borderRadius: Math.round(w * 0.018) });
    const cs = svgEl("svg", { width: cw, height: ch, viewBox: "0 0 30 23" }, chip);
    svgEl("path", { d: "M0 8H10M0 15H10M20 8H30M20 15H30M10 0V23M20 0V23M10 11.5H20", stroke: "rgba(90,60,10,0.55)", "stroke-width": 1.2, fill: "none" }, cs);
    const dg = px(div("m9-card-digits", el), { left: pad, bottom: Math.round(pad * 0.7), fontSize: Math.round(w * 0.068) });
    dg.textContent = "•••• " + o.digits;
    if (o.kind) {
      const k = px(div("m9-card-kind", el), { right: pad, bottom: Math.round(pad * 0.85), fontSize: Math.round(w * 0.04) });
      k.textContent = o.kind;
    }
    const sheen = px(div("m9-card-sheen", el), { left: 0 });
    sheen.setAttribute("data-layout-allow-overflow", "");
    host.appendChild(el);
    return { el: el, sheen: sheen, w: w, h: h };
  }

  // Inline SVG line icons on a 64x64 grid.  opts: { color (paper), accent (green), stroke (4) }.
  // Names: contactless faceid check cross plus wallet lock shield watch upi-off pos settings.
  // "contactless" arcs carry class m9-wave (4 of them, inner to outer) for MP9.waves().
  function icon(name, size, opts) {
    const o = Object.assign({ color: C.paper, accent: C.green, stroke: 4 }, opts || {});
    const s = svgEl("svg", { width: size, height: size, viewBox: "0 0 64 64", class: "m9-icon m9-icon-" + name, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" });
    const line = function (d, col, extra) { return svgEl("path", Object.assign({ d: d, stroke: col || o.color, "stroke-width": o.stroke, fill: "none" }, extra || {}), s); };
    const arc = function (cx, cy, r, a0, a1) {
      const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
      return "M" + p0[0].toFixed(2) + " " + p0[1].toFixed(2) + "A" + r + " " + r + " 0 0 1 " + p1[0].toFixed(2) + " " + p1[1].toFixed(2);
    };
    const A = Math.PI / 180;
    switch (name) {
      case "contactless":
        [8, 17, 26, 35].forEach(function (r, i) { line(arc(14, 32, r, -48 * A, 48 * A), i === 0 ? o.accent : o.color, { class: "m9-wave" }); });
        break;
      case "faceid":
        line("M6 20V12a6 6 0 0 1 6-6h8M44 6h8a6 6 0 0 1 6 6v8M58 44v8a6 6 0 0 1-6 6h-8M20 58h-8a6 6 0 0 1-6-6v-8");
        line("M22 24v6M42 24v6", o.accent);
        line("M32 24v12h-3", o.accent);
        line("M23 44q9 7 18 0", o.accent);
        break;
      case "check":
        line("M32 4a28 28 0 1 1 0 56a28 28 0 1 1 0-56", o.accent);
        line("M19 33l9 9l17-19", o.accent, { "stroke-width": o.stroke + 1.5 });
        break;
      case "cross":
        line("M32 4a28 28 0 1 1 0 56a28 28 0 1 1 0-56", C.red);
        line("M22 22l20 20M42 22l-20 20", C.red, { "stroke-width": o.stroke + 1.5 });
        break;
      case "plus":
        line("M32 4a28 28 0 1 1 0 56a28 28 0 1 1 0-56", o.accent);
        line("M32 20v24M20 32h24", o.accent, { "stroke-width": o.stroke + 1.5 });
        break;
      case "wallet":
        line("M18 21V9a3 3 0 0 1 3-3h22a3 3 0 0 1 3 3v12", o.accent);
        line("M13 22V16a3 3 0 0 1 3-3h32a3 3 0 0 1 3 3v6", C.amber);
        line("M10 26a4 4 0 0 1 4-4h36a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4z");
        line("M10 32h14q8 10 16 0h14");
        break;
      case "lock":
        line("M20 28V20a12 12 0 0 1 24 0v8");
        line("M14 28h36a2 2 0 0 1 2 2v24a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V30a2 2 0 0 1 2-2z");
        line("M32 38v8", o.accent, { "stroke-width": o.stroke + 1 });
        break;
      case "shield":
        line("M32 5l22 8v16c0 15-9 25-22 30C19 54 10 44 10 29V13z");
        line("M22 32l7 7l13-14", o.accent, { "stroke-width": o.stroke + 1 });
        break;
      case "watch":
        line("M23 14l2-10h14l2 10M23 50l2 10h14l2-10");
        line("M22 14h20a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H22a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z");
        line("M52 26v6", o.color, { "stroke-width": o.stroke + 1 });
        line("M32 24v8l6 4", o.accent);
        break;
      case "upi-off": {
        line("M8 18h48a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z");
        const t = svgEl("text", { x: 32, y: 40.5, "text-anchor": "middle", "font-family": "Mukta", "font-weight": 800, "font-size": 23, fill: o.color, stroke: "none", "letter-spacing": 1 }, s);
        t.textContent = "UPI";
        line("M8 54L56 10", C.ink, { "stroke-width": o.stroke + 3.5 });
        line("M8 54L56 10", C.red, { "stroke-width": o.stroke + 1 });
        break;
      }
      case "pos":
        line("M24 2h16v12H24z", o.accent);
        line("M16 10h32a4 4 0 0 1 4 4v42a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z");
        line("M19 18h26v12H19z");
        [38, 45, 52].forEach(function (y) { [22, 32, 42].forEach(function (x) { svgEl("circle", { cx: x, cy: y, r: 2.4, fill: o.color, stroke: "none" }, s); }); });
        break;
      case "settings": {
        let d = "";
        const n = 8, R = 27, r0 = 20;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * 2 * Math.PI, hw = 0.2;
          const pts = [[r0, a - 0.38], [R, a - hw], [R, a + hw], [r0, a + 0.38]];
          pts.forEach(function (p, j) {
            const x = 32 + p[0] * Math.cos(p[1]), y = 32 + p[0] * Math.sin(p[1]);
            d += ((i === 0 && j === 0) ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2);
          });
        }
        line(d + "Z");
        line("M32 23a9 9 0 1 1 0 18a9 9 0 1 1 0-18", o.accent);
        break;
      }
      default:
        throw new Error("MP9.icon: unknown icon " + name);
    }
    return s;
  }

  // Pulse the 4 arcs of a contactless icon (or any NodeList / array of elements) outward,
  // inner to outer, from `at` until `end`.  Finite, explicit tweens (no repeat: -1).
  // opts: { period (s, default 0.9), low (0.25), high (1) }
  function waves(tl, iconOrEls, at, end, opts) {
    const o = Object.assign({ period: 0.9, low: 0.25, high: 1 }, opts || {});
    const els = Array.prototype.slice.call(iconOrEls.querySelectorAll ? iconOrEls.querySelectorAll(".m9-wave") : iconOrEls);
    const step = o.period / (els.length + 1);
    els.forEach(function (e) { tl.set(e, { opacity: o.low }, at); });
    for (let t = at; t < end - 0.05; t += o.period) {
      els.forEach(function (e, i) {
        const t0 = t + i * step;
        if (t0 >= end) return;
        const up = Math.min(step * 1.2, end - t0);
        tl.fromTo(e, { opacity: o.low }, { opacity: o.high, duration: up, ease: "power2.out", immediateRender: false }, t0);
        if (t0 + up < end) tl.to(e, { opacity: o.low, duration: Math.min(step * 2, end - t0 - up), ease: "power1.in" }, t0 + up);
      });
    }
  }

  return { C: C, rng: rng, ready: ready, bg: bg, push: push, fit: fit, shrinkWrap: shrinkWrap, words: words, rich: rich, count: count, phone: phone, card: card, icon: icon, waves: waves };
})();
