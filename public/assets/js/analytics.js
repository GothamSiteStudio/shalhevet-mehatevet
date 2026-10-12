/* Matomo (self-hosted). Loaded only on the production hostname so previews and localhost stay out of the stats. */
(function () {
  'use strict';
  if (location.hostname !== 'shalhevetmehatevet.com') return;
  var _paq = window._paq = window._paq || [];
  _paq.push(['setDocumentTitle', document.domain + '/' + document.title]);
  _paq.push(['setCookieDomain', '*.shalhevetmehatevet.com']);
  _paq.push(['setDomains', ['*.shalhevetmehatevet.com']]);
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  var u = 'https://matomo.alphalockandsafe.com/matomo/';
  _paq.push(['setTrackerUrl', u + 'matomo.php']);
  _paq.push(['setSiteId', '28']);
  var g = document.createElement('script');
  g.async = true;
  g.src = u + 'matomo.js';
  document.head.appendChild(g);
})();
