(function () {
  "use strict";

  var year = document.querySelector("[data-year]");
  if (year) {
    year.textContent = String(new Date().getFullYear());
  }

  var links = document.querySelectorAll('a[target="_blank"]');
  links.forEach(function (link) {
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
  });

  var statusLine = document.querySelector("[data-status-line]");
  if (statusLine) {
    statusLine.textContent = "READY. " + links.length + " SECURE LINKS LOADED.";
  }
}());
