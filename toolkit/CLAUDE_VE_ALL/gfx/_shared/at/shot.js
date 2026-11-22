/* Apna Trader screenshot rig: a website / circular screenshot on a sheet over the AT background,
   a camera that travels between targets, gold highlighter marks that draw on the words the host
   reads, an optional tag chip (top left) and a one-line Hindi caption bar (bottom).
   Needs at.js + at.css + gsap.  Layout canvas 1920x1080.  Deterministic and seek-safe.

   ATShot.build(tl, root, {
     dur,                      seconds (the composition's data-duration)
     src, iw, ih,              image path (inside the project, e.g. "assets/x.png") and its pixel size
     seed,                     background seed
     tag,                      optional chip text top left, e.g. "SEBI Circular · 4.2.1"
     cams: [{at, box:[x,y,w,h], zoom, move}]
                               camera targets in IMAGE pixels; the first one is the opening framing
                               (at 0); `zoom` caps the scale (default 1.35); `move` = travel seconds
     marks: [{at, box:[x,y,w,h], style:"hl"|"box"|"ul", dur, tone}]
                               highlighter (default), outline box or underline, in IMAGE pixels
     captions: [{at, text}]    caption bar lines; the first slides in, later ones replace it
   })
   The page is seen through a rounded viewer panel at x 60-1860, y (tag ? 130 : 60) to
   (captions ? 876 : 1020); a camera target fills the viewer minus 36 px padding. */
window.ATShot = (function () {
  function el(cls, parent, tag) {
    const d = document.createElement(tag || "div");
    if (cls) d.className = cls;
    parent.appendChild(d);
    return d;
  }

  function build(tl, root, o) {
    const dur = o.dur;
    const hasCap = o.captions && o.captions.length;
    // the page is seen through a rounded viewer panel; the camera moves inside it
    const win = { x0: 60, x1: 1860, y0: o.tag ? 130 : 60, y1: hasCap ? 876 : 1020 };
    AT.bg(tl, root, dur, { seed: o.seed || 7 });
    const view = el("ats-view", root);
    view.style.left = win.x0 + "px";
    view.style.top = win.y0 + "px";
    view.style.width = (win.x1 - win.x0) + "px";
    view.style.height = (win.y1 - win.y0) + "px";
    const cam = el("ats-cam", view);
    const page = el("ats-page", cam);
    page.setAttribute("data-layout-allow-overflow", "");
    cam.setAttribute("data-layout-allow-overflow", "");
    page.style.width = o.iw + "px";
    page.style.height = o.ih + "px";
    const img = el("", page, "img");
    img.src = o.src;
    img.style.width = o.iw + "px";
    img.style.height = o.ih + "px";
    const pad = 36;                               // breathing room inside the viewer
    const vw = win.x1 - win.x0 - 2 * pad, vh = win.y1 - win.y0 - 2 * pad;
    const wcx = (win.x1 - win.x0) / 2, wcy = (win.y1 - win.y0) / 2;

    function state(c, grow) {
      const b = c.box;
      const s = Math.min(vw / b[2], vh / b[3], c.zoom || 1.35) * (grow || 1);
      return { x: wcx - s * (b[0] + b[2] / 2), y: wcy - s * (b[1] + b[3] / 2), scale: s };
    }

    // camera path: enter on the first target, then travel; drift (3 %) between moves
    const cams = o.cams;
    const s0 = state(cams[0]);
    gsap.set(cam, { transformOrigin: "0 0" });
    tl.fromTo(view, { y: 70, scale: 0.96, opacity: 0 },
      { y: 0, scale: 1, opacity: 1, duration: 0.45, ease: "power3.out", transformOrigin: "50% 50%" }, 0);
    tl.fromTo(cam, { x: s0.x, y: s0.y, scale: s0.scale * 0.92 },
      { x: s0.x, y: s0.y, scale: s0.scale, duration: 0.5, ease: "power3.out" }, 0);
    let prev = s0, t = 0.5;
    cams.forEach(function (c, i) {
      const start = i === 0 ? 0.5 : c.at;
      const end = i + 1 < cams.length ? cams[i + 1].at : dur;
      if (i > 0) {
        const mv = Math.min(c.move || 0.8, Math.max(0.3, end - start - 0.2));
        const to = state(c);
        tl.fromTo(cam, { x: prev.x, y: prev.y, scale: prev.scale },
          { x: to.x, y: to.y, scale: to.scale, duration: mv, ease: "power3.inOut", immediateRender: false }, start);
        prev = to;
        t = start + mv;
      } else {
        t = start;
      }
      if (end - t > 0.05) {
        const g = state(c, 1.03);
        tl.fromTo(cam, { x: prev.x, y: prev.y, scale: prev.scale },
          { x: g.x, y: g.y, scale: g.scale, duration: end - t, ease: "none", immediateRender: false }, t);
        prev = g;
      }
    });

    (o.marks || []).forEach(function (m) {
      const b = m.box;
      const style = m.style || "hl";
      const mk = el("ats-mark ats-" + style + (m.tone ? " " + m.tone : ""), page);
      const pad = style === "ul" ? 0 : 10;
      mk.style.left = (b[0] - pad) + "px";
      mk.style.top = (style === "ul" ? b[1] + b[3] - 4 : b[1] - pad) + "px";
      mk.style.width = (b[2] + 2 * pad) + "px";
      mk.style.height = (style === "ul" ? 12 : b[3] + 2 * pad) + "px";
      const d = m.dur || 0.45;
      if (style === "box") {
        tl.fromTo(mk, { scale: 1.12, opacity: 0 }, { scale: 1, opacity: 1, duration: d * 0.7, ease: "back.out(2)", transformOrigin: "50% 50%" }, m.at);
      } else {
        tl.fromTo(mk, { scaleX: 0 }, { scaleX: 1, duration: d, ease: "power2.out", transformOrigin: "0% 50%" }, m.at);
      }
    });

    if (o.tag) {
      const chip = el("ats-tag at-chip", root);
      chip.textContent = o.tag;
      tl.fromTo(chip, { x: -60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: "power3.out" }, 0.15);
    }

    if (hasCap) {
      const bar = el("ats-cap", root);
      bar.setAttribute("data-layout-allow-overflow", "");
      bar.setAttribute("data-layout-allow-overlap", "");
      const lines = o.captions.map(function (c) {
        const l = el("ats-line", bar);
        const s = el("", l, "span");
        s.textContent = c.text;
        AT.fit(s, 1560, 96, 40);
        return l;
      });
      tl.fromTo(bar, { y: 220 }, { y: 0, duration: 0.45, ease: "power3.out" }, o.captions[0].at);
      lines.forEach(function (l, i) {
        const at = o.captions[i].at;
        if (i > 0) {
          // waiting lines are hidden (they sit outside the bar, over the page)
          tl.fromTo(l, { y: 140, visibility: "hidden" }, { y: 140, visibility: "hidden", duration: 0.01 }, 0);
          tl.fromTo(l, { y: 140, visibility: "visible" }, { y: 0, visibility: "visible", duration: 0.4, ease: "power3.out", immediateRender: false }, at);
          const prev = lines[i - 1];
          tl.fromTo(prev, { y: 0 }, { y: -140, duration: 0.4, ease: "power3.in", immediateRender: false }, at - 0.05);
          tl.fromTo(prev, { visibility: "visible" }, { visibility: "hidden", duration: 0.01, immediateRender: false }, at + 0.36);
        }
      });
    }
    return { cam: cam, page: page };
  }

  return { build: build };
})();
