/* Moi Phone design kit helpers. Deterministic: seeded RNG only, no clocks.
   Layout is 1920x1080.  Everything that is on screen keeps moving to the last frame. */
window.MP = (function () {
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

  // Ink background inside `host`, animated for `dur` seconds: drifting green glow, the big
  // charging-ring outline (right side by default) with a green arc that sweeps around it,
  // and a few slow-rising dots.  opts: { seed, ring: true|false, ringX, ringY, ringR, glowX, glowY, dots }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, ring: true, ringX: 1660, ringY: 560, ringR: 430, glowX: 1300, glowY: 560, dots: 10 }, opts || {});
    const r = rng(o.seed);
    const wrap = document.createElement("div");
    wrap.className = "mp-bg";
    const glow = document.createElement("div");
    glow.className = "mp-glow";
    glow.style.left = (o.glowX - 750) + "px";
    glow.style.top = (o.glowY - 750) + "px";
    glow.setAttribute("data-layout-allow-overflow", "");
    wrap.appendChild(glow);
    let ring = null, arc = null;
    if (o.ring) {
      ring = document.createElement("div");
      ring.className = "mp-ring";
      ring.style.left = (o.ringX - o.ringR) + "px";
      ring.style.top = (o.ringY - o.ringR) + "px";
      ring.style.width = ring.style.height = (2 * o.ringR) + "px";
      ring.setAttribute("data-layout-allow-overflow", "");
      wrap.appendChild(ring);
      const ns = "http://www.w3.org/2000/svg";
      arc = document.createElementNS(ns, "svg");
      const S = 2 * o.ringR;
      arc.setAttribute("width", S);
      arc.setAttribute("height", S);
      arc.setAttribute("viewBox", "0 0 " + S + " " + S);
      arc.setAttribute("class", "mp-arc");
      arc.style.left = (o.ringX - o.ringR) + "px";
      arc.style.top = (o.ringY - o.ringR) + "px";
      arc.setAttribute("data-layout-allow-overflow", "");
      const c = document.createElementNS(ns, "circle");
      const rr = o.ringR - 13;
      c.setAttribute("cx", o.ringR);
      c.setAttribute("cy", o.ringR);
      c.setAttribute("r", rr);
      c.setAttribute("fill", "none");
      c.setAttribute("stroke", "rgba(59,227,122,0.35)");
      c.setAttribute("stroke-width", "26");
      c.setAttribute("stroke-linecap", "round");
      const len = 2 * Math.PI * rr;
      c.setAttribute("stroke-dasharray", (len * 0.16) + " " + len);
      arc.appendChild(c);
      wrap.appendChild(arc);
    }
    const dots = [];
    for (let i = 0; i < o.dots; i++) {
      const d = document.createElement("div");
      d.className = "mp-dot";
      const size = 4 + Math.round(r() * 6);
      d.style.width = d.style.height = size + "px";
      d.style.left = Math.round(80 + r() * 1760) + "px";
      d.style.top = Math.round(300 + r() * 700) + "px";
      wrap.appendChild(d);
      dots.push({ el: d, rise: 30 + r() * 80, op: 0.10 + r() * 0.30, drift: (r() - 0.5) * 40 });
    }
    host.insertBefore(wrap, host.firstChild);
    tl.fromTo(glow, { x: -60, y: -30, scale: 1 }, { x: 60, y: 40, scale: 1.12, duration: dur, ease: "sine.inOut" }, 0);
    if (ring) {
      tl.fromTo(ring, { scale: 0.96 }, { scale: 1.02, duration: dur, ease: "sine.inOut" }, 0);
      tl.fromTo(arc, { rotation: -90, scale: 0.96 }, { rotation: -90 + 75 * dur, scale: 1.02, duration: dur, ease: "none" }, 0);
    }
    dots.forEach(function (d) {
      tl.fromTo(d.el, { y: 0, x: 0, opacity: d.op }, { y: -d.rise * dur / 3, x: d.drift, opacity: d.op * 0.5, duration: dur, ease: "none" }, 0);
    });
    return wrap;
  }

  // Slow push-in on a camera wrapper for the whole duration.
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.04, duration: dur, ease: "none", transformOrigin: "50% 50%" }, 0);
  }

  // Shrink an element's font-size until it fits maxW x maxH.  Measures scrollWidth, so use
  // it on inline-block / inline-flex elements (or a block exactly maxW wide).
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

  // Count a number up from `from` to `to` inside `el` (integers, Indian/International commas
  // via toLocaleString("en-IN") only when `commas` is true).
  function count(tl, el, from, to, at, dur, opts) {
    const o = Object.assign({ commas: true, decimals: 0, suffix: "" }, opts || {});
    const st = { v: from };
    const show = function () {
      const v = o.decimals ? st.v.toFixed(o.decimals) : Math.round(st.v);
      el.textContent = (o.commas ? Number(v).toLocaleString("en-IN") : String(v)) + o.suffix;
    };
    show();
    tl.fromTo(st, { v: from }, { v: to, duration: dur, ease: "power2.out", onUpdate: show }, at);
  }

  return { rng: rng, bg: bg, push: push, fit: fit, words: words, count: count };
})();
