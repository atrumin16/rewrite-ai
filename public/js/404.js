(function () {
  'use strict';
  var el = document.getElementById('nf-path');
  if (el) el.textContent = window.location.pathname || '/';
})();
