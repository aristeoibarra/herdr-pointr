// The popup used to own every setting. It doesn't any more — they moved into
// the widget, where the page you are configuring actually is. What is left is
// the one thing the widget cannot tell you: whether the bridge is up *before*
// you open a page.
(function () {
  var BRIDGE = "http://localhost:7331";
  var health = document.getElementById("health");

  fetch(BRIDGE + "/health")
    .then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      health.textContent = "bridge up";
      health.className = "health ok";
    })
    .catch(function () {
      health.textContent = "bridge offline";
      health.className = "health err";
    });
})();
