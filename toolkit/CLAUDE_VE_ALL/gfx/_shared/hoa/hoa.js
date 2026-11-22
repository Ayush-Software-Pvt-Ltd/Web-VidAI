/* House of Apps design kit helpers. Deterministic: seeded RNG only, no clocks.
   Load after gsap: <script src="shared/js/gsap.min.js"></script><script src="shared/hoa/hoa.js"></script>
   and link shared/hoa/hoa.css. */
window.HOA = (function () {
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

  // Moving background inside `host` for `dur` seconds: drifting lime / coral / aqua glows, a
  // faint grid of rounded app tiles sliding diagonally, rising particles (bubbles: true makes
  // them hollow rings, e.g. for water).  opts: { seed, dots, bubbles, tiles (true) }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, dots: 16, bubbles: false, tiles: true }, opts || {});
    const r = rng(o.seed);
    const wrap = div("hoa-bg");
    const gl = div("hoa-glow hoa-glow-l", wrap);
    const ga = div("hoa-glow hoa-glow-a", wrap);
    const gc = div("hoa-glow hoa-glow-c", wrap);
    [gl, ga, gc].forEach(function (g) { g.setAttribute("data-layout-allow-overflow", ""); });
    let tiles = null;
    if (o.tiles) {
      tiles = div("hoa-tiles", wrap);
      tiles.setAttribute("data-layout-allow-overflow", "");
    }
    const dots = [];
    for (let i = 0; i < o.dots; i++) {
      const d = div("hoa-dot", wrap);
      const size = (o.bubbles ? 10 : 4) + Math.round(r() * (o.bubbles ? 22 : 8));
      const col = r() < 0.55 ? "#d4ff3a" : (r() < 0.5 ? "#3fe3ff" : "#ff4f6d");
      d.style.width = d.style.height = size + "px";
      d.style.left = Math.round(40 + r() * 1000) + "px";
      d.style.top = Math.round(380 + r() * 1300) + "px";
      if (o.bubbles) d.style.border = "3px solid " + (r() < 0.7 ? "rgba(63,227,255,0.8)" : "rgba(255,255,255,0.7)");
      else d.style.background = col;
      dots.push({ el: d, rise: 60 + r() * 160, op: 0.18 + r() * 0.45, drift: (r() - 0.5) * 70 });
    }
    div("hoa-vignette", wrap);
    host.insertBefore(wrap, host.firstChild);
    if (tiles) {
      // one tile (120 px) diagonally every 1.2 s, seamless
      tl.fromTo(tiles, { x: 0, y: 0 }, { x: 120, y: 120, duration: 1.2, ease: "none", repeat: Math.ceil(dur / 1.2) - 1 }, 0);
    }
    tl.fromTo(gl, { x: -60, y: -30, scale: 1 }, { x: 110, y: 80, scale: 1.15, duration: dur, ease: "sine.inOut" }, 0);
    tl.fromTo(gc, { x: 70, y: 40, scale: 1.1 }, { x: -80, y: -60, scale: 0.95, duration: dur, ease: "sine.inOut" }, 0);
    tl.fromTo(ga, { x: 0, y: 0, scale: 0.95 }, { x: 90, y: -50, scale: 1.1, duration: dur, ease: "sine.inOut" }, 0);
    dots.forEach(function (d) {
      tl.fromTo(d.el, { y: 0, x: 0, opacity: d.op }, { y: -d.rise * dur / 3, x: d.drift, opacity: d.op * 0.5, duration: dur, ease: "none" }, 0);
    });
    return wrap;
  }

  // Slow push-in on a camera wrapper for the whole duration (keep text inside ~95% of the safe box).
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.05, duration: dur, ease: "none", transformOrigin: "50% 45%" }, 0);
  }

  // Shrink an element's font-size until it fits maxW x maxH. Use on inline-block / inline-flex
  // elements with white-space: nowrap (measures scrollWidth / scrollHeight).
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
  // Colour spans AFTER splitting (the text is rebuilt).
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

  // A product cut-out (transparent PNG from assets/) with a soft floor shadow and a coloured rim
  // glow, its box centred at (cx, cy) and `w` px wide.  Returns { el, img, shadow }; animate `el`
  // (entrance / float / turn) - the image and shadow move with it.
  // opts: { shadow (true), glow: CSS colour of the rim glow }
  function product(src, cx, cy, w, opts) {
    const o = Object.assign({ shadow: true, glow: "rgba(212,255,58,0.30)" }, opts || {});
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;left:" + Math.round(cx - w / 2) + "px;top:0;width:" + w + "px;";
    el.setAttribute("data-layout-allow-overflow", "");
    let shadow = null;
    if (o.shadow) {
      shadow = document.createElement("div");
      shadow.style.cssText = "position:absolute;left:6%;width:88%;height:70px;border-radius:50%;" +
        "background:radial-gradient(ellipse at center, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 70%);";
      el.appendChild(shadow);
    }
    const img = document.createElement("img");
    img.src = src;
    img.className = "hoa-product";
    img.style.cssText = "position:relative;width:" + w + "px;height:auto;filter:drop-shadow(0 30px 40px rgba(0,0,0,0.55)) drop-shadow(0 0 46px " + o.glow + ");";
    el.appendChild(img);
    function place() {
      const h = img.naturalWidth ? w * img.naturalHeight / img.naturalWidth : w * 1.2;
      el.style.top = Math.round(cy - h / 2) + "px";
      el.style.height = Math.round(h) + "px";
      if (shadow) shadow.style.top = Math.round(h - 36) + "px";
    }
    if (img.complete) place(); else img.addEventListener("load", place);
    place();
    return { el: el, img: img, shadow: shadow };
  }

  // Rank badge "#n" as a lime disc of diameter d, centred at (cx, cy).
  function rank(n, cx, cy, d, parent) {
    const el = div("hoa-rank", parent);
    el.style.cssText += "left:" + Math.round(cx - d / 2) + "px;top:" + Math.round(cy - d / 2) + "px;width:" + d + "px;height:" + d + "px;font-size:" + Math.round(d * 0.5) + "px;";
    const s = document.createElement("span");
    s.textContent = "#" + n;
    el.appendChild(s);
    return el;
  }

  // Inline SVG tick in a circle (stroke drawn with GSAP: animate the path's strokeDashoffset to 0).
  function tick(size, color) {
    const c = color || "#d4ff3a";
    const w = document.createElement("div");
    w.style.cssText = "position:relative;width:" + size + "px;height:" + size + "px;flex:none;";
    w.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100">' +
      '<circle cx="50" cy="50" r="46" fill="' + c + '" />' +
      '<path d="M28 52 L44 67 L73 36" fill="none" stroke="#0c0a17" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="70" stroke-dashoffset="0" /></svg>';
    w.path = w.querySelector("path");
    return w;
  }

  // Indian rupee amount with thousands separators in the Indian style: 141000 -> "1,41,000".
  function inr(n) {
    const s = String(Math.round(n));
    if (s.length <= 3) return s;
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    return rest + "," + last3;
  }

  return { rng: rng, div: div, bg: bg, push: push, fit: fit, words: words, product: product, rank: rank, tick: tick, inr: inr };
})();
