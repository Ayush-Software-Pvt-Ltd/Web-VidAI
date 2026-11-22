/* My Motor Talk design kit helpers. Deterministic: seeded RNG only, no clocks. */
window.MMT = (function () {
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

  // Moving background inside `host`, animated for `dur` seconds: asphalt road with a yellow
  // lane dash rolling toward the viewer, amber + red glows drifting, speed streaks, sparks.
  // opts: { seed, streaks, road (true), accent ("amber" | "red") }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, streaks: 10, road: true }, opts || {});
    const r = rng(o.seed);
    const wrap = div("mmt-bg");
    const ga = div("mmt-glow mmt-glow-a", wrap);
    const gr = div("mmt-glow mmt-glow-r", wrap);
    [ga, gr].forEach(function (g) { g.setAttribute("data-layout-allow-overflow", ""); });
    let lane = null;
    if (o.road) {
      const rw = div("mmt-road-wrap", wrap);
      const rd = div("mmt-road", rw);
      rd.setAttribute("data-layout-allow-overflow", "");
      div("mmt-road-edge-l", rd);
      div("mmt-road-edge-r", rd);
      lane = div("mmt-lane", rd);
      lane.setAttribute("data-layout-allow-overflow", "");
      div("mmt-fade", wrap);
      div("mmt-horizon", wrap);
    }
    const streaks = [];
    for (let i = 0; i < o.streaks; i++) {
      const s = div("mmt-streak", wrap);
      const len = 220 + Math.round(r() * 320);
      s.style.width = "4px";
      s.style.height = len + "px";
      s.style.left = Math.round(r() * 1080) + "px";
      s.style.top = Math.round(r() * 1600) + "px";
      s.style.opacity = 0.10 + r() * 0.22;
      s.setAttribute("data-layout-allow-overflow", "");
      streaks.push({ el: s, drop: 320 + r() * 380, drift: -180 - r() * 160 });
    }
    const sparks = [];
    for (let i = 0; i < 14; i++) {
      const d = div("mmt-streak", wrap);
      const size = 4 + Math.round(r() * 6);
      d.style.width = d.style.height = size + "px";
      d.style.borderRadius = "50%";
      d.style.transform = "none";
      d.style.left = Math.round(40 + r() * 1000) + "px";
      d.style.top = Math.round(260 + r() * 1300) + "px";
      d.style.background = r() < 0.75 ? "#ffb020" : "#ff6a00";
      d.style.opacity = 0.15 + r() * 0.4;
      d.setAttribute("data-layout-allow-overflow", "");
      sparks.push({ el: d, rise: 60 + r() * 150, op: 0.15 + r() * 0.4, drift: (r() - 0.5) * 70 });
    }
    host.insertBefore(wrap, host.firstChild);
    if (lane) {
      // the lane dash rolls one pattern (240 px) toward the viewer every 0.5 s, seamlessly
      tl.fromTo(lane, { y: 0 }, { y: 240, duration: 0.5, ease: "none", repeat: Math.ceil(dur / 0.5) - 1 }, 0);
    }
    tl.fromTo(ga, { x: -80, y: -40, scale: 1 }, { x: 90, y: 70, scale: 1.15, duration: dur, ease: "sine.inOut" }, 0);
    tl.fromTo(gr, { x: 60, y: 30, scale: 1.1 }, { x: -70, y: -50, scale: 0.95, duration: dur, ease: "sine.inOut" }, 0);
    streaks.forEach(function (s) {
      tl.fromTo(s.el, { y: 0, x: 0, opacity: 0 }, { y: s.drop * dur / 3, x: s.drift * dur / 3,
        opacity: 0.28, duration: dur / 3, ease: "none", repeat: 2, repeatDelay: 0 }, 0);
    });
    sparks.forEach(function (d) {
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
    const o = Object.assign({ shadow: true, glow: "rgba(255,176,32,0.35)" }, opts || {});
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;left:" + Math.round(cx - w / 2) + "px;top:0;width:" + w + "px;";
    el.setAttribute("data-layout-allow-overflow", "");
    const img = document.createElement("img");
    img.src = src;
    img.className = "mmt-product";
    img.style.cssText = "position:relative;width:" + w + "px;height:auto;filter:drop-shadow(0 26px 40px rgba(0,0,0,0.55)) drop-shadow(0 0 40px " + o.glow + ");";
    el.appendChild(img);
    let shadow = null;
    if (o.shadow) {
      shadow = document.createElement("div");
      shadow.style.cssText = "position:absolute;left:10%;width:80%;height:60px;border-radius:50%;" +
        "background:radial-gradient(ellipse at center, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 70%);";
      el.appendChild(shadow);
    }
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

  return { rng: rng, div: div, bg: bg, push: push, fit: fit, words: words, product: product, inr: inr, count: count };
})();
