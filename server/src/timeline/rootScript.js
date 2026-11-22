// VidAI's fixed root script (docs/SPEC.md section 10, profile rule 9).
//
// `index.html` holds no animation of its own: its one inline script registers a paused GSAP timeline
// for the root composition with a single empty tween as long as the root's `data-duration`. The length
// is read from the attribute when the page runs, so a hand edit that changes the duration never touches
// the script. The toolkit's exporter writes exactly `ROOT_SCRIPT`; the profile compares it exactly
// after trimming (line endings normalised, so a file that went through CRLF conversion still matches).

export const ROOT_SCRIPT = `(function () {
  window.__timelines = window.__timelines || {};
  var root = document.getElementById("root");
  var length = Math.max(0, Number(root.getAttribute("data-duration")) || 0);
  var timeline = gsap.timeline({ paused: true });
  timeline.to({}, { duration: length }, 0);
  window.__timelines["main"] = timeline;
})();`;

/**
 * @param {string} text The text between `<script>` and `</script>`.
 * @returns {boolean} Whether it is VidAI's root script.
 */
export function isRootScript(text) {
  return text.replace(/\r\n?/g, "\n").trim() === ROOT_SCRIPT;
}
