/* Shalhevet Mehatevet. One script for both languages and all pages.
   Every text shown by this script is read from the page (data attributes / hidden blocks), never hard-coded here. */
(function () {
  'use strict';

  var doc = document;
  var $ = function (sel, ctx) { return (ctx || doc).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };
  var hasIO = 'IntersectionObserver' in window;
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function track(category, action, name) {
    if (window._paq) window._paq.push(['trackEvent', category, action, name || '']);
  }

  /* ---------- Header: mobile menu + scrolled state ---------- */
  var header = $('.site-header');
  var toggle = $('.menu-toggle');
  var nav = $('#site-nav');

  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  if (header && toggle && nav) {
    var isOpen = function () { return toggle.getAttribute('aria-expanded') === 'true'; };
    var setOpen = function (open, returnFocus) {
      header.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open && returnFocus) toggle.focus();
    };
    toggle.addEventListener('click', function () { setOpen(!isOpen()); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    doc.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && isOpen()) setOpen(false, true);
    });
    doc.addEventListener('click', function (e) { if (isOpen() && !header.contains(e.target)) setOpen(false); });
    header.addEventListener('focusout', function (e) {
      if (isOpen() && e.relatedTarget && !header.contains(e.relatedTarget)) setOpen(false);
    });
    window.addEventListener('resize', function () { if (isOpen() && toggle.offsetParent === null) setOpen(false); });
  }

  /* ---------- Lead form ---------- */
  var form = $('#lead-form');
  var field = function (name) { return form.elements.namedItem(name); };
  var chosenProgram = function () { return form ? field('program').value : ''; };

  /* ---------- Clicks: program preselection + contact events ---------- */
  doc.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var program = a.getAttribute('data-program');
    var loc = a.getAttribute('data-loc') || '';

    if (program && form && href.slice(-8) === '#contact') {
      var radio = $('input[name="program"][value="' + program + '"]', form);
      if (radio) radio.checked = true;
    }

    if (a.hasAttribute('data-fallback')) track('Lead', 'fallback_whatsapp', chosenProgram());
    else if (href.indexOf('https://wa.me/') === 0) track('Contact', 'whatsapp', loc);
    else if (a.hasAttribute('data-instagram')) track('Contact', 'instagram', loc);
    else if (href.indexOf('tel:') === 0) track('Contact', 'phone', loc);
  });

  if (form && window.fetch) {
    var openedAt = Date.now();
    var submitBtn = $('[type="submit"]', form);
    var submitLabel = $('.btn__label', submitBtn) || submitBtn;
    var idleLabel = submitLabel.textContent;
    var errorBox = $('#lead-error');
    var successBox = $('#lead-success');
    var fallback = errorBox ? $('[data-fallback]', errorBox) : null;
    var checked = ['name', 'phone', 'consent'];
    var busy = false;
    var SEND_TIMEOUT = 25000;

    var rules = {
      name: function () { var v = field('name').value.trim(); return v.length >= 2 && v.length <= 80; },
      phone: function () {
        var digits = field('phone').value.replace(/[\s\-()]/g, '').replace(/^\+/, '');
        return /^\d{7,15}$/.test(digits);
      },
      consent: function () { return field('consent').checked; }
    };

    /* Writes a message as text; a phone number inside it is kept on one line. */
    var setMessage = function (box, msg) {
      box.textContent = '';
      msg.split(/(\d[\d-]{5,}\d)/).forEach(function (part, i) {
        if (!part) return;
        if (i % 2 === 0) { box.appendChild(doc.createTextNode(part)); return; }
        var num = doc.createElement('span');
        num.className = 'text-nowrap';
        num.dir = 'ltr';
        num.textContent = part;
        box.appendChild(num);
      });
    };

    var setError = function (name, invalid) {
      var input = field(name);
      var box = $('#lead-' + name + '-error');
      /* Always explicit: without the attribute browsers report an unticked required checkbox as invalid from the start. */
      input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      if (box) setMessage(box, invalid ? (box.getAttribute('data-msg') || '') : '');
    };

    var setBusy = function (on) {
      busy = on;
      submitBtn.disabled = on;
      submitLabel.textContent = on ? (submitBtn.getAttribute('data-sending') || idleLabel) : idleLabel;
      if (on) form.setAttribute('aria-busy', 'true');
      else form.removeAttribute('aria-busy');
    };

    var showFieldErrors = function (names) {
      names.forEach(function (n) { setError(n, true); });
      field(names[0]).focus();
    };

    var showSuccess = function (data) {
      form.hidden = true;
      successBox.hidden = false;
      successBox.focus();
      track('Lead', 'submit', data.program);
    };

    /* Any failure: keep what she typed and offer to send the same details on WhatsApp. */
    var showFailure = function (data) {
      setBusy(false);
      if (!errorBox) return;
      if (fallback) {
        var d = errorBox.dataset;
        var picked = $('input[name="program"]:checked', form);
        var programLabel = picked && picked.parentNode ? picked.parentNode.textContent.trim() : data.program;
        var lines = [d.intro, d.lName + ': ' + data.name, d.lPhone + ': ' + data.phone, d.lProgram + ': ' + programLabel];
        if (data.note) lines.push(d.lNote + ': ' + data.note);
        fallback.href = fallback.href.split('?')[0] + '?text=' + encodeURIComponent(lines.join('\n'));
      }
      errorBox.hidden = false;
      errorBox.focus();
    };

    checked.forEach(function (name) {
      var input = field(name);
      input.addEventListener(name === 'consent' ? 'change' : 'input', function () {
        if (input.getAttribute('aria-invalid') === 'true' && rules[name]()) setError(name, false);
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;

      var invalid = checked.filter(function (name) {
        var ok = rules[name]();
        setError(name, !ok);
        return !ok;
      });
      if (invalid.length) { field(invalid[0]).focus(); return; }

      var data = {
        name: field('name').value.trim(),
        phone: field('phone').value.trim(),
        program: chosenProgram(),
        note: field('note').value.trim(),
        consent: true,
        lang: field('lang').value,
        website: field('website').value,
        t: Date.now() - openedAt,
        page: location.pathname
      };
      field('t').value = String(data.t);
      if (errorBox) errorBox.hidden = true;
      setBusy(true);

      /* A request that stalls (weak signal, slow backend) is given up after 25 s, longer than the server's own
         email timeout, and handled like any other failure. */
      var ctrl = window.AbortController ? new AbortController() : null;
      var settled = false;
      var settle = function (fn) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      var timer = setTimeout(function () {
        settle(function () { showFailure(data); });
        if (ctrl) ctrl.abort();
      }, SEND_TIMEOUT);

      fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          settle(function () {
            if (res.ok && body && body.ok === true) { showSuccess(data); return; }
            var fields = res.status === 400 && body && body.fields ? body.fields : null;
            var known = fields ? checked.filter(function (name) { return fields[name]; }) : [];
            if (known.length) { setBusy(false); showFieldErrors(known); return; }
            showFailure(data);
          });
        });
      }).catch(function () { settle(function () { showFailure(data); }); });
    });
  }

  /* ---------- Mobile sticky bar + desktop floating WhatsApp button ---------- */
  var stickyBar = $('.sticky-bar');
  var floatBtn = $('.wa-float');
  var heroCta = $('[data-hero-cta]');
  var zones = $$('[data-cta-zone]');

  if (hasIO && (stickyBar || floatBtn)) {
    var heroVisible = !!heroCta;
    var zoneVisible = zones.map(function () { return false; });
    var applyCta = function () {
      var inZone = zoneVisible.indexOf(true) > -1;
      if (stickyBar) stickyBar.classList.toggle('is-visible', !heroVisible && !inZone);
      if (floatBtn) floatBtn.classList.toggle('is-hidden', heroVisible || inZone);
    };
    var ctaObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.target === heroCta) heroVisible = entry.isIntersecting;
        else zoneVisible[zones.indexOf(entry.target)] = entry.isIntersecting;
      });
      applyCta();
    });
    if (heroCta) ctaObserver.observe(heroCta);
    zones.forEach(function (zone) { ctaObserver.observe(zone); });
    applyCta();
  }

  /* ---------- Reveal on scroll (only for content that starts below the fold) ---------- */
  if (hasIO && !reduceMotion) {
    var fold = window.innerHeight * 0.92;
    var targets = $$('[data-reveal]').filter(function (el) { return el.getBoundingClientRect().top > fold; });
    if (targets.length) {
      var revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -6% 0px' });
      targets.forEach(function (el) { el.classList.add('reveal'); revealObserver.observe(el); });
    }
  }

  /* ---------- Language suggestion (English page, Hebrew browser) ---------- */
  var langBar = $('#lang-suggest');
  if (langBar) {
    var KEY = 'sm-lang-suggest-dismissed';
    var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    var prefersHebrew = Array.prototype.some.call(langs, function (l) { return /^(he|iw)\b/i.test(l || ''); });
    var dismissed = false;
    try { dismissed = window.localStorage.getItem(KEY) === '1'; } catch (err) { /* storage unavailable */ }
    if (prefersHebrew && !dismissed) langBar.hidden = false;
    var closeBtn = $('button', langBar);
    if (closeBtn) closeBtn.addEventListener('click', function () {
      langBar.hidden = true;
      try { window.localStorage.setItem(KEY, '1'); } catch (err) { /* storage unavailable */ }
    });
  }
})();
