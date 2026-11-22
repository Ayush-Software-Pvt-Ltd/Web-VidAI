const K = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const STACK = ', "Mukta", "Baloo 2", "Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", "Devanagari Sangam MN", "Segoe UI", system-ui, sans-serif';
  const ICONS = {
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    heart: '<path d="M12 20s-7-4.4-9-9.2C1.8 7 4 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 3 0 5.2 3 4 6.8C19 15.6 12 20 12 20z"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    phone: '<path d="M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2"/>',
    gift: '<path d="M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7C10 3 6 4 8 7M12 7c2-4 6-3 4 0"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    rupee: '<path d="M7 5h10M7 9h10M7 5c6 0 6 8 0 8h-.5l7.5 7"/>',
    cart: '<path d="M3 4h2l2.5 11h10l2-8H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  };

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
  function rgb(h) {
    h = String(h).replace("#", "");
    if (h.length < 6) h = h.split("").map(function (c) { return c + c; }).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgba(h, a) { const c = rgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function lum(h) {
    const c = rgb(h).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function on(h) { return lum(h) > 0.2 ? "rgb(16,18,28)" : "rgb(255,255,255)"; }   // readable ink on a colour
  function list(s) { return String(s || "").split(/\||\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function svg(parent, w, h, vb) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("width", w); s.setAttribute("height", h); s.setAttribute("viewBox", vb || "0 0 24 24");
    s.style.overflow = "visible";
    if (parent) parent.appendChild(s);
    return s;
  }

  // The variables of the graphic: the declared defaults, then what the host or the render passes.
  function vars(def) {
    const passed = (window.__hyperframes && window.__hyperframes.getVariables) ? window.__hyperframes.getVariables() : {};
    return Object.assign({}, def, passed || {});
  }

  // Load every font face the text needs before anything is measured.
  function ready(v) {
    const text = Object.keys(v).map(function (k) { return v[k]; }).join(" ");
    const fams = ["Mukta", "Baloo 2"];
    if (v.font && fams.indexOf(v.font) < 0) fams.unshift(v.font);
    const jobs = [];
    ["500", "700", "800"].forEach(function (w) {
      fams.forEach(function (f) { jobs.push(document.fonts.load(w + ' 48px "' + f + '"', text).catch(function () { return null; })); });
    });
    return Promise.all(jobs).then(function () { return document.fonts.ready; });
  }

  // Colours, font and the safe box (a vertical Shorts frame keeps clear of the top bar and the bottom 22 %).
  function setup(root, v) {
    const W = root.clientWidth || +root.getAttribute("data-width") || 1920;
    const H = root.clientHeight || +root.getAttribute("data-height") || 1080;
    const port = H > W;
    const S = {
      W: W, H: H, port: port, u: Math.min(W, H) / 1080,
      accent: v.accent, accent2: v.accent2, bg1: v.bg1, bg2: v.bg2, text: v.text,
      muted: rgba(v.text, 0.84), faint: rgba(v.text, 0.1), ink: on(v.accent),
      center: v.align !== "left", seed: Math.max(0, parseInt(v.seed, 10) || 1),
    };
    S.x = Math.round(W * (port ? 0.09 : 0.08));
    S.y = Math.round(H * (port ? 0.1 : 0.1));
    S.sw = W - 2 * S.x;
    S.sh = Math.round(H * (port ? 1 - 0.1 - 0.18 : 1 - 0.2));
    root.style.fontFamily = '"' + v.font + '"' + STACK;
    root.style.color = v.text;
    root.style.background = v.bg1;
    return S;
  }
  function place(safe, S, inset) {
    inset = inset || 0.96;                             // headroom for the slow push-in
    const w = S.sw * inset, h = S.sh * inset;
    safe.style.left = Math.round(S.x + (S.sw - w) / 2) + "px";
    safe.style.top = Math.round(S.y + (S.sh - h) / 2) + "px";
    safe.style.width = Math.round(w) + "px";
    safe.style.height = Math.round(h) + "px";
    return { w: Math.round(w), h: Math.round(h) };
  }

  // Largest font size (max .. min px) at which the text fits `w` x `h`; a long word never overflows.
  function fit(e, w, h, max, min) {
    e.style.width = w + "px";
    e.style.overflowWrap = "normal";
    let lo = min, hi = max, best = min;
    while (hi - lo > 0.5) {
      const m = (lo + hi) / 2;
      e.style.fontSize = m + "px";
      if (e.offsetHeight <= h && e.scrollWidth <= w + 1) { best = m; lo = m; } else { hi = m; }
    }
    e.style.fontSize = best + "px";
    if (e.offsetHeight > h || e.scrollWidth > w + 1) e.style.overflowWrap = "anywhere";
    return best;
  }

  // Line breaks that keep a phrase together.  Hindi particles and verbs belong to the word before them
  // ("का", "में", "है"), small modifiers to the word after them ("सबसे", "हर", "कौन"), a dash to the word before it,
  // and the last two words never leave a single orphan.  Joined words are tied with a no-break space; a tie
  // never holds more than three words or 24 characters, so a long text still wraps.
  const NB = "\u00a0";
  const TAIL = new Set(("का की के को ने में से पर तक भी ही है हैं था थी थे हो रहा रही रहे गया गई गए वाला वाली वाले सा सी जैसा जैसी " +
    "ना नहीं तो भर ज़रा पास बाद बारे लिए साथ तरह बीच ऊपर नीचे अंदर बाहर आ जा दिया लिया").split(" "));
  const HEAD = new Set(("सबसे हर बहुत कौन एक यह वह इस उस ये वो कुछ कई सभी और या कि जो सिर्फ़ सिर्फ तीन चार पाँच छह सात आठ नौ दस " +
    "a an the of in on to and or at for by with & vs").split(" "));
  function glue(text) {
    const toks = String(text).replace(/(\d)-(?=\d)/g, "$1\u2060-\u2060").split(/[ \t\r\n]+/).filter(Boolean);
    const chunks = [];
    toks.forEach(function (t) {
      const last = chunks[chunks.length - 1];
      const bare = t.toLowerCase().replace(/[.,;:!?"'()]+$/g, "");
      const punct = !/[\p{L}\p{N}]/u.test(t);
      const prevLast = last ? last[last.length - 1] : "";
      const prevBare = prevLast.toLowerCase().replace(/[.,;:!?"'()]+$/g, "");
      const tie = last && (punct || TAIL.has(bare));
      const lead = last && (HEAD.has(prevBare) || /^\d{1,2}$/.test(prevBare));
      const size = last ? last.join("").length + t.length : 0;
      if (last && ((tie && last.length < 4 && size < 30) || (lead && last.length < 3 && size < 24) || false)) last.push(t);
      else chunks.push([t]);
    });
    const n = chunks.length;
    if (n >= 3 && chunks[n - 1].length === 1) {
      const a = chunks[n - 2], b = chunks[n - 1];
      if (a.length < 4 && a.join(" ").length + b[0].length < 28) { a.push(b[0]); chunks.pop(); }
    }
    return chunks.map(function (c) { return c.join(NB); }).join(" ");
  }
  const DEVA = /[\u0900-\u097f]/;
  // Text of an element: phrases tied together; no letter-spacing on Devanagari (it pulls the matras apart).
  function txt(e, text) {
    e.textContent = glue(text);
    e.style.letterSpacing = DEVA.test(String(text)) ? "0" : "";
    return e;
  }
  // Chrome balances at most 6 lines; a longer text gets the orphan-free "pretty" wrapping instead.
  function wrapMode(e) {
    const fs = parseFloat(e.style.fontSize) || 16;
    const lh = parseFloat(getComputedStyle(e).lineHeight) || fs * 1.3;
    e.style.textWrap = e.offsetHeight / lh > 6.3 ? "pretty" : "balance";
  }

  // One span per phrase (they animate one after the other); the last word of the last phrase can take the accent.
  function words(e, text, accentLast, color) {
    e.textContent = "";
    if (DEVA.test(String(text))) e.style.letterSpacing = "0";
    const parts = glue(text).split(" ").filter(Boolean);
    const out = parts.map(function (p, i) {
      const s = el("span", "w", e);
      if (accentLast && parts.length > 1 && i === parts.length - 1) {
        const cut = p.lastIndexOf(NB) + 1;
        if (cut) s.appendChild(document.createTextNode(p.slice(0, cut)));
        const a = el("span", "", s);
        a.textContent = p.slice(cut);
        a.style.color = color;
      } else s.textContent = p;
      if (i < parts.length - 1) e.appendChild(document.createTextNode(" "));
      return s;
    });
    return out;
  }

  // Measured width of the widest line of the text in an element.
  function lineWidth(e) {
    const r = document.createRange();
    r.selectNodeContents(e);
    let m = 0;
    Array.prototype.forEach.call(r.getClientRects(), function (q) { m = Math.max(m, q.width); });
    return m || e.scrollWidth;
  }

  // Everything keeps moving to the last frame: gradient, conic shimmer, glows, dot grid, light sweep, particles.
  function bg(root, tl, D, S, seedOffset) {
    const r = rng(S.seed * 97 + (seedOffset || 0));
    const L = Math.max(S.W, S.H);
    const wrap = el("div", "bgw");
    root.insertBefore(wrap, root.firstChild);
    wrap.style.background = "linear-gradient(150deg," + S.bg1 + "," + S.bg2 + ")";
    function layer(css, w, h, cx, cy) {
      const d = el("div", "", wrap);
      d.style.cssText = css + ";width:" + w + "px;height:" + h + "px;left:" + (cx - w / 2) + "px;top:" + (cy - h / 2) + "px";
      d.setAttribute("data-layout-allow-overflow", "");
      return d;
    }
    const cone = layer("background:conic-gradient(from 0deg," + rgba(S.accent, 0) + "," + rgba(S.accent, 0.2) + " 11%," + rgba(S.accent, 0) +
      " 27%," + rgba(S.accent2, 0.17) + " 52%," + rgba(S.accent2, 0) + " 70%," + rgba(S.accent, 0.12) + " 88%," + rgba(S.accent, 0) + ")",
      L * 2.4, L * 2.4, S.W * (0.4 + r() * 0.2), S.H * (0.4 + r() * 0.2));
    cone.style.webkitMaskImage = "radial-gradient(circle at 50% 50%,rgba(0,0,0,0) 10%,rgba(0,0,0,1) 42%)";   // no hot spot where the wedges meet
    tl.fromTo(cone, { rotation: -25 }, { rotation: 25, duration: D, ease: "none" }, 0);
    [[S.accent, 0.34], [S.accent2, 0.28], [S.accent, 0.16]].forEach(function (g, i) {
      const sz = L * (0.8 + r() * 0.35);
      const d = layer("border-radius:50%;background:radial-gradient(circle," + rgba(g[0], g[1]) + " 0%," + rgba(g[0], 0) + " 68%)",
        sz, sz, S.W * r(), S.H * r());
      const dx = (r() - 0.5) * S.W * 0.5, dy = (r() - 0.5) * S.H * 0.5;
      tl.fromTo(d, { x: -dx, y: -dy, scale: 0.9 }, { x: dx, y: dy, scale: 1.18 + 0.1 * i, duration: D, ease: "sine.inOut" }, 0);
    });
    const tile = Math.round(64 * S.u);
    const grid = layer("background-image:radial-gradient(circle," + rgba("#ffffff", 0.16) + " 0," + rgba("#ffffff", 0.16) + " " + 2.2 * S.u +
      "px," + rgba("#ffffff", 0) + " " + 2.8 * S.u + "px);background-size:" + tile + "px " + tile + "px;-webkit-mask-image:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,1) 15%,rgba(0,0,0,0) 80%)",
      S.W + 2 * tile, S.H + 2 * tile, S.W / 2, S.H / 2);
    tl.fromTo(grid, { x: 0, y: 0 }, { x: -tile * 1.5, y: -tile * 0.75, duration: D, ease: "none" }, 0);
    const sweep = layer("background:linear-gradient(90deg," + rgba("#ffffff", 0) + "," + rgba("#ffffff", 0.09) + "," + rgba("#ffffff", 0) + ")",
      L * 0.34, L * 2.2, 0, S.H / 2);
    tl.fromTo(sweep, { x: -S.W * 0.2, rotation: 18 }, { x: S.W * 1.5, rotation: 18, duration: D, ease: "none" }, 0);
    for (let i = 0; i < 16; i++) {
      const sz = Math.round((4 + r() * 8) * S.u), op = 0.12 + r() * 0.3;
      const d = layer("border-radius:50%;background:" + (i % 3 ? "rgba(255,255,255,1)" : S.accent) + ";opacity:" + op, sz, sz, S.W * r(), S.H * (0.1 + r() * 0.9));
      tl.fromTo(d, { y: 0, x: 0, opacity: op }, { y: -(60 + r() * 160) * S.u * D / 3, x: (r() - 0.5) * 80 * S.u, opacity: op * 0.4, duration: D, ease: "none" }, 0);
    }
    layer("background:radial-gradient(ellipse at 50% 50%," + rgba("#000000", 0) + " 55%," + rgba("#000000", 0.38) + " 100%)", S.W, S.H, S.W / 2, S.H / 2);
    return wrap;
  }

  // Entrance: up and in with a long deceleration.
  function rise(tl, targets, at, o) {
    o = o || {};
    tl.fromTo(targets, { y: o.y === undefined ? 56 : o.y, x: o.x || 0, opacity: 0 },
      { y: 0, x: 0, opacity: 1, duration: o.d || 0.7, ease: o.ease || "power4.out", stagger: o.stagger || 0 }, at);
  }
  // The whole content keeps travelling after it landed.
  function drift(tl, target, D, S, o) {
    o = o || {};
    tl.fromTo(target, { scale: 1, x: 0, y: 0 }, { scale: o.scale || 1.035, x: (o.x || 0) * S.u, y: (o.y || 0) * S.u, duration: D, ease: "none" }, 0);
  }

  function icon(parent, name, size, color, sw) {
    const s = svg(parent, size, size, "0 0 24 24");
    s.setAttribute("fill", "none"); s.setAttribute("stroke", color);
    s.setAttribute("stroke-width", sw || 1.8); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    if (ICONS[name]) s.innerHTML = ICONS[name];
    return s;
  }
  function ring(parent, d, color, width, frac, dim) {
    const s = svg(parent, d, d, "0 0 " + d + " " + d);
    const rr = d / 2 - width / 2;
    const len = 2 * Math.PI * rr;
    const base = document.createElementNS(NS, "circle");
    base.setAttribute("cx", d / 2); base.setAttribute("cy", d / 2); base.setAttribute("r", rr);
    base.setAttribute("fill", "none"); base.setAttribute("stroke", dim); base.setAttribute("stroke-width", width);
    s.appendChild(base);
    const arc = document.createElementNS(NS, "circle");
    arc.setAttribute("cx", d / 2); arc.setAttribute("cy", d / 2); arc.setAttribute("r", rr);
    arc.setAttribute("fill", "none"); arc.setAttribute("stroke", color); arc.setAttribute("stroke-width", width);
    arc.setAttribute("stroke-linecap", "round"); arc.setAttribute("stroke-dasharray", (len * frac) + " " + len);
    s.appendChild(arc);
    return { svg: s, arc: arc };
  }

  // "Rs 12,500+" -> a counter that ends on exactly that text (Western or Indian digit grouping).
  function counter(text) {
    const m = /^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(String(text));
    if (!m) return null;
    const dec = (m[2].split(".")[1] || "").length;
    const group = m[2].indexOf(",") >= 0, indian = /,\d\d,\d{3}(?!\d)/.test(m[2]);
    const target = parseFloat(m[2].replace(/,/g, ""));
    function fmt(n) {
      const s = Math.abs(n).toFixed(dec).split(".");
      let i = s[0];
      if (group) {
        if (indian && s[0].length > 3) i = s[0].slice(0, -3).replace(/\B(?=(\d\d)+(?!\d))/g, ",") + "," + s[0].slice(-3);
        else i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      }
      return m[1] + i + (s[1] ? "." + s[1] : "") + m[3];
    }
    return { target: target, fmt: fmt, final: String(text) };
  }

  return { rng: rng, rgba: rgba, on: on, list: list, el: el, svg: svg, vars: vars, ready: ready, setup: setup, place: place,
    fit: fit, glue: glue, txt: txt, wrapMode: wrapMode, lineWidth: lineWidth, words: words, bg: bg, rise: rise, drift: drift, icon: icon, ring: ring, counter: counter, ICONS: ICONS };
})();
