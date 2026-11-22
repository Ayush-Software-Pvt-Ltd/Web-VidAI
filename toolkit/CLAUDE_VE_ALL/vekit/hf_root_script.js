(function () {
  window.__timelines = window.__timelines || {};
  var root = document.getElementById("root");
  var length = Math.max(0, Number(root.getAttribute("data-duration")) || 0);
  var timeline = gsap.timeline({ paused: true });
  timeline.to({}, { duration: length }, 0);
  window.__timelines["main"] = timeline;
})();
