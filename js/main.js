/* RK NAMI — lapas uzvedība
   1. Krāsu variants (?variants=daugava | misins)
   2. Header ēna ritinot
   3. Mobilā izvēlne
   4. Aktīvā sadaļa izvēlnē
   5. Parādīšanās ritinot
   6. Kontaktforma (POST /api/contact → Mailjet)
   7. Sīkdatņu piekrišana + analītika tikai pēc piekrišanas */

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
    if (!form) return; // apakšlapās (piem., privātuma politika) formas nav
    var status = form.querySelector('.form-status');
    var submit = form.querySelector('button[type="submit"]');
    var submitLabel = submit.textContent;
    var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
    var PHONE_RE = /^[0-9+()\-.\s]{6,30}$/;
    var sending = false;
    var startedAt = Date.now();
    var submissionId = newId();

    // Viens ID uz katru aizpildīto formu — serveris pēc tā ignorē dublikātus
    function newId() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }

    function say(text, kind) {
      status.textContent = text;
      status.className = 'form-status' + (kind ? ' is-' + kind : '');
    }

    function checkField(field) {
      var v = field.type === 'checkbox' ? field.checked : field.value.trim();
      switch (field.name) {
        case 'name': return v.length >= 2 && v.length <= 100;
        case 'email': return v.length <= 254 && EMAIL_RE.test(v);
        case 'phone': return v === '' || PHONE_RE.test(v);
        case 'address': return v.length <= 200;
        case 'subject': return v.length >= 2 && v.length <= 150;
        case 'message': return v.length >= 10 && v.length <= 5000;
        case 'consent': return v === true;
        default: return true;
      }
    }

    function markField(field, valid) {
      var error = document.getElementById(field.id + '-error');
      if (valid) field.removeAttribute('aria-invalid');
      else field.setAttribute('aria-invalid', 'true');
      if (error) error.hidden = valid;
    }

    function fieldsToCheck() {
      return form.querySelectorAll('.field input, .field textarea');
    }

    function validate() {
      var first = null;
      fieldsToCheck().forEach(function (field) {
        var valid = checkField(field);
        markField(field, valid);
        if (!valid && !first) first = field;
      });
      if (first) first.focus();
      return !first;
    }

    // Kļūdu noņem, tiklīdz lauks ir izlabots; jaunu kļūdu rāda tikai pēc lauka pamešanas
    form.addEventListener('input', function (e) {
      if (e.target.getAttribute('aria-invalid') === 'true' && checkField(e.target)) markField(e.target, true);
    });
    form.addEventListener('change', function (e) {
      if (e.target.type === 'checkbox' && e.target.getAttribute('aria-invalid') === 'true') markField(e.target, checkField(e.target));
    });
    form.addEventListener('focusout', function (e) {
      var f = e.target;
      if (!f.closest || !f.closest('.field') || f.type === 'checkbox') return;
      if (f.value.trim() !== '' || f.getAttribute('aria-invalid') === 'true') markField(f, checkField(f));
    });

    function setBusy(busy) {
      sending = busy;
      submit.disabled = busy;
      form.setAttribute('aria-busy', String(busy));
      submit.textContent = busy ? form.dataset.msgSending : submitLabel;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sending) return;
      var d = form.dataset;
      if (!validate()) { say(d.msgInvalid, 'error'); return; }

      var payload = {
        name: form.elements.name.value,
        email: form.elements.email.value,
        phone: form.elements.phone.value,
        address: form.elements.address.value,
        subject: form.elements.subject.value,
        message: form.elements.message.value,
        consent: form.elements.consent.checked,
        website: form.elements.website.value,
        startedAt: startedAt,
        submissionId: submissionId
      };

      setBusy(true);
      say('');
      fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (res.ok && body.ok) {
              form.reset();
              fieldsToCheck().forEach(function (f) { markField(f, true); });
              submissionId = newId();
              startedAt = Date.now();
              say(d.msgSent, 'ok');
              return;
            }
            if (res.status === 400 && body.fields) {
              var first = null;
              Object.keys(body.fields).forEach(function (name) {
                var f = form.elements[name];
                if (!f) return;
                markField(f, false);
                if (!first) first = f;
              });
              if (first) first.focus();
              say(d.msgInvalid, 'error');
              return;
            }
            say(res.status === 429 ? d.msgRate : d.msgError, 'error');
          });
        })
        .catch(function () { say(d.msgError, 'error'); })
        .then(function () { setBusy(false); });
    });
  });

  /* ---------- 7. Sīkdatņu piekrišana ----------
     Baneri ģenerē šeit, nevis katrā HTML failā — main.js ielādē visas lapas.
     Pēc noklusējuma darbojas tikai nepieciešamās funkcijas; analītika tiek
     ielādēta vienīgi pēc "Piekrītu visām". Izvēle: localStorage
     "rknami_cookie_consent" = "all" | "necessary". */
  var CONSENT_KEY = 'rknami_cookie_consent';
  var analyticsLoaded = false;

  function readConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }

  function saveConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* privātais režīms — izvēle derēs tikai šai lapai */ }
  }

  function loadScript(src) {
    var s = document.createElement('script');
    s.src = src;
    s.defer = true;
    document.head.appendChild(s);
  }

  function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;

    // Vercel Web Analytics
    loadScript('/_vercel/insights/script.js');

    /* Google Analytics / GTM — ievietot ŠEIT, lai tie ielādētos tikai pēc piekrišanas.
       Piemērs (GA4, aizstāt G-XXXXXXX ar īsto ID):
         window.dataLayer = window.dataLayer || [];
         window.gtag = function () { dataLayer.push(arguments); };
         gtag('js', new Date());
         gtag('config', 'G-XXXXXXX');
         loadScript('https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX');
       GTM gadījumā: loadScript('https://www.googletagmanager.com/gtm.js?id=GTM-XXXXXXX')
       pēc dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' }).
       Tos pašus skriptus NEDRĪKST likt HTML <head> — tad tie ielādētos bez piekrišanas. */
  }

  function showConsentBanner() {
    if (document.querySelector('.consent')) return;

    var banner = document.createElement('section');
    banner.className = 'consent';
    banner.setAttribute('aria-labelledby', 'consent-title');
    banner.innerHTML =
      '<div class="consent-text">' +
        '<h2 id="consent-title" class="consent-title">Sīkdatnes un apmeklējumu statistika</h2>' +
        '<p>Mājaslapa izmanto tikai tās darbībai nepieciešamās sīkdatnes. Ja piekrītat, ieslēgsim arī anonīmu apmeklējumu statistiku, kas palīdz mums uzlabot vietni. Sīkāk — <a href="/privatuma-politika#pp-8">privātuma politikā</a>.</p>' +
      '</div>' +
      '<div class="consent-actions">' +
        '<button type="button" class="btn btn-primary" data-consent="all">Piekrītu visām</button>' +
        '<button type="button" class="btn btn-ghost" data-consent="necessary">Noraidīt analītiku</button>' +
      '</div>';
    document.body.appendChild(banner);

    // WhatsApp poga paceļas virs banera (sk. .consent-open style.css)
    function syncOffset() {
      root.style.setProperty('--consent-offset', banner.offsetHeight + 'px');
    }
    syncOffset();
    var ro = 'ResizeObserver' in window ? new ResizeObserver(syncOffset) : null;
    if (ro) ro.observe(banner);
    else window.addEventListener('resize', syncOffset);
    root.classList.add('consent-open');
    requestAnimationFrame(function () { banner.classList.add('is-visible'); });

    banner.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-consent]');
      if (!btn) return;
      var choice = btn.getAttribute('data-consent');
      saveConsent(choice);
      if (choice === 'all') loadAnalytics();

      if (ro) ro.disconnect();
      else window.removeEventListener('resize', syncOffset);
      root.classList.remove('consent-open');
      banner.classList.remove('is-visible');
      var removed = false;
      function remove() { if (!removed) { removed = true; banner.remove(); } }
      banner.addEventListener('transitionend', remove);
      setTimeout(remove, 400);
    });
  }

  function initConsent() {
    var consent = readConsent();
    if (consent === 'all') loadAnalytics();
    else if (consent !== 'necessary') showConsentBanner();

    // Privātuma politikā: poga "Mainīt sīkdatņu izvēli" (piekrišanu jāvar atsaukt tikpat viegli)
    document.addEventListener('click', function (e) {
      if (!e.target.closest('[data-consent-reset]')) return;
      try { localStorage.removeItem(CONSENT_KEY); } catch (err) { /* nav pieejams */ }
      showConsentBanner();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initConsent);
  else initConsent();
})();
