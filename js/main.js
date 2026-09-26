/* RK NAMI — lapas uzvedība
   1. Krāsu variants (?variants=daugava | misins)
   2. Header ēna ritinot
   3. Mobilā izvēlne
   4. Aktīvā sadaļa izvēlnē
   5. Parādīšanās ritinot
   6. Kontaktforma (Formspree/EmailJS vai mailto) */

(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------- 1. Krāsu variants ---------- */
  var theme = new URLSearchParams(location.search).get('variants');
  if (theme === 'daugava' || theme === 'misins') root.setAttribute('data-theme', theme);

  document.addEventListener('DOMContentLoaded', function () {    var header = document.getElementById('header');
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('site-nav');

    /* ---------- 2. Header ēna ---------- */
    function onScroll() {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    /* ---------- 3. Mobilā izvēlne ---------- */
    var openLabel = toggle.querySelector('.visually-hidden');
    var labelOpen = openLabel.textContent;
    var labelClose = 'Aizvērt izvēlni';

    function setMenu(open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('use').setAttribute('href', open ? '#i-close' : '#i-menu');
      openLabel.textContent = open ? labelClose : labelOpen;
    }

    toggle.addEventListener('click', function () {
      setMenu(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        setMenu(false);
        toggle.focus();
      }
    });

    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('is-visible'); });
    } else {
      /* ---------- 4. Aktīvā sadaļa ---------- */
      var links = {};
      document.querySelectorAll('.nav-list a').forEach(function (a) {
        links[a.getAttribute('href').slice(1)] = a;
      });
      var sectionObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          Object.keys(links).forEach(function (id) { links[id].removeAttribute('aria-current'); });
          var link = links[entry.target.id];
          if (link) link.setAttribute('aria-current', 'true');
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      document.querySelectorAll('main > section[id]').forEach(function (s) { sectionObserver.observe(s); });

      /* ---------- 5. Parādīšanās ---------- */
      var revealObserver = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      document.querySelectorAll('.reveal').forEach(function (el) {
        el.style.transitionDelay = (Number(el.dataset.stagger) || 0) * 90 + 'ms';
        revealObserver.observe(el);
      });
    }

    /* ---------- 6. Kontaktforma ---------- */
    var form = document.getElementById('contact-form');
    var status = form.querySelector('.form-status');
    var submit = form.querySelector('button[type="submit"]');

    function say(text, kind) {
      status.textContent = text;
      status.className = 'form-status' + (kind ? ' is-' + kind : '');
    }

    function validate() {
      var ok = true;
      form.querySelectorAll('input, textarea').forEach(function (field) {
        var valid = field.value.trim() !== '' && field.checkValidity();
        field.setAttribute('aria-invalid', String(!valid));
        if (!valid && ok) { ok = false; field.focus(); }
      });
      return ok;
    }

    form.addEventListener('input', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true' && e.target.checkValidity() && e.target.value.trim()) {
        e.target.removeAttribute('aria-invalid');
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var d = form.dataset;
      if (!validate()) { say(d.msgInvalid, 'error'); return; }

      var data = new FormData(form);
      var endpoint = d.endpoint;

      if (!endpoint) {
        var body = data.get('message') + '\n\n— ' + data.get('name') + ' (' + data.get('email') + ')';
        location.href = 'mailto:' + d.mailto +
          '?subject=' + encodeURIComponent(d.subject) +
          '&body=' + encodeURIComponent(body);
        say(d.msgMailto, 'ok');
        return;
      }

      submit.disabled = true;
      say(d.msgSending);
      fetch(endpoint, { method: 'POST', body: data, headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error(res.status);
          form.reset();
          say(d.msgSent, 'ok');
        })
        .catch(function () { say(d.msgError, 'error'); })
        .then(function () { submit.disabled = false; });
    });
  });
})();
