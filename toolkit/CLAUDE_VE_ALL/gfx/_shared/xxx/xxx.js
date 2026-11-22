/* XXX channel design kit helpers (1920x1080 layout).  Deterministic: seeded RNG only, no clocks.
   Load after gsap.min.js; use with xxx.css. */
window.XX = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const C = { paper: "#f3f1ea", card: "#ffffff", ink: "#111111", green: "#2ef06e", greenD: "#0f8a3c",
    mute: "#6b6860", line: "#d9d5ca" };

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

  function div(cls, parent, css) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    if (css) d.style.cssText = css;
    if (parent) parent.appendChild(d);
    return d;
  }

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---------------------------------------------------------------- icons
  // Flat geometric icons, viewBox 0 0 100 100, ink outline (stroke 6, round caps/joins),
  // fills white / green.  Parts that are worth animating carry a class (e.g. clock hands).
  const S = 'stroke="#111111" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"';
  const W = 'fill="#ffffff"', G = 'fill="#2ef06e"', N = 'fill="none"', K = 'fill="#111111"';
  const ICONS = {
    egg: '<path ' + W + ' ' + S + ' d="M50 8C70 8 84 42 84 62C84 82 69 93 50 93C31 93 16 82 16 62C16 42 30 8 50 8Z"/>' +
      '<path ' + N + ' stroke="#111111" stroke-width="5" stroke-linecap="round" d="M30 56C30 46 34 36 39 30"/>',
    moon: '<path ' + G + ' ' + S + ' d="M58 10A42 42 0 1 0 90 62A33 33 0 1 1 58 10Z"/>',
    dumbbell: '<rect ' + W + ' ' + S + ' x="28" y="44" width="44" height="12" rx="5"/>' +
      '<rect ' + G + ' ' + S + ' x="15" y="26" width="15" height="48" rx="6"/>' +
      '<rect ' + G + ' ' + S + ' x="70" y="26" width="15" height="48" rx="6"/>' +
      '<rect ' + W + ' ' + S + ' x="5" y="36" width="10" height="28" rx="4"/>' +
      '<rect ' + W + ' ' + S + ' x="85" y="36" width="10" height="28" rx="4"/>',
    pill: '<g transform="rotate(-35 50 50)"><path ' + G + ' ' + S + ' d="M50 36H28A14 14 0 0 0 28 64H50Z"/>' +
      '<path ' + W + ' ' + S + ' d="M50 36H72A14 14 0 0 1 72 64H50Z"/></g>',
    flask: '<path ' + W + ' ' + S + ' d="M40 10H60M43 10V38L17 82A6 6 0 0 0 22 91H78A6 6 0 0 0 83 82L57 38V10"/>' +
      '<path class="liquid" ' + G + ' ' + S + ' d="M29 62H71L83 82A6 6 0 0 1 78 91H22A6 6 0 0 1 17 82Z"/>' +
      '<circle ' + K + ' cx="44" cy="76" r="3"/><circle ' + K + ' cx="58" cy="70" r="2.5"/>',
    megaphone: '<path ' + W + ' ' + S + ' d="M30 58L36 84H47L43 60"/>' +
      '<path ' + G + ' ' + S + ' d="M12 38H30L70 16V84L30 62H12Z"/>' +
      '<path class="waves" ' + N + ' ' + S + ' d="M80 36Q88 50 80 64M88 26Q100 50 88 74"/>',
    clock: '<circle ' + W + ' ' + S + ' cx="50" cy="50" r="42"/>' +
      '<g ' + K + '><circle cx="50" cy="14" r="3"/><circle cx="86" cy="50" r="3"/><circle cx="50" cy="86" r="3"/><circle cx="14" cy="50" r="3"/></g>' +
      '<line class="hand-h" ' + S + ' x1="50" y1="50" x2="50" y2="30"/>' +
      '<line class="hand-m" ' + S + ' x1="50" y1="50" x2="72" y2="50"/>' +
      '<circle ' + G + ' stroke="#111111" stroke-width="4" cx="50" cy="50" r="6"/>',
    plate: '<circle ' + W + ' ' + S + ' cx="50" cy="50" r="42"/><circle ' + N + ' stroke="#d9d5ca" stroke-width="5" cx="50" cy="50" r="29"/>',
    flame: '<path ' + G + ' ' + S + ' d="M50 6C60 26 82 38 80 64C78 84 64 94 50 94C34 94 20 84 20 64C20 48 31 40 36 25C41 36 45 40 50 42C55 30 53 17 50 6Z"/>' +
      '<path ' + W + ' ' + S + ' d="M50 58C56 66 62 70 62 79C62 87 56 92 50 92C44 92 38 87 38 79C38 70 45 66 50 58Z"/>',
    person: '<circle ' + W + ' ' + S + ' cx="50" cy="24" r="15"/><path ' + W + ' ' + S + ' d="M22 94V66A28 28 0 0 1 78 66V94Z"/>',
    calendar: '<rect ' + W + ' ' + S + ' x="10" y="18" width="80" height="74" rx="10"/>' +
      '<path ' + G + ' ' + S + ' d="M10 40V28A10 10 0 0 1 20 18H80A10 10 0 0 1 90 28V40Z"/>' +
      '<line ' + S + ' x1="32" y1="8" x2="32" y2="26"/><line ' + S + ' x1="68" y1="8" x2="68" y2="26"/>',
    money: '<rect ' + G + ' ' + S + ' x="6" y="26" width="88" height="50" rx="8"/>' +
      '<circle ' + W + ' ' + S + ' cx="50" cy="51" r="14"/>' +
      '<path fill="none" stroke="#111111" stroke-width="4.5" stroke-linecap="round" d="M56 45C54 42 46 41 44 45C42 50 58 51 56 57C54 61 46 61 44 57M50 39V63"/>' +
      '<circle ' + K + ' cx="20" cy="51" r="3.5"/><circle ' + K + ' cx="80" cy="51" r="3.5"/>',
    yogurt: '<path ' + W + ' ' + S + ' d="M20 34H80L72 92H28Z"/><path ' + G + ' ' + S + ' d="M24 56H77L74 74H26Z"/>' +
      '<rect ' + W + ' ' + S + ' x="14" y="22" width="72" height="13" rx="5"/>',
    chicken: '<path ' + W + ' ' + S + ' d="M62 8C80 8 92 22 92 38C92 56 74 66 58 64L44 78A9 9 0 1 1 32 70A9 9 0 1 1 26 58L40 46C38 28 46 8 62 8Z"/>' +
      '<path ' + N + ' stroke="#111111" stroke-width="5" stroke-linecap="round" d="M60 22C70 22 78 28 80 38"/>',
    bed: '<rect ' + W + ' ' + S + ' x="6" y="46" width="88" height="30" rx="6"/>' +
      '<rect ' + W + ' ' + S + ' x="12" y="34" width="22" height="14" rx="6"/>' +
      '<path ' + G + ' ' + S + ' d="M38 46V36A6 6 0 0 1 44 30H88A6 6 0 0 1 94 36V60H38Z"/>' +
      '<line ' + S + ' x1="10" y1="76" x2="10" y2="90"/><line ' + S + ' x1="90" y1="76" x2="90" y2="90"/>',
    scale: '<rect ' + W + ' ' + S + ' x="8" y="16" width="84" height="76" rx="18"/>' +
      '<path ' + G + ' ' + S + ' d="M24 46A26 26 0 0 1 76 46Z"/>' +
      '<line class="needle" ' + S + ' x1="50" y1="46" x2="50" y2="26"/>',
    arrowUp: '<path ' + G + ' ' + S + ' d="M50 8L88 50H64V92H36V50H12Z"/>',
    arrowDown: '<path ' + G + ' ' + S + ' d="M50 92L88 50H64V8H36V50H12Z"/>',
    check: '<circle ' + G + ' ' + S + ' cx="50" cy="50" r="42"/><path ' + N + ' stroke="#111111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" d="M30 52L44 66L72 36"/>',
    cross: '<circle ' + W + ' ' + S + ' cx="50" cy="50" r="42"/><path ' + N + ' stroke="#111111" stroke-width="9" stroke-linecap="round" d="M34 34L66 66M66 34L34 66"/>',
    magnifier: '<line ' + S + ' stroke-width="12" x1="64" y1="64" x2="90" y2="90"/><circle ' + W + ' ' + S + ' cx="42" cy="42" r="30"/>' +
      '<path ' + N + ' stroke="#2ef06e" stroke-width="6" stroke-linecap="round" d="M26 40A16 16 0 0 1 40 26"/>',
    doc: '<path ' + W + ' ' + S + ' d="M20 8H62L80 26V92H20Z"/><path ' + G + ' ' + S + ' d="M62 8V26H80Z"/>' +
      '<g ' + S + '><line x1="32" y1="44" x2="68" y2="44"/><line x1="32" y1="58" x2="68" y2="58"/><line x1="32" y1="72" x2="56" y2="72"/></g>',
    bolt: '<path ' + G + ' ' + S + ' d="M58 6L18 56H46L40 94L82 40H54Z"/>',
    muscle: '<path ' + W + ' ' + S + ' d="M14 88C12 70 18 56 30 50L44 22C48 14 58 14 62 22L66 32L56 40L52 34L46 50C58 44 74 46 82 58C90 70 84 88 70 88Z"/>' +
      '<path ' + N + ' stroke="#2ef06e" stroke-width="7" stroke-linecap="round" d="M50 66C58 60 68 62 72 70"/>',
    body: '<circle ' + W + ' ' + S + ' cx="50" cy="12" r="9"/>' +
      '<path ' + W + ' ' + S + ' d="M36 26H64L70 58L62 60L60 44V94H52V64H48V94H40V44L38 60L30 58Z"/>',
    tray: '<rect ' + W + ' ' + S + ' x="6" y="20" width="88" height="60" rx="10"/>' +
      '<circle ' + G + ' ' + S + ' cx="32" cy="50" r="14"/><rect ' + W + ' ' + S + ' x="54" y="34" width="28" height="14" rx="5"/>' +
      '<rect ' + W + ' ' + S + ' x="54" y="54" width="28" height="14" rx="5"/>',
    brain: '<path ' + W + ' ' + S + ' d="M50 16C42 8 26 10 24 24C12 26 8 40 16 48C8 56 12 72 24 72C26 86 42 90 50 82C58 90 74 86 76 72C88 72 92 56 84 48C92 40 88 26 76 24C74 10 58 8 50 16Z"/>' +
      '<line ' + S + ' x1="50" y1="16" x2="50" y2="82"/>'
  };

  // Put icon `name` into `host` as an absolutely positioned box (x, y = top-left, size in px).
  // Returns the wrapper div (animate it; its <svg> holds named parts like .hand-m / .needle).
  function icon(name, host, x, y, size, css) {
    const d = div("xx-icon", host, "left:" + x + "px;top:" + y + "px;width:" + size + "px;height:" + size + "px;" + (css || ""));
    d.innerHTML = '<svg viewBox="0 0 100 100" xmlns="' + NS + '">' + ICONS[name] + "</svg>";
    return d;
  }

  // ---------------------------------------------------------------- gauge
  // Half-dial gauge (hormone level, metabolism): grey track, green level arc, ink needle.
  // `host` gets a w x (w * 0.62) box at (x, y).  Returns { el, needle, arc, set(tl, from, to, at, dur, ease) }
  // with level 0..1 (0 = needle left, 1 = right).  Label text is up to the graphic.
  function gauge(host, x, y, w, opts) {
    const o = Object.assign({ level: 0.5, stroke: 34 }, opts || {});
    const h = w * 0.62;
    const el = div("", host, "position:absolute;left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px;");
    const svg = svgEl("svg", { width: w, height: h, viewBox: "0 0 200 124" }, el);
    svg.style.overflow = "visible";
    const arcD = "M20 110A80 80 0 0 1 180 110";
    svgEl("path", { d: arcD, fill: "none", stroke: C.line, "stroke-width": o.stroke * 200 / w * 2.2, "stroke-linecap": "round" }, svg);
    const arc = svgEl("path", { d: arcD, fill: "none", stroke: C.green, "stroke-width": o.stroke * 200 / w * 2.2,
      "stroke-linecap": "round", pathLength: 100, "stroke-dasharray": "100 100", "stroke-dashoffset": 100 - o.level * 100 }, svg);
    svgEl("path", { d: arcD, fill: "none", stroke: C.ink, "stroke-width": 3, opacity: 0.0 }, svg);
    const needle = svgEl("g", {}, svg);
    svgEl("line", { x1: 100, y1: 110, x2: 100, y2: 42, stroke: C.ink, "stroke-width": 9, "stroke-linecap": "round" }, needle);
    svgEl("circle", { cx: 100, cy: 110, r: 13, fill: C.ink }, svg);
    svgEl("circle", { cx: 100, cy: 110, r: 5, fill: C.green }, svg);
    const ang = function (v) { return -90 + 180 * v; };
    needle.setAttribute("transform", "rotate(" + ang(o.level) + " 100 110)");
    const state = { v: o.level };
    function set(tl, from, to, at, dur, ease) {
      tl.fromTo(state, { v: from }, { v: to, duration: dur, ease: ease || "power2.inOut",
        onUpdate: function () {
          needle.setAttribute("transform", "rotate(" + ang(state.v) + " 100 110)");
          arc.setAttribute("stroke-dashoffset", 100 - state.v * 100);
        } }, at);
    }
    return { el: el, needle: needle, arc: arc, set: set };
  }

  // ---------------------------------------------------------------- background
  // Paper with a drifting dot grid and two slow soft green blobs; call first so it sits at the back.
  // opts: { seed, blobs (true) }
  function bg(tl, host, dur, opts) {
    const o = Object.assign({ seed: 7, blobs: true }, opts || {});
    const r = rng(o.seed);
    const wrap = div("xx-bg");
    const dots = div("xx-dots", wrap);
    dots.setAttribute("data-layout-allow-overflow", "");
    const blobs = [];
    if (o.blobs) {
      const spots = [[-260 + r() * 200, -320 + r() * 160, 760], [1380 + r() * 160, 620 + r() * 140, 820]];
      spots.forEach(function (s) {
        const b = div("xx-blob", wrap, "left:" + s[0] + "px;top:" + s[1] + "px;width:" + s[2] + "px;height:" + s[2] + "px;");
        b.setAttribute("data-layout-allow-overflow", "");
        blobs.push(b);
      });
    }
    host.insertBefore(wrap, host.firstChild);
    tl.fromTo(dots, { x: 0, y: 0 }, { x: -40, y: -20, duration: dur, ease: "none" }, 0);
    blobs.forEach(function (b, i) {
      tl.fromTo(b, { x: 0, y: 0, scale: 1 }, { x: i ? -50 : 60, y: i ? -30 : 40, scale: 1.08, duration: dur, ease: "sine.inOut" }, 0);
    });
    return wrap;
  }

  // Slow push-in on a camera wrapper for the whole duration.
  function push(tl, el, dur, from, to) {
    tl.fromTo(el, { scale: from || 1 }, { scale: to || 1.04, duration: dur, ease: "none", transformOrigin: "50% 50%" }, 0);
  }

  // Shrink an element's font-size until it fits maxW x maxH (inline-block elements).
  function fit(el, maxW, maxH, minPx) {
    let px = parseFloat(getComputedStyle(el).fontSize);
    const floor = minPx || 36;
    while (px > floor && (el.scrollWidth > maxW || (maxH && el.scrollHeight > maxH))) {
      px -= 2;
      el.style.fontSize = px + "px";
    }
    return px;
  }

  // Split text into inline-block word spans (for word-by-word entrances).  Colour words AFTER splitting.
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

  // Count a spoken number up to its value (short: <= 0.7 s; end on the exact spoken value).
  function count(tl, el, from, to, at, dur, fmt) {
    const o = { v: from };
    const f = fmt || function (v) { return String(Math.round(v)); };
    el.textContent = f(from);
    tl.to(o, { v: to, duration: dur, ease: "power2.out", onUpdate: function () { el.textContent = f(o.v); } }, at);
    return o;
  }

  // Pop an element in (scale + fade) at `at`.
  function pop(tl, el, at, opts) {
    const o = Object.assign({ from: 0.6, dur: 0.45, ease: "back.out(2)" }, opts || {});
    tl.fromTo(el, { opacity: 0, scale: o.from }, { opacity: 1, scale: 1, duration: o.dur, ease: o.ease }, at);
  }

  // Wait for every kit font weight (JS-built text may need weights document.fonts.ready skips).
  function fonts() {
    return Promise.all(["600 60px 'Barlow Condensed'", "700 60px 'Barlow Condensed'", "800 60px 'Barlow Condensed'",
      "900 60px 'Barlow Condensed'", "500 60px Barlow", "600 60px Barlow", "700 60px Barlow"]
      .map(function (f) { return document.fonts.load(f); })).then(function () { return document.fonts.ready; });
  }

  return { C: C, rng: rng, div: div, svgEl: svgEl, ICONS: ICONS, icon: icon, gauge: gauge, bg: bg, push: push,
    fit: fit, words: words, count: count, pop: pop, fonts: fonts };
})();
