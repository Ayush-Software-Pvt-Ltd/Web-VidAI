/* Sahi Jawab design kit helpers. Deterministic: seeded RNG only, no clocks. */
window.SJ = (function () {
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

  // Build the moving background inside `host` (an element) and animate it for `dur` seconds.
  // Everything keeps moving to the last frame: glow drift + breathing, grid slide, rising dots.
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, dots: 16, glowX: 0, glowY: 0 }, opts || {});
    const r = rng(o.seed);
    const wrap = document.createElement("div");
    wrap.className = "sj-bg";
    const grid = document.createElement("div");
    grid.className = "sj-grid";
    grid.setAttribute("data-layout-allow-overflow", "");
    const glow = document.createElement("div");
    glow.className = "sj-glow";
    glow.setAttribute("data-layout-allow-overflow", "");
    wrap.appendChild(grid);
    wrap.appendChild(glow);
    const dots = [];
    for (let i = 0; i < o.dots; i++) {
      const d = document.createElement("div");
      d.className = "sj-dot";
      const size = 4 + Math.round(r() * 8);
      d.style.width = d.style.height = size + "px";
      d.style.left = Math.round(40 + r() * 1000) + "px";
      d.style.top = Math.round(200 + r() * 1500) + "px";
      wrap.appendChild(d);
      dots.push({ el: d, rise: 60 + r() * 160, op: 0.12 + r() * 0.4, drift: (r() - 0.5) * 60 });
    }
    host.insertBefore(wrap, host.firstChild);
    tl.fromTo(grid, { x: 0, y: 0 }, { x: -113 * Math.max(1, Math.round(dur / 2)), y: 113 * Math.max(1, Math.round(dur / 2)), duration: dur, ease: "none" }, 0);
    tl.fromTo(glow, { x: o.glowX - 90, y: o.glowY - 50, scale: 1 }, { x: o.glowX + 90, y: o.glowY + 60, scale: 1.14, duration: dur, ease: "sine.inOut" }, 0);
    dots.forEach(function (d) {
      tl.fromTo(d.el, { y: 0, x: 0, opacity: d.op }, { y: -d.rise * dur / 3, x: d.drift, opacity: d.op * 0.6, duration: dur, ease: "none" }, 0);
    });
    return wrap;
  }

  // Slow push-in on a camera wrapper for the whole duration.
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.06, duration: dur, ease: "none", transformOrigin: "50% 45%" }, 0);
  }

  // Shrink an element's font-size until it fits maxW x maxH (measured box, so matras count).
  // Measures scrollWidth: use it on inline-block / inline-flex elements, or pass a maxW at
  // least as wide as a block element's own box, otherwise it shrinks to minPx.
  function fit(el, maxW, maxH, minPx) {
    let px = parseFloat(getComputedStyle(el).fontSize);
    const floor = minPx || 40;
    while (px > floor && (el.scrollWidth > maxW || (maxH && el.scrollHeight > maxH))) {
      px -= 2;
      el.style.fontSize = px + "px";
    }
    return px;
  }

  // Split an element's text into word spans (for word-by-word entrances). Returns the spans.
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


  // A drawn power bank (stand-in for the real product, coloured like it).
  // opts: { w, h, color, color2, strap (loop cable on top), label, labelColor, leds (0-4 lit) }
  // Returns the outer element (position it yourself; animate it with GSAP).
  function bank(opts) {
    const o = Object.assign({ w: 300, h: 560, color: "#cfd8df", color2: null, strap: false, label: "",
      labelColor: "rgba(0,0,0,0.55)", leds: 4, strapColor: null }, opts || {});
    const c2 = o.color2 || o.color;
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;width:" + o.w + "px;height:" + o.h + "px;";
    el.setAttribute("data-layout-allow-overflow", "");
    const r = Math.round(o.w * 0.16);
    const body = document.createElement("div");
    body.style.cssText = "position:absolute;inset:0;border-radius:" + r + "px;" +
      "background:linear-gradient(160deg," + o.color + " 0%," + c2 + " 100%);" +
      "box-shadow:0 30px 60px rgba(0,0,0,0.55), inset 0 3px 0 rgba(255,255,255,0.35), inset 0 -6px 0 rgba(0,0,0,0.18);overflow:hidden;";
    const sheen = document.createElement("div");
    sheen.style.cssText = "position:absolute;left:-40%;top:0;width:45%;height:100%;" +
      "background:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,0.28) 50%,rgba(255,255,255,0) 100%);transform:skewX(-18deg);";
    sheen.className = "sj-bank-sheen";
    body.appendChild(sheen);
    const ledRow = document.createElement("div");
    ledRow.style.cssText = "position:absolute;left:0;right:0;bottom:" + Math.round(o.h * 0.08) + "px;display:flex;justify-content:center;gap:" + Math.round(o.w * 0.05) + "px;";
    const leds = [];
    for (let i = 0; i < 4; i++) {
      const d = document.createElement("div");
      const s = Math.max(8, Math.round(o.w * 0.045));
      d.style.cssText = "width:" + s + "px;height:" + s + "px;border-radius:50%;background:" + (i < o.leds ? "#ffffff" : "rgba(0,0,0,0.25)") + ";box-shadow:" + (i < o.leds ? "0 0 10px rgba(255,255,255,0.9)" : "none") + ";";
      ledRow.appendChild(d);
      leds.push(d);
    }
    body.appendChild(ledRow);
    if (o.label) {
      const t = document.createElement("div");
      t.textContent = o.label;
      t.style.cssText = "position:absolute;left:0;right:0;top:" + Math.round(o.h * 0.42) + "px;text-align:center;font-weight:700;font-size:" + Math.round(o.w * 0.13) + "px;color:" + o.labelColor + ";letter-spacing:1px;";
      body.appendChild(t);
    }
    el.appendChild(body);
    if (o.strap) {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      const sw = o.w * 0.7, sh = o.h * 0.42;
      svg.setAttribute("width", sw);
      svg.setAttribute("height", sh);
      svg.setAttribute("viewBox", "0 0 " + sw + " " + sh);
      svg.style.cssText = "position:absolute;left:" + (o.w * 0.15) + "px;top:" + (-sh + o.w * 0.06) + "px;overflow:visible;";
      const path = document.createElementNS(ns, "path");
      const k = sw * 0.16;
      path.setAttribute("d", "M " + k + " " + sh + " C " + (-k) + " " + (sh * 0.1) + ", " + (sw * 0.3) + " 0, " + (sw / 2) + " 0 C " + (sw * 0.7) + " 0, " + (sw + k) + " " + (sh * 0.1) + ", " + (sw - k) + " " + sh);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", o.strapColor || c2);
      path.setAttribute("stroke-width", Math.round(o.w * 0.07));
      path.setAttribute("stroke-linecap", "round");
      svg.appendChild(path);
      el.insertBefore(svg, body);
      el.strapPath = path;
    }
    el.sheen = sheen;
    el.leds = leds;
    return el;
  }

  return { rng: rng, bg: bg, push: push, fit: fit, words: words, bank: bank };
})();
