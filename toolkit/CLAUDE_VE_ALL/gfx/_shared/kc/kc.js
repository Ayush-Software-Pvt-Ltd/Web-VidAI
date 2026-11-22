/* Kudrat Care design kit helpers. Deterministic: seeded RNG only, no clocks. */
window.KC = (function () {
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
  // Moving background inside `host` for `dur` s: cream paper (or dark: true), three soft clay
  // blobs (red, blue, green) drifting and breathing, floating clay dust rising slowly.
  // opts: { seed, dust (18), dark (false), tint ("both" | "red" | "blue") }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, dust: 18, dark: false, tint: "both" }, opts || {});
    const r = rng(o.seed);
    const wrap = div("kc-bg" + (o.dark ? " dark" : ""));
    const kinds = o.tint === "red" ? ["red", "red", "green"] : o.tint === "blue" ? ["blue", "blue", "green"] : ["red", "blue", "green"];
    const spots = [[-380, 40, 1300], [300, 900, 1300], [-200, 1350, 900]];
    const blobs = kinds.map(function (k, i) {
      const b = div("kc-blob " + k, wrap);
      const s = spots[i];
      b.style.left = s[0] + "px"; b.style.top = s[1] + "px";
      b.style.width = b.style.height = s[2] + "px";
      b.setAttribute("data-layout-allow-overflow", "");
      return b;
    });
    const dust = [];
    for (let i = 0; i < o.dust; i++) {
      const d = div("kc-dust", wrap);
      const size = 6 + Math.round(r() * 12);
      d.style.width = d.style.height = size + "px";
      d.style.left = Math.round(30 + r() * 1020) + "px";
      d.style.top = Math.round(200 + r() * 1600) + "px";
      const c = r();
      d.style.background = c < 0.45 ? "#d9785b" : c < 0.85 ? "#8ec3db" : "#c99a3c";
      const op = 0.25 + r() * 0.4;
      d.style.opacity = op;
      d.setAttribute("data-layout-allow-overflow", "");
      dust.push({ el: d, rise: 80 + r() * 160, drift: (r() - 0.5) * 80, op: op });
    }
    div("kc-grain", wrap);
    host.insertBefore(wrap, host.firstChild);
    blobs.forEach(function (b, i) {
      const dx = (i % 2 ? -1 : 1) * (70 + r() * 60), dy = (i === 1 ? -1 : 1) * (50 + r() * 50);
      tl.fromTo(b, { x: 0, y: 0, scale: 1 }, { x: dx, y: dy, scale: 1.12, duration: dur, ease: "sine.inOut" }, 0);
    });
    dust.forEach(function (d) {
      tl.fromTo(d.el, { y: 0, x: 0, opacity: d.op }, { y: -d.rise * Math.max(1, dur / 3), x: d.drift, opacity: d.op * 0.55, duration: dur, ease: "none" }, 0);
    });
    return wrap;
  }
  // Slow push-in on a camera wrapper for the whole duration.
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.045, duration: dur, ease: "none", transformOrigin: "50% 45%" }, 0);
  }
  // Shrink font-size until el fits maxW x maxH (use on inline-block, white-space: nowrap
  // for one-liners; measures scrollWidth / scrollHeight so matras count).
  function fit(el, maxW, maxH, minPx) {
    let px = parseFloat(getComputedStyle(el).fontSize);
    const floor = minPx || 40;
    while (px > floor && (el.scrollWidth > maxW || (maxH && el.scrollHeight > maxH))) {
      px -= 2;
      el.style.fontSize = px + "px";
    }
    return px;
  }
  // A drawn clay jar ("red" | "blue"), w px wide, box top-left at (x, y). Returns the element.
  function jar(kind, x, y, w, parent) {
    const el = div("kc-jar " + kind, parent);
    el.style.left = x + "px"; el.style.top = y + "px";
    el.style.width = w + "px"; el.style.height = Math.round(w * 1.05) + "px";
    div("lid", el);
    const g = div("glass", el);
    div("powder", g);
    div("shine", g);
    return el;
  }
  return { rng: rng, div: div, bg: bg, push: push, fit: fit, jar: jar };
})();
