/* House of Tech design kit helpers. Deterministic: seeded RNG only, no clocks. */
window.HT = (function () {
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

  // Moving background inside `host`, animated for `dur` seconds: perspective grid floor
  // rolling toward the viewer, cyan + orange glows drifting, floating particles.
  // opts: { seed, dots, floor (true), accent ("cyan" | "orange") }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, dots: 18, floor: true }, opts || {});
    const r = rng(o.seed);
    const land = !!o.landscape;
    const wrap = div("ht-bg");
    const gc = div("ht-glow ht-glow-c", wrap);
    const go = div("ht-glow ht-glow-o", wrap);
    [gc, go].forEach(function (g) { g.setAttribute("data-layout-allow-overflow", ""); });
    let lines = null;
    if (o.floor) {
      const fw = div("ht-floor-wrap", wrap);
      const fl = div("ht-floor", fw);
      fl.setAttribute("data-layout-allow-overflow", "");
      lines = div("ht-floor-lines", fl);
      lines.setAttribute("data-layout-allow-overflow", "");
      div("ht-fade", wrap);
      div("ht-horizon", wrap);
    }
    const dots = [];
    for (let i = 0; i < o.dots; i++) {
      const d = div("ht-dot", wrap);
      const size = 3 + Math.round(r() * 7);
      d.style.width = d.style.height = size + "px";
      d.style.left = Math.round(40 + r() * (land ? 1840 : 1000)) + "px";
      d.style.top = Math.round(land ? 120 + r() * 800 : 260 + r() * 1300) + "px";
      d.style.background = r() < 0.7 ? "#19d3ff" : "#ff6b1a";
      dots.push({ el: d, rise: 50 + r() * 140, op: 0.15 + r() * 0.45, drift: (r() - 0.5) * 60 });
    }
    host.insertBefore(wrap, host.firstChild);
    if (lines) {
      // the floor rolls one grid cell (120 px) toward the viewer every 0.6 s, seamlessly: whole cycles
      // repeat inside the duration (never past it), the last part cycle is a tween of its own
      const cell = 0.6;
      const whole = Math.floor(dur / cell + 1e-9);
      const rest = dur - whole * cell;
      if (whole > 0) tl.fromTo(lines, { y: 0 }, { y: 120, duration: cell, ease: "none", repeat: whole - 1 }, 0);
      if (rest > 1e-6) {
        tl.fromTo(lines, { y: 0 }, { y: (120 * rest) / cell, duration: rest, ease: "none", immediateRender: false }, whole * cell);
      }
    }
    tl.fromTo(gc, { x: -80, y: -40, scale: 1 }, { x: 90, y: 70, scale: 1.15, duration: dur, ease: "sine.inOut" }, 0);
    tl.fromTo(go, { x: 60, y: 30, scale: 1.1 }, { x: -70, y: -50, scale: 0.95, duration: dur, ease: "sine.inOut" }, 0);
    dots.forEach(function (d) {
      tl.fromTo(d.el, { y: 0, x: 0, opacity: d.op }, { y: -d.rise * dur / 3, x: d.drift, opacity: d.op * 0.5, duration: dur, ease: "none" }, 0);
    });
    return wrap;
  }

  // Slow push-in on a camera wrapper for the whole duration.
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.05, duration: dur, ease: "none", transformOrigin: "50% 45%" }, 0);
  }

  // Shrink an element's font-size until it fits maxW x maxH. Use on inline-block / inline-flex
  // elements (measures scrollWidth / scrollHeight, so matras count).
  function fit(el, maxW, maxH, minPx) {
    let px = parseFloat(getComputedStyle(el).fontSize);
    const floor = minPx || 40;
    while (px > floor && (el.scrollWidth > maxW || (maxH && el.scrollHeight > maxH))) {
      px -= 2;
      el.style.fontSize = px + "px";
    }
    return px;
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

  // A product cut-out (transparent PNG from assets/) with a soft floor shadow, absolutely
  // positioned with its box centred at (cx, cy) and `w` px wide. Returns { el, img, shadow };
  // animate `el` (entrance / float) - the image and shadow move with it.
  function product(src, cx, cy, w, opts) {
    const o = Object.assign({ shadow: true, glow: "rgba(25,211,255,0.35)" }, opts || {});
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;left:" + Math.round(cx - w / 2) + "px;top:0;width:" + w + "px;";
    el.setAttribute("data-layout-allow-overflow", "");
    const img = document.createElement("img");
    img.src = src;
    img.className = "ht-product";
    img.style.cssText = "position:relative;width:" + w + "px;height:auto;filter:drop-shadow(0 26px 40px rgba(0,0,0,0.55)) drop-shadow(0 0 40px " + o.glow + ");";
    el.appendChild(img);
    let shadow = null;
    if (o.shadow) {
      shadow = document.createElement("div");
      shadow.style.cssText = "position:absolute;left:10%;width:80%;height:60px;border-radius:50%;" +
        "background:radial-gradient(ellipse at center, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 70%);";
      el.appendChild(shadow);
    }
    // vertical placement once the image size is known (decoded before fonts.ready in practice)
    function place() {
      const h = img.naturalWidth ? w * img.naturalHeight / img.naturalWidth : w * 0.7;
      el.style.top = Math.round(cy - h / 2) + "px";
      el.style.height = Math.round(h) + "px";
      if (shadow) shadow.style.top = Math.round(h - 30) + "px";
    }
    if (img.complete) place(); else img.addEventListener("load", place);
    place();
    return { el: el, img: img, shadow: shadow };
  }

  // A drawn generic laptop (stand-in when no cut-out fits), open, 3/4 front-ish.
  // opts: { w (screen width px), color (lid/body), screen (CSS background of the display) }
  function laptop(opts) {
    const o = Object.assign({ w: 640, color: "#2a2f3a", screen: "linear-gradient(135deg,#0e2a55,#19d3ff)" }, opts || {});
    const W = o.w, H = Math.round(o.w * 0.62);
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;width:" + Math.round(W * 1.16) + "px;height:" + Math.round(H + W * 0.09) + "px;";
    el.setAttribute("data-layout-allow-overflow", "");
    const lid = div("", el);
    lid.style.cssText = "position:absolute;left:" + Math.round(W * 0.08) + "px;top:0;width:" + W + "px;height:" + H + "px;border-radius:" + Math.round(W * 0.03) + "px;background:" + o.color + ";box-shadow:0 20px 60px rgba(0,0,0,0.5);";
    const scr = div("", lid);
    scr.style.cssText = "position:absolute;inset:" + Math.round(W * 0.025) + "px;border-radius:" + Math.round(W * 0.012) + "px;background:" + o.screen + ";overflow:hidden;";
    const base = div("", el);
    base.style.cssText = "position:absolute;left:0;top:" + (H - 2) + "px;width:" + Math.round(W * 1.16) + "px;height:" + Math.round(W * 0.05) + "px;border-radius:0 0 " + Math.round(W * 0.04) + "px " + Math.round(W * 0.04) + "px;background:linear-gradient(180deg,#d9dee6 0%," + o.color + " 100%);box-shadow:0 18px 40px rgba(0,0,0,0.55);";
    el.screen = scr;
    el.lid = lid;
    return el;
  }

  // Indian rupee amount with thousands separators in the Indian style: 71190 -> "71,190".
  function inr(n) {
    const s = String(Math.round(n));
    if (s.length <= 3) return s;
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    return rest + "," + last3;
  }

  // Count a number up inside `el` from `from` to `to` (rupee style formatting optional).
  function count(tl, el, from, to, at, dur, fmt) {
    const o = { v: from };
    const f = fmt || function (v) { return inr(v); };
    el.textContent = f(from);
    tl.to(o, { v: to, duration: dur, ease: "power2.out", onUpdate: function () { el.textContent = f(o.v); } }, at);
    return o;
  }

  return { rng: rng, div: div, bg: bg, push: push, fit: fit, words: words, product: product, laptop: laptop, inr: inr, count: count };
})();
