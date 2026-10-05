/* Brine Prospect calculator: pure math, no DOM. Shared by the site and the build/test scripts. */
(function (root) {
  'use strict';

  var BBL_L = 158.987;   // litres per oilfield barrel
  var LCE = 5.323;       // tonnes of lithium carbonate per tonne of lithium metal

  // Public benchmarks. Each is traceable to a source listed at /lithium-mineral-rights/#sources.
  var BENCH = {
    reynoldsTonnes: 22500, reynoldsAcres: 20854,           // SWA Lithium, Reynolds Brine Unit
    reynoldsConc: 442,                                     // mg/L, life-of-project average in the 2025 feasibility study
    arRoyalty: 2.5, arFee: 65.05,                          // Arkansas Oil and Gas Commission, 28 May 2025
    intensityAR: Math.round(22500 / 20854 * 100) / 100     // 1.08 t of lithium carbonate per unit acre per year
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Present value of `annual` paid once a year for `term` years, first payment at year `delay`.
  function presentValue(annual, ratePct, delay, term, growthPct) {
    var pv = 0, r = ratePct / 100, g = (growthPct || 0) / 100;
    for (var i = 0; i < term; i++) pv += annual * Math.pow(1 + g, i) / Math.pow(1 + r, delay + i);
    return pv;
  }
  function lifetime(annual, term, growthPct) {
    var t = 0, g = (growthPct || 0) / 100;
    for (var i = 0; i < term; i++) t += annual * Math.pow(1 + g, i);
    return t;
  }

  // Starting-point odds that a plant gets built, by concentration. A judgment scaffold, not a
  // measurement: the bands follow the roughly 50, 65 and 100 mg/L thresholds cited in the literature.
  function suggestProb(conc, atHub, bblDedicated) {
    var p = conc < 25 ? 10 : conc < 50 ? 20 : conc < 65 ? 30 : conc < 100 ? 45 : 60;
    if (atHub) p += 10;
    if (bblDedicated >= 50000) p += 5; else if (bblDedicated < 10000) p -= 5;
    return clamp(p, 5, 85);
  }
  // The same bands with no adjustment for one owner's volume: a plant draws water from many owners.
  function probByConc(conc) { return suggestProb(conc, false, 20000); }

  /* Produced-water stream.
     p: bbl, share(%), conc(mg/L), recovery(%), price($/t LCE), royalty(%), growth(%/yr),
        delay(yrs), term(yrs), rate(%), prob(%), autoProb(bool), atHub(bool), bonus($ per bbl/day) */
  function water(p) {
    var qd = p.bbl * p.share / 100;
    var liT = qd * BBL_L * p.conc * 365 / 1e9;
    var lceT = liT * LCE;
    var recT = lceT * p.recovery / 100;
    var gross = recT * p.price;
    var roy = gross * p.royalty / 100;
    var npv = presentValue(roy, p.rate, p.delay, p.term, p.growth);
    var prob = p.autoProb === 'conc' ? probByConc(p.conc)
      : p.autoProb ? suggestProb(p.conc, p.atHub, qd) : clamp(p.prob, 0, 100);
    var bonus = (p.bonus || 0) * qd;
    return {
      qd: qd, liT: liT, lceT: lceT, recT: recT, gross: gross,
      roy: roy, fee: 0, annual: roy,
      total: lifetime(roy, p.term, p.growth),
      npv: npv, prob: prob, bonus: bonus,
      ev: npv * prob / 100 + bonus,
      perUnit: qd > 0 ? roy / qd : 0
    };
  }

  /* Acreage inside (or headed for) a brine unit.
     p: acres, intensity(t LCE per unit acre per yr at the benchmark grade), price, royalty(%),
        fee($/acre/yr), bonus($/acre), delay, term, rate, prob
     Optional: conc and benchConc. When given, output per acre scales with concentration, which
     assumes the same brine flow per acre as the benchmark unit. autoProb 'conc' sets the odds by grade. */
  function acreage(p) {
    var perAcre = p.intensity * (p.conc !== undefined && p.benchConc ? p.conc / p.benchConc : 1);
    var lceT = p.acres * perAcre;
    var gross = lceT * p.price;
    var roy = gross * p.royalty / 100;
    var fee = p.acres * (p.fee || 0);
    var annual = roy + fee;
    var npv = presentValue(annual, p.rate, p.delay, p.term, 0);
    var prob = p.autoProb === 'conc' ? probByConc(p.conc) : clamp(p.prob, 0, 100);
    var bonus = (p.bonus || 0) * p.acres;
    return {
      perAcreT: perAcre, lceT: lceT, gross: gross, roy: roy, fee: fee, annual: annual,
      total: lifetime(annual, p.term, 0),
      npv: npv, prob: prob, bonus: bonus,
      ev: npv * prob / 100 + bonus,
      perUnit: p.acres > 0 ? annual / p.acres : 0
    };
  }

  function estimate(p) { return p.model === 'acre' ? acreage(p) : water(p); }

  // The concentration at which the estimate equals an offer, or null if no concentration gets there.
  function impliedConc(p, offer) {
    function ev(c) { var q = {}, k; for (k in p) q[k] = p[k]; q.conc = c; return estimate(q).ev; }
    var lo = 0.1, hi = 5000;
    if (offer <= ev(lo)) return { below: true };
    if (offer >= ev(hi)) return { above: true };
    for (var i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (ev(mid) < offer) lo = mid; else hi = mid; }
    return { conc: hi };
  }

  /* Where the minerals are. lo/hi bound the published concentrations for that play, typ is the most
     defensible single public figure, refs are the reference points shown beside the estimate. */
  var NOTE_TX_WATER = 'In Texas, produced water belongs to the operator unless your lease reserves it, so read your lease before you act on this number.';
  var NOTE_STATE = 'Who owns the lithium in produced water depends on your state and your lease. Check both before you act on this number.';
  var BASINS = {
    tx: { label: 'East Texas, Smackover brine', model: 'acre', play: 'the Smackover', lo: 84, typ: 84, hi: 806, delay: 5, fee: 0,
      refs: [[84, 'Median of public Smackover samples'], [396, '95th percentile of public samples'], [668, 'Franklin Project average'], [806, 'Highest reported, Franklin Project']],
      note: 'Texas has not written into statute whether lithium in deep brine goes with the minerals or the surface, so check title if the two were ever split on your land.' },
    ar: { label: 'Arkansas, Smackover brine', model: 'acre', play: 'the Smackover', lo: 84, typ: 84, hi: 549, delay: 3, fee: BENCH.arFee,
      refs: [[84, 'Median of public Smackover samples'], [396, '95th percentile of public samples'], [442, 'First approved unit, life-of-project average'], [549, 'First approved unit, at start-up']],
      note: 'In Arkansas the brine royalty goes to the mineral owner, and everyone in a unit shares it by acreage.' },
    permian: { label: 'Permian Basin, oil and gas wells', model: 'water', play: 'the Permian Basin', lo: 1, typ: 14, hi: 30, delay: 4, fee: 0,
      refs: [[1, 'Low end of public samples'], [14, 'Published Wolfcamp figure'], [30, 'High end of public samples']],
      note: NOTE_TX_WATER },
    bakken: { label: 'Williston Basin (Bakken), oil and gas wells', model: 'water', play: 'the Williston Basin', lo: 10, typ: 45, hi: 65, delay: 5, fee: 0,
      refs: [[10, 'Duperow median'], [45, 'Bakken median'], [65, 'Three Forks median, at least']],
      note: NOTE_STATE },
    marcellus: { label: 'Appalachian Basin (Marcellus), gas wells', model: 'water', play: 'the Marcellus', lo: 65, typ: 65, hi: 267, delay: 5, fee: 0,
      refs: [[65, 'Basin-wide median'], [127, 'Southwest Pennsylvania median'], [205, 'Northeast Pennsylvania median'], [267, 'Northeast Pennsylvania, 75th percentile']],
      note: NOTE_STATE },
    'other-acre': { label: 'Somewhere else, a brine lease on acreage', model: 'acre', play: 'North American brines', lo: 5, typ: 5, hi: 97, delay: 5, fee: 0,
      refs: [[5, 'Median of North American brine samples'], [65, 'Lower limit for economic production'], [97, '95th percentile of samples']],
      note: 'States treat brine differently, and some have not decided. Confirm locally which estate owns it.' },
    'other-water': { label: 'Somewhere else, oil and gas wells', model: 'water', play: 'North American brines', lo: 5, typ: 5, hi: 97, delay: 5, fee: 0,
      refs: [[5, 'Median of North American brine samples'], [65, 'Lower limit for economic production'], [97, '95th percentile of samples']],
      note: NOTE_STATE }
  };

  var api = {
    BBL_L: BBL_L, LCE: LCE, BENCH: BENCH, BASINS: BASINS, clamp: clamp,
    presentValue: presentValue, lifetime: lifetime, suggestProb: suggestProb, probByConc: probByConc,
    water: water, acreage: acreage, estimate: estimate, impliedConc: impliedConc
  };
  root.BPCalc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Brine Prospect site script: page-view counting, waitlist forms, and the calculator UI. */
(function () {
  'use strict';

  var CFG = { endpoint: '', ga4: '' };
  var userCfg = window.BP_CONFIG || {};
  Object.keys(userCfg).forEach(function (k) { CFG[k] = userCfg[k]; });

  var C = window.BPCalc;
  var $ = function (id) { return document.getElementById(id); };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  /* ------------------------------------------------------------------ tracking */
  function isBot() {
    return !!navigator.webdriver || /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor/i.test(navigator.userAgent || '');
  }
  function pagePath() {
    var own = document.documentElement.getAttribute('data-path');   // set at build time; the same on any host
    var p = own || (location.pathname || '/').replace(/index\.html$/, '');
    return (p || '/').slice(0, 120);
  }
  function device() { return (window.innerWidth || 1024) < 768 ? 'phone' : 'desktop'; }
  // Where this visit started: a utm_source tag, else the referring site, else "direct". Kept for the session.
  function source() {
    var saved = ssGet('bp_src');
    if (saved) return saved;
    var s = '';
    try { var q = new URLSearchParams(location.search); s = q.get('utm_source') || q.get('ref') || ''; } catch (e) {}
    if (!s && document.referrer) {
      try {
        var h = new URL(document.referrer).hostname.replace(/^www\./, '');
        if (h && h !== location.hostname.replace(/^www\./, '')) s = h;
      } catch (e) {}
    }
    s = (s || 'direct').toLowerCase().slice(0, 80);
    ssSet('bp_src', s);
    return s;
  }
  function post(payload) {
    if (!CFG.endpoint) return Promise.resolve({ ok: false, error: 'not_connected' });
    return fetch(CFG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }
  function beacon(payload) {
    if (!CFG.endpoint || isBot()) return;
    var body = JSON.stringify(payload);
    try { if (navigator.sendBeacon && navigator.sendBeacon(CFG.endpoint, body)) return; } catch (e) {}
    try {
      fetch(CFG.endpoint, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body });
    } catch (e) {}
  }
  function trackView() {
    var isNew = !lsGet('bp_seen');
    lsSet('bp_seen', '1');
    beacon({ type: 'view', page: pagePath(), source: source(), isNew: isNew, device: device() });
  }
  function loadGA() {
    if (!CFG.ga4 || isBot()) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(CFG.ga4);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', CFG.ga4);
  }
  function gaEvent(name, params) { if (window.gtag) { try { window.gtag('event', name, params || {}); } catch (e) {} } }

  /* ------------------------------------------------------------------ waitlist */
  function initWaitlist(form) {
    var status = form.querySelector('.wl-status');
    var btn = form.querySelector('button[type="submit"]');
    var done = form.parentNode.querySelector('.wl-done');
    var label = btn.textContent;

    function say(msg, kind) {
      status.textContent = msg;
      status.className = 'wl-status ' + (kind || '');
      status.hidden = !msg;
    }
    function fail() {
      btn.disabled = false; btn.textContent = label;
      say('We could not save that. Check your connection and try again in a minute.', 'err');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = form.elements;
      var email = (f.email.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        say('Enter a valid email address, like name@example.com.', 'err');
        f.email.focus();
        return;
      }
      if (!CFG.endpoint) {
        say('This preview is not connected to the waitlist yet, so nothing was saved.', 'warn');
        return;
      }
      btn.disabled = true; btn.textContent = 'Joining...';
      say('', '');
      post({
        type: 'signup',
        email: email,
        role: f.role ? f.role.value : '',
        state: f.state ? f.state.value : '',
        hp: f.hp ? f.hp.value : '',   // honeypot: people never see or fill this
        page: pagePath(), source: source(), device: device(),
        calc: window.__bpCalc || ''
      }).then(function (res) {
        if (!res || !res.ok) return fail();
        form.hidden = true;
        if (done) {
          done.querySelector('.wl-done-msg').textContent = 'We will email ' + email + ' when kits are available.';
          done.hidden = false;
          done.setAttribute('tabindex', '-1');
          done.focus();
        }
        lsSet('bp_joined', '1');
        gaEvent('generate_lead', { method: 'waitlist' });
      }).catch(fail);
    });
  }

  /* -------------------------------------------------------------- contact form */
  // Saves the message, then sends the visitor to the thank-you page.
  function initContact(form) {
    var status = form.querySelector('.wl-status');
    var btn = form.querySelector('button[type="submit"]');
    var label = btn.textContent;
    function say(msg, kind) { status.textContent = msg; status.className = 'wl-status ' + (kind || ''); status.hidden = !msg; }
    function fail() {
      btn.disabled = false; btn.textContent = label;
      say('We could not send that. Check your connection and try again in a minute.', 'err');
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = form.elements;
      var email = (f.email.value || '').trim(), message = (f.message.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        say('Enter a valid email address so we can reply, like name@example.com.', 'err'); f.email.focus(); return;
      }
      if (message.length < 2) { say('Write your message before sending.', 'err'); f.message.focus(); return; }
      if (!CFG.endpoint) { say('This preview is not connected yet, so the message was not sent.', 'warn'); return; }
      btn.disabled = true; btn.textContent = 'Sending...';
      say('', '');
      post({
        type: 'contact', name: (f.name.value || '').trim(), email: email, message: message,
        hp: f.hp ? f.hp.value : '', page: pagePath(), source: source()
      }).then(function (res) {
        if (!res || !res.ok) return fail();
        gaEvent('contact_sent', {});
        window.location.assign(form.getAttribute('data-thanks') || '/thanks/');
      }).catch(fail);
    });
  }

  /* ---------------------------------------------------------------- calculator */
  // Built for a mineral owner: it assumes the lithium is theirs and puts the one unknown,
  // concentration, at the centre. The spread between published low and high is the point.
  function initCalc() {
    var form = $('c-form'), out = $('c-out'), built = $('c-built');
    if (!form || !out || !C) return;

    var STORE = 'bp-calc-v2';
    var KIT = Number(form.getAttribute('data-kit-price')) || 495;
    var GUIDE = form.getAttribute('data-guide') || '';
    var FIELDS = ['c-basin', 'c-acres', 'c-bbl', 'c-conc', 'c-offer', 'c-royalty', 'c-price', 'c-rate', 'c-term',
      'c-delay', 'c-prob', 'c-fee', 'c-share', 'c-recovery'];
    var DEF = { 'c-basin': 'tx', 'c-acres': 40, 'c-bbl': 2000, 'c-conc': 84, 'c-offer': '', 'c-royalty': 2.5,
      'c-price': 15000, 'c-rate': 12, 'c-term': 20, 'c-delay': 5, 'c-prob': 45, 'c-fee': 0, 'c-share': 100,
      'c-recovery': 75, 'c-auto': true };

    function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : 0; }
    function pos(id) { return Math.max(0, num(id)); }
    function basin() { return C.BASINS[$('c-basin').value] || C.BASINS.tx; }

    /* ---- formatting ---- */
    function round3(v) {
      if (!isFinite(v) || v === 0) return 0;
      var m = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.abs(v))) - 2));
      return Math.round(v / m) * m;
    }
    function usd(v) {
      if (!isFinite(v)) return '$0';
      var a = Math.abs(v);
      if (a < 0.5) return '$0';
      if (a < 100) return '$' + Math.round(a);
      a = round3(a);
      if (a >= 1e9) return '$' + (a / 1e9).toFixed(2) + ' billion';
      if (a >= 1e6) return '$' + (a / 1e6).toFixed(2) + ' million';
      return '$' + Math.round(a).toLocaleString('en-US');
    }
    function n0(v) { return Math.round(v).toLocaleString('en-US'); }
    function mg(v) { return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString('en-US'); }
    function tonnes(v) { return v >= 100 ? n0(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2); }
    function pct(v) { return (Math.round(v * 100) / 100) + '%'; }
    function yrs(v) { return v + (v === 1 ? ' year' : ' years'); }

    /* ---- inputs to model ---- */
    function read() {
      var B = basin();
      return {
        B: B, model: B.model, conc: pos('c-conc'),
        acres: pos('c-acres'), bbl: pos('c-bbl'),
        share: C.clamp(num('c-share'), 0, 100), recovery: C.clamp(num('c-recovery'), 0, 100),
        intensity: C.BENCH.intensityAR, benchConc: C.BENCH.reynoldsConc, fee: pos('c-fee'),
        price: pos('c-price'), royalty: C.clamp(num('c-royalty'), 0, 50),
        delay: C.clamp(Math.round(num('c-delay')), 0, 20), term: C.clamp(Math.round(num('c-term')) || 1, 1, 40),
        rate: C.clamp(num('c-rate'), 0, 40), prob: C.clamp(num('c-prob'), 0, 100),
        autoProb: $('c-auto').checked ? 'conc' : false,
        growth: 0, bonus: 0, atHub: false, offer: pos('c-offer')
      };
    }
    function at(s, conc) {
      var q = {}, k;
      for (k in s) q[k] = s[k];
      q.conc = conc;
      return C.estimate(q);
    }

    /* ---- render ---- */
    var builtOpen = false, liveTimer = null;
    function render() {
      var s = read(), B = s.B, acre = s.model === 'acre';
      var cur = at(s, s.conc), lo = at(s, B.lo), hi = at(s, B.hi);
      var size = acre ? n0(s.acres) + ' net mineral acres' : n0(s.bbl) + ' barrels of water a day';

      var probEl = $('c-prob');
      probEl.disabled = !!s.autoProb;
      if (s.autoProb) probEl.value = cur.prob;

      // reference rows, with the slider's own position among them
      var rows = B.refs.map(function (r) { return { c: r[0], label: r[1], r: at(s, r[0]), you: r[0] === s.conc }; });
      if (!rows.some(function (x) { return x.you; }) && s.conc > 0) rows.push({ c: s.conc, label: 'Where the slider is now', r: cur, you: true });
      rows.sort(function (a, b) { return a.c - b.c; });
      var top = Math.max.apply(null, rows.map(function (x) { return x.r.ev; }).concat([1]));

      var h = '<div class="coa">';
      h += '<div class="coa-head"><span class="coa-title">Your lithium rights</span><span class="pill">Assumes the lithium is yours</span></div>';
      h += '<div class="range"><span class="lab">What ' + size + ' could be worth today</span>'
        + '<span class="num">' + usd(lo.ev) + ' <small>to</small> ' + usd(hi.ev) + '</span>'
        + '<span class="sub">The whole spread comes from one number: how much lithium is in your water. Published samples for '
        + B.play + ' run from ' + mg(B.lo) + ' to ' + mg(B.hi) + ' mg/L. Nobody has measured yours.</span></div>';

      h += '<div class="ladder" role="group" aria-label="Estimated value today at each lithium concentration">';
      h += '<p class="ladder-title"><span>Value today at each lithium concentration</span><span class="hint">Select a row to try it</span></p>';
      rows.forEach(function (x) {
        var f = Math.max(0.004, x.r.ev / top);
        h += '<button type="button" class="rung' + (x.you ? ' you' : '') + '" data-conc="' + x.c + '"'
          + ' title="' + mg(x.c) + ' mg/L: ' + usd(x.r.annual) + ' a year in royalty if a plant is built, ' + pct(x.r.prob) + ' chance it is built"'
          + (x.you ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>'
          + '<span class="rc"><b>' + mg(x.c) + ' mg/L</b><i>' + x.label + '</i></span>'
          + '<span class="rb"><span class="bar" style="--f:' + f.toFixed(4) + '"></span><span class="rv">' + usd(x.r.ev) + '</span></span></button>';
      });
      h += '</div>';

      h += '<p class="atline">At <b>' + mg(s.conc) + ' mg/L</b>: about <b>' + usd(cur.ev) + '</b> today, and <b>' + usd(cur.annual)
        + ' a year</b> in royalty if a plant is built.</p>';

      if (s.offer > 0) {
        var imp = C.impliedConc(s, s.offer), o;
        if (imp.conc) {
          o = 'On these assumptions, a <b>' + usd(s.offer) + '</b> offer prices your water at about <b>' + mg(imp.conc)
            + ' mg/L</b>. If your water tests above that, the offer is low. A buyer keeps a margin, so fair offers sit somewhat under the estimate.';
        } else if (imp.above) {
          o = 'A <b>' + usd(s.offer) + '</b> offer is above what this estimate reaches at any concentration.';
        } else {
          o = 'A <b>' + usd(s.offer) + '</b> offer is below this estimate even at the lowest concentration.';
        }
        h += '<p class="note offer">' + o + '</p>';
      }

      h += '<p class="fine">Assumes the lithium is yours to lease or sell. ' + B.note
        + (GUIDE ? ' <a href="' + GUIDE + '">Who owns the lithium</a>.' : '')
        + ' A planning estimate, not an appraisal or an offer.</p>';
      h += '</div>';
      out.innerHTML = h;
      clearTimeout(liveTimer);
      liveTimer = setTimeout(function () {
        var live = $('c-live');
        if (live) live.textContent = 'At ' + mg(s.conc) + ' milligrams per liter, about ' + usd(cur.ev) + ' today. Range ' + usd(lo.ev) + ' to ' + usd(hi.ev) + '.';
      }, 600);

      // the pitch beside the waitlist form
      var spread = hi.ev - lo.ev, pitch = $('c-pitch');
      if (pitch) {
        pitch.textContent = spread >= 10 * KIT
          ? 'Between the low case and the high case sits about ' + usd(spread) + '. The kit that tells you where you fall is $' + KIT + '.'
          : spread >= KIT
            ? 'The gap between the low case and the high case is about ' + usd(spread) + '. The kit is $' + KIT + '.'
            : 'At this size the gap between the low case and the high case is about ' + usd(spread) + ', less than the $' + KIT
              + ' price of a kit. A test makes more sense with more ' + (acre ? 'acres' : 'water') + ' in play, or once an offer is on the table.';
      }

      // how the number is built
      var chain;
      if (acre) {
        chain = [
          ['Plant output per unit acre', tonnes(cur.perAcreT) + ' t a year', 'the Arkansas benchmark of ' + s.intensity + ' tonnes of lithium carbonate at ' + s.benchConc + ' mg/L, scaled to ' + mg(s.conc) + ' mg/L'],
          ['Lithium attributed to your acres', tonnes(cur.lceT) + ' t a year', n0(s.acres) + ' acres x ' + tonnes(cur.perAcreT) + ' tonnes'],
          ['What that lithium sells for', usd(cur.gross) + ' a year', 'at $' + n0(s.price) + ' a tonne'],
          ['Your royalty', usd(cur.roy) + ' a year', pct(s.royalty) + ' of that revenue']
        ];
        if (s.fee > 0) chain.push(['Annual brine fee', usd(cur.fee) + ' a year', '$' + s.fee + ' an acre, paid on top of the royalty']);
      } else {
        chain = [
          ['Lithium in your water', tonnes(cur.liT) + ' t a year', n0(cur.qd) + ' barrels a day x 158.987 liters x ' + mg(s.conc) + ' mg/L x 365 days, or ' + tonnes(cur.lceT) + ' t as lithium carbonate'],
          ['Recoverable', tonnes(cur.recT) + ' t a year', 'at ' + pct(s.recovery) + ' recovery to lithium carbonate'],
          ['What that lithium sells for', usd(cur.gross) + ' a year', 'at $' + n0(s.price) + ' a tonne'],
          ['Your royalty', usd(cur.roy) + ' a year', pct(s.royalty) + ' of that revenue']
        ];
      }
      chain.push(['Worth today if a plant is built', usd(cur.npv), yrs(s.term) + ' of payments starting in year ' + s.delay + ', discounted at ' + pct(s.rate)]);
      chain.push(['Chance a plant is built', pct(cur.prob), s.autoProb ? 'set by concentration: higher grades are more likely to get a plant' : 'your input']);
      chain.push(['Estimated value today', usd(cur.ev), 'worth if built x chance built']);
      var b = '<details class="blk built"' + (builtOpen ? ' open' : '') + '><summary>How the number is built</summary><ol class="chain">';
      chain.forEach(function (r, i) {
        b += '<li' + (i === chain.length - 1 ? ' class="total"' : '') + '><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span><span class="n">' + r[2] + '</span></li>';
      });
      b += '</ol></details>';
      if (built) {
        built.innerHTML = b;
        built.firstChild.addEventListener('toggle', function () { builtOpen = this.open; });
      }

      // context saved with a waitlist signup, and the visitor's inputs for next time
      window.__bpCalc = [$('c-basin').value, acre ? n0(s.acres) + ' acres' : n0(s.bbl) + ' bbl/d', mg(s.conc) + ' mg/L',
        'range ' + usd(lo.ev) + ' to ' + usd(hi.ev), s.offer > 0 ? 'offer ' + usd(s.offer) : 'no offer'].join(' | ');
      var save = { 'c-auto': $('c-auto').checked };
      FIELDS.forEach(function (id) { save[id] = $(id).value; });
      lsSet(STORE, JSON.stringify(save));
    }

    /* ---- keep the form in step with the chosen basin ---- */
    function applyBasin(setDefaults) {
      var B = basin(), acre = B.model === 'acre', range = $('c-conc-range');
      $('c-acres-field').hidden = !acre; $('c-bbl-field').hidden = acre;
      $('adv-acre').hidden = !acre; $('adv-water').hidden = acre;
      range.min = 1; range.max = Math.ceil(B.hi * 1.2 / 5) * 5;
      $('c-scale-lo').textContent = '1 mg/L';
      $('c-scale-hi').textContent = n0(range.max) + ' mg/L';
      $('c-conc-help').textContent = 'Starts at ' + mg(B.typ) + ' mg/L, ' + B.refs.filter(function (r) { return r[0] === B.typ; }).map(function (r) { return r[1].charAt(0).toLowerCase() + r[1].slice(1); })[0]
        + '. Published samples for ' + B.play + ' reach ' + mg(B.hi) + '. Drag it, or type a lab result.';
      if (setDefaults) { $('c-conc').value = B.typ; $('c-delay').value = B.delay; $('c-fee').value = B.fee; }
      range.value = C.clamp(num('c-conc'), 1, Number(range.max));
    }
    function setAll(src) {
      FIELDS.forEach(function (id) { if (src[id] !== undefined && src[id] !== null) $(id).value = src[id]; });
      $('c-auto').checked = src['c-auto'] !== false;
    }
    function setConc(v) {
      $('c-conc').value = v;
      $('c-conc-range').value = C.clamp(v, 1, Number($('c-conc-range').max));
    }

    var touched = false;
    form.addEventListener('input', function (e) {
      var id = e.target.id;
      if (id === 'c-basin') applyBasin(true);
      if (id === 'c-conc-range') $('c-conc').value = e.target.value;
      if (id === 'c-conc') $('c-conc-range').value = C.clamp(num('c-conc'), 1, Number($('c-conc-range').max));
      render();
      if (!touched) {
        touched = true;
        if (!ssGet('bp_calc')) { ssSet('bp_calc', '1'); beacon({ type: 'calc', page: pagePath(), source: source(), isNew: false, device: device() }); gaEvent('calculator_used', { basin: $('c-basin').value }); }
      }
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    $('c-reset').addEventListener('click', function () { setAll(DEF); applyBasin(false); render(); });
    out.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== out && !(t.getAttribute && t.getAttribute('data-conc'))) t = t.parentNode;
      if (!t || t === out) return;
      setConc(parseFloat(t.getAttribute('data-conc')));
      render();
      var again = out.querySelector('.rung.you');
      if (again) again.focus();
    });

    // boot: saved inputs if any, else the worked example
    var saved = null;
    try { saved = JSON.parse(lsGet(STORE) || 'null'); } catch (e) { saved = null; }
    var start = {}, k;
    for (k in DEF) start[k] = DEF[k];
    if (saved && typeof saved === 'object' && C.BASINS[saved['c-basin']]) for (k in saved) start[k] = saved[k];
    setAll(start); applyBasin(false); render();
  }

  /* ----------------------------------------------------------------------- go */
  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-waitlist]'), initWaitlist);
    Array.prototype.forEach.call(document.querySelectorAll('form[data-contact]'), initContact);
    initCalc();
    trackView();
    loadGA();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
