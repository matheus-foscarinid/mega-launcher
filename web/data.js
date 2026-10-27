/*
 * What the home screen shows, kept in localStorage so it opens with numbers:
 *  - the picks: what's trending this week and recent releases, only from the streaming apps on this TV (TMDB, with
 *    the person's own free key from config.properties), 3 per hour (up to 6 in Home Settings);
 *  - the Letterboxd watchlist (letterboxd_user, LG only), with where each film streams (every 6 h, offers every 3 days);
 *  - weather, sunrise and sunset (Open-Meteo, every 30 min) and optional crypto prices (Binance, every 5 min).
 * Settings changed on the TV (Prefs) win over config.properties, as on Android. Built without a city (--generic), the
 * TV's time zone gives the city, and its country the currency and the region (zones.js).
 */
var CONFIG = window.CONFIG || {};

var Place = (function () {
  'use strict';
  var EURO = /^(AT|BE|BG|CY|DE|EE|ES|FI|FR|GR|HR|IE|IT|LT|LU|LV|MT|NL|PT|SI|SK)$/;

  /** A time zone's main city: {country, lat, lon, name}, or null. */
  function zone(name) {
    var all = window.ZONES || {}, v = all[name], hops = 0;
    while (v && v.charAt(0) === '=' && hops++ < 3) { name = v.slice(1); v = all[name]; }
    if (!v) return null;
    var p = v.split(',');
    return {country: p[0], lat: p[1], lon: p[2], name: p[3] || name.slice(name.lastIndexOf('/') + 1).replace(/_/g, ' ')};
  }

  var tz = zone(TV.zone()), set = CONFIG.latitude !== '' && CONFIG.latitude !== undefined;
  var country = (CONFIG.tmdbRegion || (tz ? tz.country : '') || 'US').toUpperCase();
  return {
    lat: set ? CONFIG.latitude : tz ? tz.lat : '40.7128',
    lon: set ? CONFIG.longitude : tz ? tz.lon : '-74.0060',
    city: CONFIG.city || (!set && tz ? tz.name : ''),
    country: country,
    currency: (CONFIG.currency || (country === 'BR' ? 'BRL' : EURO.test(country) ? 'EUR' : 'USD')).toUpperCase(),
    /** Fahrenheit for TVs in the US (by their time zone, or their language when it doesn't tell). */
    fahrenheit: tz ? tz.country === 'US' : /-US$/i.test(navigator.language || '')
  };
})();

var Prefs = (function () {
  'use strict';
  var KEY = 'fmtv.prefs';
  var v = {};
  try { v = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function pick(name, fallback) { return v[name] === undefined ? fallback : v[name]; }
  return {
    version: 0,
    language: function () { return pick('language', CONFIG.language || 'auto'); },
    temperature: function () { return pick('temperature', CONFIG.temperature || 'auto'); },
    theme: function () { return pick('theme', CONFIG.theme || 'auto'); },
    weather: function () { return pick('weather', true); },
    /** OK on the screensaver opens the title it shows, in its app; any other key only closes it (off by default). */
    saverWatch: function () { return pick('saverWatch', false) === true; },
    /** The weather card's forecast: 'hours' (the next 6 hours) or 'days' (the next 5 days). */
    forecast: function () { return pick('forecast', 'hours') === 'days' ? 'days' : 'hours'; },
    quotes: function () { return pick('quotes', CONFIG.showCrypto !== false); },
    coin: function (i) { var c = pick('coins', null); return c ? c[i] !== false : true; },
    /** Picks per tab: 3 (as it was) up to 6. */
    cards: function () { var n = pick('cards', 3); return n < 3 ? 3 : n > 6 ? 6 : n; },
    shelf: function () { return pick('shelf', null); },
    /** The shelf_apps of the build that last set the shelf, so a new one wins once over the TV's choice. */
    shelfConfig: function () { return pick('shelfConfig', ''); },
    /** The weather's city, picked on the TV (Home Settings → City), or config.properties' (or the time zone's). */
    city: function () { return pick('city', Place.city); },
    latitude: function () { return pick('latitude', Place.lat); },
    longitude: function () { return pick('longitude', Place.lon); },
    /** The TMDB key typed on the TV (Home Settings → TMDB key), or config.properties' ('' for none). */
    tmdbKey: function () { return String(pick('tmdbKey', CONFIG.tmdbKey || '')).trim(); },
    /** True when the key in use was typed on the TV (Remove takes it back to config.properties'). */
    tmdbKeyOnTV: function () { return v.tmdbKey !== undefined; },
    setCity: function (name, lat, lon) { v.city = name; v.latitude = lat; v.longitude = lon; save(); this.version++; },
    /** Streaming services (keys like "netflix") whose titles are left out of the picks. */
    serviceOff: function (key) { return pick('servicesOff', []).indexOf(key) >= 0; },
    setServiceOff: function (key, off) {
      var list = pick('servicesOff', []).filter(function (k) { return k !== key; });
      if (off) list.push(key);
      this.set('servicesOff', list);
    },
    set: function (name, value) { v[name] = value; save(); this.version++; },
    setCoin: function (i, on) {
      var c = (pick('coins', null) || [true, true, true, true]).slice();
      c[i] = on;
      this.set('coins', c);
    }
  };
})();

var Data = (function () {
  'use strict';

  function store(key, value) { try { localStorage.setItem('fmtv.' + key, JSON.stringify(value)); } catch (e) {} }
  function stored(key) { try { return JSON.parse(localStorage.getItem('fmtv.' + key)); } catch (e) { return null; } }

  /** GET a JSON document; done(error, json). */
  function get(url, headers, done) {
    var x = new XMLHttpRequest();
    var over = false;
    x.open('GET', url, true);
    x.timeout = 10000;
    for (var h in headers) if (headers.hasOwnProperty(h)) x.setRequestHeader(h, headers[h]);
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || over) return;
      over = true;
      if (x.status !== 200) { done(new Error(x.status === 401 ? 'TMDB rejected the key' : 'HTTP ' + x.status)); return; }
      var json;
      try { json = JSON.parse(x.responseText); } catch (e) { done(e); return; }
      done(null, json);
    };
    x.ontimeout = x.onerror = function () { if (!over) { over = true; done(new Error('no connection')); } };
    x.send();
  }

  var listeners = [];
  function changed() { for (var i = 0; i < listeners.length; i++) listeners[i](); }

  // MARK: - Weather

  function place() { return Prefs.latitude() + ',' + Prefs.longitude(); }
  // Both forecasts in one answer, the next 48 hours and today plus 5 days: Home Settings → Forecast switches without
  // asking again, and offline too.
  var QUERY = '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,weather_code'
      + '&hourly=temperature_2m,weather_code,is_day&timezone=auto&forecast_days=6&forecast_hours=48';
  var weather = null, weatherAt = 0, fetchingWeather = false;
  (function () {
    var w = stored('weather');
    // Fetched with another query (an older version): shown, and fetched again now.
    if (w && w.place === place()) { weather = parseWeather(w.body); weatherAt = w.query === QUERY ? w.at : 0; }
  })();

  /** "2026-10-20T18:31" at the location (Open-Meteo's local time) → epoch ms. */
  function localTime(iso, offsetSeconds) {
    var m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(iso || '');
    if (!m) return 0;
    return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - offsetSeconds * 1000;
  }

  function parseWeather(o) {
    if (!o || !o.current) return null;
    var off = o.utc_offset_seconds || 0, dl = o.daily, now = Date.now();
    var w = {
      temp: o.current.temperature_2m, code: o.current.weather_code, isDay: o.current.is_day !== 0,
      max: dl.temperature_2m_max[0], min: dl.temperature_2m_min[0],
      sunrise: localTime(dl.sunrise[0], off), sunset: localTime(dl.sunset[0], off), hours: [], days: []
    };
    var hr = o.hourly;
    for (var i = 0; hr && i < hr.time.length && w.hours.length < 6; i++) {
      var at = localTime(hr.time[i], off);
      if (at <= now) continue;
      w.hours.push({at: at, temp: hr.temperature_2m[i], code: hr.weather_code[i], day: !hr.is_day || hr.is_day[i] !== 0});
    }
    // The next 5 days, from tomorrow (none in a forecast cached before the days). Only days that haven't started at
    // the city: today, and past days in a forecast cached offline, are left out.
    for (var j = 0; dl.weather_code && j < dl.time.length && w.days.length < 5; j++) {
      if (localTime(dl.time[j] + 'T12:00', off) - 12 * 3600000 <= now) continue;
      var p = dl.time[j].split('-');   // named by its noon on the TV's clock, right even with the city far away
      w.days.push({at: new Date(+p[0], p[1] - 1, +p[2], 12).getTime(), max: dl.temperature_2m_max[j],
        min: dl.temperature_2m_min[j], code: dl.weather_code[j]});
    }
    return w;
  }

  function refreshWeather() {
    var now = Date.now();
    if (fetchingWeather || (now - weatherAt < 30 * 60000 && now >= weatherAt)) return;
    fetchingWeather = true;
    var at = place();
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + Prefs.latitude() + '&longitude=' + Prefs.longitude() + QUERY;
    get(url, {}, function (err, body) {
      fetchingWeather = false;
      if (at !== place()) { refreshWeather(); return; }   // another city was picked meanwhile
      if (err) return;
      weather = parseWeather(body);
      weatherAt = Date.now();
      store('weather', {place: at, body: body, at: weatherAt, query: QUERY});
      changed();
    });
  }

  /** Places with this name (Open-Meteo, in the app's language): done(error, [{label, city, lat, lon}]). */
  function findCity(name, done) {
    var lang = I18N.lang.replace(/-.*/, '');   // Open-Meteo takes the language without the country
    get('https://geocoding-api.open-meteo.com/v1/search?count=10&format=json&language=' + lang + '&name='
        + encodeURIComponent(name.trim()), {}, function (err, body) {
      if (err) { done(err); return; }
      var results = (body && body.results) || [], out = [], seen = {};
      for (var i = 0; i < results.length; i++) {
        var r = results[i], city = r.name || '';
        if (!city || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') continue;
        var label = city, parts = [r.admin1, r.country];
        for (var j = 0; j < parts.length; j++) if (parts[j] && parts[j] !== city) label += ', ' + parts[j];
        if (seen['#' + label]) continue;   // places with the same name, state and country read the same
        seen['#' + label] = true;
        out.push({label: label, city: city, lat: r.latitude.toFixed(4), lon: r.longitude.toFixed(4)});
      }
      done(null, out);
    });
  }

  // MARK: - Prices

  var COINS = ['BTC', 'ETH', 'SOL', 'USDT'];
  var CURRENCY = Place.currency;
  var QUOTE = CURRENCY === 'USD' ? 'USDT' : CURRENCY;
  /** Binance refuses the whole request when it has no pairs in the currency (INR...): the prices go in dollars then. */
  function inDollars() {
    store('dollarsFor', CURRENCY);
    CURRENCY = 'USD';
    QUOTE = 'USDT';
  }
  /** A pair with no trade for a day: Binance halted it and keeps answering with the frozen last price (AUD since 2026-10-06). */
  function halted(list) {
    for (var i = 0; list && i < list.length; i++) if (list[i].closeTime > 0 && Date.now() - list[i].closeTime > 864e5) return true;
    return false;
  }
  if (stored('dollarsFor') === CURRENCY && CURRENCY !== 'USD') {
    CURRENCY = 'USD';
    QUOTE = 'USDT';
  }
  var prices = [NaN, NaN, NaN, NaN], changes = [NaN, NaN, NaN, NaN], pricesAt = 0, fetchingPrices = false;

  /** Indexes in COINS of the coins that are on (the dollar only in Brazilian reais, where Binance lists it). */
  function activeCoins() {
    var out = [];
    if (!Prefs.quotes()) return out;
    for (var i = 0; i < COINS.length; i++) if (Prefs.coin(i) && (i < 3 || CURRENCY === 'BRL')) out.push(i);
    return out;
  }

  function parsePrices(list) {
    var found = 0;
    for (var i = 0; list && i < list.length; i++) {
      for (var k = 0; k < COINS.length; k++) {
        if (list[i].symbol !== COINS[k] + QUOTE) continue;
        found++;
        var last = parseFloat(list[i].lastPrice), open = parseFloat(list[i].openPrice);
        prices[k] = last;
        changes[k] = open > 0 ? (last - open) / open * 100 : NaN;
      }
    }
    return found;
  }

  (function () {
    var p = stored('prices');
    if (p && p.quote === QUOTE && parsePrices(p.body)) pricesAt = p.at;
  })();

  function refreshPrices() {
    var coins = activeCoins(), now = Date.now();
    if (!coins.length || fetchingPrices || (now - pricesAt < 5 * 60000 && now >= pricesAt)) return;
    fetchingPrices = true;
    var symbols = coins.map(function (i) { return '%22' + COINS[i] + QUOTE + '%22'; }).join(',');
    var path = '/api/v3/ticker/24hr?type=MINI&symbols=%5B' + symbols + '%5D';
    // Binance.com refuses the US (HTTP 451); Binance.US answers the same call in dollars.
    var hosts = ['https://api.binance.com', 'https://api.binance.us'];
    (function next(h, refused) {
      get(hosts[h] + path, {}, function (err, body) {
        // A pair Binance doesn't list (HTTP 400): the prices go in dollars. Binance.US has only dollar pairs: its 400
        // counts only where Binance.com refuses the US (HTTP 451), not after a timeout or a 5xx there.
        if (err && err.message === 'HTTP 400' && QUOTE !== 'USDT' && (h === 0 || refused)) { fetchingPrices = false; inDollars(); refreshPrices(); return; }
        // Halted: dollars for this run, not saved like the 400's (the market may open again).
        if (!err && QUOTE !== 'USDT' && halted(body)) { fetchingPrices = false; CURRENCY = 'USD'; QUOTE = 'USDT'; refreshPrices(); return; }
        if (err || !parsePrices(body)) {
          if (h + 1 < hosts.length && !(err && err.message === 'HTTP 400')) next(h + 1, err && err.message === 'HTTP 451');
          else fetchingPrices = false;
          return;
        }
        fetchingPrices = false;
        pricesAt = Date.now();
        store('prices', {quote: QUOTE, body: body, at: pricesAt});
        changed();
      });
    })(0);
  }

  // MARK: - Picks (TMDB)

  var KEY = Prefs.tmdbKey();
  var REGION = Place.country;
  var API = 'https://api.tmdb.org/3';   // TMDB's own mirror of api.themoviedb.org: some ISPs block the other name (#327)

  /** Service name on TMDB (part of it, lowercase) → our key, how to find its app on the TV (id, name), its name. */
  var SERVICES = [
    ['netflix', 'netflix', /^netflix$/, /netflix/i, 'Netflix'],
    ['prime video', 'prime', /^amazon$/, /prime video|amazon/i, 'Prime Video'],
    ['disney', 'disney', /disney/, /disney/i, 'Disney+'],
    ['hulu', 'hulu', /^hulu/, /hulu/i, 'Hulu'],
    ['paramount', 'paramount', /paramount|cbs/, /paramount/i, 'Paramount+'],
    ['peacock', 'peacock', /peacock/, /peacock/i, 'Peacock'],
    ['globoplay', 'globoplay', /globoplay/, /globoplay/i, 'Globoplay'],
    ['max', 'max', /hbo|wbd|\.max/, /^(hbo )?max$|hbo max/i, 'Max'],
    ['apple tv', 'appletv', /appletv|apple\.tv/, /apple tv/i, 'Apple TV'],
    ['hotstar', 'hotstar', /hotstar/, /hotstar/i, 'JioHotstar'],
    ['crunchyroll', 'crunchyroll', /crunchyroll/, /crunchyroll/i, 'Crunchyroll'],
    ['now tv', 'now', /nowtv|now\.tv/, /^now( tv)?$/i, 'NOW']
  ];

  var installed = [];   // the TV's apps, from TV.apps()

  /** A service whose app is on the TV and that the person hasn't switched off in Home Settings (Picks from). */
  function usable(key) { return !!appFor(key) && !Prefs.serviceOff(key); }

  /** The streaming services whose app is on this TV, as {key, name}, for Home Settings. */
  function services() {
    var out = [];
    for (var s = 0; s < SERVICES.length; s++) if (appFor(SERVICES[s][1])) out.push({key: SERVICES[s][1], name: SERVICES[s][4]});
    return out;
  }

  /** The installed app for a service key, or null. */
  function appFor(key) {
    for (var s = 0; s < SERVICES.length; s++) {
      if (SERVICES[s][1] !== key) continue;
      for (var i = 0; i < installed.length; i++) {
        if (SERVICES[s][2].test(installed[i].id) || SERVICES[s][3].test(installed[i].title)) return installed[i];
      }
    }
    return null;
  }

  /** "… Amazon Channel" is sold inside another app; Apple TV is only the streaming service (350; 2 is the store). */
  function service(providerName, providerId) {
    var n = (providerName || '').toLowerCase();
    if (n.indexOf(' channel') >= 0) return null;
    for (var i = 0; i < SERVICES.length; i++) {
      var s = SERVICES[i];
      if (s[1] === 'appletv' && providerId !== 350) continue;
      if (s[0] === 'max' ? /\bmax\b/.test(n) : n.indexOf(s[0]) >= 0) return s;
    }
    return null;
  }

  function tmdb(path, done, key) {
    key = key || KEY;
    var bearer = key.indexOf('eyJ') === 0;   // read access token (v4) or API key (v3)
    var url = API + path + (bearer ? '' : (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(key));
    get(url, bearer ? {Authorization: 'Bearer ' + key, Accept: 'application/json'} : {Accept: 'application/json'}, done);
  }

  /** Asks TMDB whether a key works before it's saved: done(error), with error.rejected when TMDB said no. */
  function checkKey(key, done) {
    tmdb('/configuration', function (err) {
      if (err && /rejected/.test(err.message)) err.rejected = true;
      done(err || null);
    }, key);
  }

  var cache = stored('recs') || {};
  var picks = cache.picks || [], listAt = cache.listAt || 0, period = cache.period, listLang = cache.lang || '', stamp = cache.stamp || '';
  var fetchingRecs = false, failedAt = 0, recsError = '';

  function saveRecs() { store('recs', {picks: picks, listAt: listAt, period: period, lang: listLang, stamp: stamp}); }

  function hourPeriod(d) {
    var h = d.getHours();
    return h >= 5 && h < 12 ? 0 : h >= 12 && h < 18 ? 1 : 2;
  }

  function sourceStamp() {
    var s = KEY.length + ':' + KEY.slice(-6) + ':' + REGION + (CONFIG.hideAnimation ? ':no-animation' : '');
    for (var i = 0; i < SERVICES.length; i++) s += usable(SERVICES[i][1]) ? '1' : '0';
    return s;
  }

  function franchise(title) {
    var t = (title || '').toLowerCase(), cut = t.indexOf(':');
    if (cut < 0) cut = t.indexOf(' - ');
    return (cut > 0 ? t.slice(0, cut) : t).replace(/^\s+|\s+$/g, '');
  }

  /** Up to n of the list, moving on each hour, one per franchise; out and seen carry over between calls. */
  function hourly(list, n, out, seen) {
    var hour = Math.floor(Date.now() / 3600000);
    for (var j = 0; j < list.length && out.length < n; j++) {
      var q = list[(hour * n + j) % list.length], f = franchise(q.title);
      if (!seen[f]) { seen[f] = true; out.push(q); }
    }
    return out;
  }

  /** This hour's picks (Prefs.cards()): the Letterboxd watchlist ("watchlist") or trending movies ("movie"). */
  function now(kind) {
    if (!KEY) return [];
    if (kind === 'watchlist') return watchlistNow();
    var list = [];
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      if (kind === p.kind && (!p.detailed || (p.app && usable(p.app)))) list.push(p);
    }
    return hourly(list, Prefs.cards(), [], {});
  }

  /** TMDB's language, as on Android: Latin American Spanish unless the TV is in Spain, and Germany's German. */
  function lang() {
    if (I18N.lang === 'es') return /-ES\b/i.test(navigator.language || '') ? 'es-ES' : 'es-MX';
    if (I18N.lang === 'de') return 'de-DE';   // TMDB's de-AT and de-CH have few translations of their own
    return I18N.locale();
  }

  function day(offset) {
    var d = new Date(Date.now() + offset * 86400000);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  /** TMDB's genres that it leaves in English in some languages. */
  function genre(name) {
    switch (name) {
      case 'Action & Adventure': return tr('genre|Action & Adventure');
      case 'Sci-Fi & Fantasy': return tr('genre|Sci-Fi & Fantasy');
      case 'War & Politics': return tr('genre|War & Politics');
      case 'Kids': return tr('genre|Kids');
      case 'News': return tr('genre|News');
      case 'Soap': return tr('genre|Soap');
      case 'Talk': return tr('genre|Talk');
      default: return name;
    }
  }

  /** The best backdrop: no text over it, the largest, then the best rated. */
  function bestBackdrop(images) {
    var list = images && images.backdrops, best = null, score = -1;
    for (var i = 0; list && i < list.length; i++) {
      var b = list[i];
      if (!b.file_path) continue;
      var s = (b.iso_639_1 === null ? 1e7 : 0) + Math.min(b.width || 0, 3840) * 100 + (b.vote_average || 0);
      if (s > score) { score = s; best = b.file_path; }
    }
    return best;
  }

  /** Genre, runtime, and the service it's on among the TV's apps (for the watchlist, where to watch it at all). */
  function details(p, done) {
    tmdb('/' + p.kind + '/' + p.id + '?language=' + lang() + '&append_to_response=watch/providers,images&include_image_language=null,'
        + I18N.base + ',en', function (err, o) {
      if (err) { done(err); return; }
      var best = bestBackdrop(o.images);
      if (best) p.backdrop = best;
      if (o.poster_path) p.poster = o.poster_path;
      var parts = [];
      if (o.genres && o.genres.length) {
        parts.push(genre(o.genres[0].name));
      }
      if (p.kind === 'movie' && o.runtime > 0) {
        var h = Math.floor(o.runtime / 60), m = o.runtime % 60;
        parts.push(h ? trf('{h}h {m}m', {h: h, m: m}) : trf('{m}m', {m: m}));
      }
      var wp = o['watch/providers'], here = wp && wp.results && wp.results[REGION], flat = here && here.flatrate;
      p.app = null;
      if (p.watchlist) {
        var deal = offer(here);
        p.app = deal.app;
        p.paid = deal.paid;
        parts.push(deal.text);
      }
      for (var i = 0; !p.watchlist && flat && i < flat.length && !p.app; i++) {
        var s = service(flat[i].provider_name, flat[i].provider_id);
        if (s && usable(s[1])) { p.app = s[1]; p.service = s[4]; }
      }
      if (p.service && p.app) parts.push(p.service);
      p.meta = parts.join(' · ');
      title(p, o, function () {
        p.detailed = true;
        done(null);
      });
    });
  }

  /**
   * Without a title in the TV's language TMDB answers with the original one, so a Korean series on a German TV reads
   * "닥터X: 하얀 마피아의 시대". Then the English title, when TMDB has one (one more request, only for those).
   */
  function title(p, o, done) {
    var field = p.kind === 'movie' ? 'title' : 'name', own = o[field] || p.title;
    p.title = own;
    if (I18N.lang === 'en' || !own || own !== o['original_' + field] || o.original_language === I18N.base
        || o.original_language === 'en') { done(); return; }
    tmdb('/' + p.kind + '/' + p.id + '?language=en-US', function (err, en) {
      if (!err && en && en[field]) p.title = en[field];
      done();
    });
  }

  /** TMDB's Animation genre (movies and shows: cartoons and anime), left out with hide_animation=true. */
  var ANIMATION = 16;

  function animated(o) {
    for (var i = 0; o.genre_ids && i < o.genre_ids.length; i++) if (o.genre_ids[i] === ANIMATION) return true;
    return false;
  }

  function addPick(list, o, kind) {
    if (!o.backdrop_path) return;
    if (CONFIG.hideAnimation && animated(o)) return;
    list.push({id: o.id, kind: kind, title: kind === 'movie' ? o.title : o.name, backdrop: o.backdrop_path, poster: o.poster_path || '', meta: '', app: null, detailed: false});
  }

  function keyOf(p) { return p.kind + ':' + p.id; }

  function alternate(out, seen, a, b, max) {
    for (var i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
      if (i < a.length && !seen[keyOf(a[i])]) { seen[keyOf(a[i])] = true; out.push(a[i]); }
      if (i < b.length && out.length < max && !seen[keyOf(b[i])]) { seen[keyOf(b[i])] = true; out.push(b[i]); }
    }
  }

  /** Runs fn on each item one after the other (the TV's network is shared with what's playing). */
  function each(items, fn, done) {
    var i = 0;
    (function next() {
      if (i >= items.length) { done(); return; }
      fn(items[i++], next);
    })();
  }

  function fetchList(done) {
    tmdb('/watch/providers/movie?language=' + lang() + '&watch_region=' + REGION, function (err, res) {
      if (err) { done(err); return; }
      var ids = [];
      for (var i = 0; res.results && i < res.results.length; i++) {
        var s = service(res.results[i].provider_name, res.results[i].provider_id);
        if (s && usable(s[1])) ids.push(res.results[i].provider_id);
      }
      if (!ids.length) { done(new Error("none of the TV's streaming apps are on TMDB (or switched on in Picks from)")); return; }
      var common = '&language=' + lang() + '&watch_region=' + REGION + '&with_watch_monetization_types=flatrate&include_adult=false'
          + '&sort_by=popularity.desc&with_watch_providers=' + encodeURIComponent(ids.join('|'))
          + (CONFIG.hideAnimation ? '&without_genres=' + ANIMATION : '');
      var hot = [], fresh = [];
      tmdb('/trending/movie/week?language=' + lang(), function (e, r) {
        var candidates = [];
        for (var j = 0; !e && j < r.results.length && j < 16; j++) addPick(candidates, r.results[j], 'movie');
        // Trending is only kept when it's on one of the TV's apps: the details say where.
        each(candidates, function (p, n) {
          details(p, function (de) { if (!de && p.app) hot.push(p); n(); });
        }, function () {
          tmdb('/discover/movie?vote_count.gte=30&primary_release_date.gte=' + day(-365) + '&primary_release_date.lte=' + day(0) + common, function (e1, r1) {
            for (var k = 0; !e1 && k < r1.results.length; k++) addPick(fresh, r1.results[k], 'movie');
            var list = [], seen = {};
            alternate(list, seen, hot, fresh, 24);
            if (!list.length) { done(new Error('TMDB returned no recommendations')); return; }
            picks = list;
            done(null);
          });
        });
      });
    });
  }

  /** Fetches the list when stale (6 h, a new period of the day, language, key or apps), then this hour's details. */
  function refreshRecs() {
    if (!KEY || fetchingRecs || !installed.length) return;
    var t = Date.now(), p = hourPeriod(new Date()), st = sourceStamp();
    if (st === stamp && failedAt && t - failedAt < 10 * 60000 && t >= failedAt) return;
    var stale = st !== stamp || p !== period || t - listAt > 6 * 3600000 || t < listAt || !picks.length || listLang !== I18N.lang;
    var wanted = all(), missing = false;
    for (var i = 0; i < wanted.length; i++) missing = missing || !wanted[i].detailed;
    if (!stale && !missing) return;
    fetchingRecs = true;
    stamp = st;
    function finish(err) {
      fetchingRecs = false;
      if (err) { recsError = err.message; failedAt = Date.now(); } else { recsError = ''; failedAt = 0; }
      saveRecs();
      changed();
    }
    function detailWanted() {
      var todo = all().filter(function (x) { return !x.detailed; });
      each(todo, function (x, next) { details(x, function () { next(); }); }, function () { finish(null); });
    }
    if (stale) {
      fetchList(function (err) {
        if (err) { finish(err); return; }
        listAt = Date.now();
        period = p;
        listLang = I18N.lang;
        detailWanted();
      });
    } else {
      detailWanted();
    }
  }

  /** This hour's picks for both tabs, without repeats (the screensaver shows them too). */
  function all() {
    var out = [], seen = {}, kinds = ['watchlist', 'movie'];
    for (var k = 0; k < kinds.length; k++) {
      var list = now(kinds[k]);
      for (var i = 0; i < list.length; i++) if (!seen[keyOf(list[i])]) { seen[keyOf(list[i])] = true; out.push(list[i]); }
    }
    return out;
  }

  // MARK: - Watchlist (Letterboxd)

  var LB_USER = CONFIG.letterboxdUser || '';
  var saved = stored('watchlist') || {};
  if (saved.user !== LB_USER) saved = {};
  var films = saved.films || [], filmsAt = saved.at || 0, filmsStamp = saved.stamp || '', fetchingFilms = false, filmsFailedAt = 0;

  function saveFilms() { store('watchlist', {user: LB_USER, at: filmsAt, stamp: filmsStamp, films: films}); }

  /** Where a film is best watched here: on an app the TV has, included or free first, then to rent or buy. */
  function offer(here) {
    var types = ['flatrate', 'free', 'ads', 'rent', 'buy'], elsewhere = null;
    for (var t = 0; here && t < types.length; t++) {
      var list = here[types[t]] || [];
      for (var i = 0; i < list.length; i++) {
        var s = service(list[i].provider_name, list[i].provider_id), app = s && usable(s[1]) ? s[1] : null;
        if (app) return {app: app, paid: t >= 3, text: offerText(types[t], s[4])};
        if (!elsewhere) elsewhere = {app: null, paid: t >= 3, text: offerText(types[t], list[i].provider_name, true)};
      }
    }
    return elsewhere || {app: null, paid: false, text: tr('Not streaming here')};
  }

  function offerText(type, name, notOnTV) {
    switch (type) {
      case 'flatrate': return notOnTV ? trf('{service} (not on this TV)', {service: name}) : name;
      case 'rent': return trf('Rent on {service}', {service: name});
      case 'buy': return trf('Buy on {service}', {service: name});
      default: return trf('Free on {service}', {service: name});
    }
  }

  var WATCHLIST_CARDS = 30;

  /** This hour's watchlist posters: films included or free on the TV's apps first, then the rest. */
  function watchlistNow() {
    var ready = films.filter(function (f) { return f.detailed && (f.poster || f.backdrop); }), n = WATCHLIST_CARDS;
    var included = ready.filter(function (f) { return f.app && !f.paid && usable(f.app); });
    var rest = ready.filter(function (f) { return included.indexOf(f) < 0; });
    var out = [], seen = {};
    hourly(included, n, out, seen);
    return hourly(rest, n, out, seen);
  }

  /** Every page of the watchlist, in order: done([{slug, name}]) or done(null). */
  function fetchFilms(done) {
    var out = [];
    (function page(n) {
      TV.watchlist(LB_USER, n, function (res) {
        if (!res) { done(null); return; }
        out = out.concat(res.films);
        if (n < res.pages && n < 50) page(n + 1); else done(out);
      });
    })(1);
  }

  /** The new list, keeping what's known of the films already there. */
  function mergeFilms(list) {
    var old = {};
    for (var i = 0; i < films.length; i++) old[films[i].slug] = films[i];
    films = list.map(function (x) {
      return old[x.slug] || {slug: x.slug, name: x.name, kind: 'movie', watchlist: true, id: 0, title: x.name,
        backdrop: '', poster: '', meta: '', app: null, paid: false, detailed: false, at: 0};
    });
  }

  /** The film's TMDB id from its Letterboxd name ("Title (2024)"); done() either way (id -1 when TMDB has none). */
  function findFilm(f, done) {
    var m = /^(.*) \((\d{4})\)$/.exec(f.name), name = m ? m[1] : f.name;
    tmdb('/search/movie?include_adult=false&language=' + lang() + '&query=' + encodeURIComponent(name) + (m ? '&year=' + m[2] : ''),
        function (err, res) {
          var hit = !err && res.results && res.results[0];
          if (err) { done(); return; }
          f.id = hit ? hit.id : -1;
          f.title = hit ? hit.title : name;
          if (hit) { f.backdrop = hit.backdrop_path || ''; f.poster = hit.poster_path || ''; }
          done();
        });
  }

  /** Where each film streams changes: looked up again after 3 days, or at once when the TV's apps change. */
  function filmStale(f, t) { return !f.at || t - f.at > 3 * 86400000 || t < f.at; }

  function refreshWatchlist() {
    if (!LB_USER || !KEY || fetchingFilms || !installed.length) return;
    var t = Date.now(), st = sourceStamp();
    if (filmsFailedAt && t - filmsFailedAt < 10 * 60000 && t >= filmsFailedAt) return;
    if (st !== filmsStamp) {
      for (var i = 0; i < films.length; i++) films[i].at = 0;
      filmsStamp = st;
    }
    var listStale = !films.length || t - filmsAt > 6 * 3600000 || t < filmsAt;
    var todo = films.filter(function (f) { return filmStale(f, t); });
    if (!listStale && !todo.length) return;
    fetchingFilms = true;
    function lookUp() {
      var queue = films.filter(function (f) { return filmStale(f, Date.now()); }), done = 0;
      each(queue, function (f, next) {
        function finished() {
          f.at = Date.now();
          if (++done % 10 === 0) { saveFilms(); changed(); }
          next();
        }
        if (!f.id) { findFilm(f, function () { if (f.id > 0) details(f, finished); else finished(); }); return; }
        if (f.id > 0) details(f, finished); else finished();
      }, function () {
        fetchingFilms = false;
        saveFilms();
        changed();
      });
    }
    if (!listStale) { lookUp(); return; }
    fetchFilms(function (list) {
      if (!list) { fetchingFilms = false; filmsFailedAt = Date.now(); return; }
      filmsFailedAt = 0;
      filmsAt = Date.now();
      mergeFilms(list);
      saveFilms();
      lookUp();
    });
  }

  // MARK: - Formatting

  function fmt(v, digits) {
    // Old WebKit (Tizen 2) has no Intl: toLocaleString ignores its options and prints every digit, without failing.
    // English separators there; a per-language table if someone asks.
    if (typeof Intl === 'undefined') return v.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    try { return v.toLocaleString(I18N.locale(), {minimumFractionDigits: digits, maximumFractionDigits: digits}); } catch (e) { return v.toFixed(digits); }
  }

  var SYMBOLS = {USD: '$', BRL: 'R$ ', EUR: '€', GBP: '£', JPY: '¥'};

  return {
    COINS: COINS,
    get city() { return Prefs.city(); },
    currency: CURRENCY,
    onChange: function (fn) { listeners.push(fn); },
    setApps: function (apps) { installed = apps; },
    appFor: appFor,
    usable: usable,
    services: services,
    refresh: function () { refreshWeather(); refreshPrices(); refreshRecs(); refreshWatchlist(); },
    settingsChanged: function () { pricesAt = 0; refreshPrices(); changed(); },
    findCity: findCity,
    /** Another city picked: its weather now (none shown until it comes). */
    cityChanged: function () { weather = null; weatherAt = 0; refreshWeather(); changed(); },
    get weather() { return weather; },
    get weatherAt() { return weatherAt; },
    prices: prices,
    changes: changes,
    get pricesAt() { return pricesAt; },
    activeCoins: activeCoins,
    hasKey: function () { return !!KEY; },
    checkKey: checkKey,
    /** A key typed (or removed) on the TV: the picks come again with it, or go. */
    keyChanged: function () { KEY = Prefs.tmdbKey(); recsError = ''; failedAt = 0; refreshRecs(); changed(); },
    recsError: function () { return recsError; },
    picks: now,
    showcase: all,
    image: function (path, size) { return path ? 'https://image.tmdb.org/t/p/' + (size || 'w1280') + path : ''; },

    /** Night at the location: from sunset to sunrise (the last forecast; without one, 6:00 and 18:00). */
    isNight: function (at) {
      var theme = Prefs.theme();
      if (theme === 'dark') return true;
      if (theme === 'light') return false;
      var d = new Date(at), mins = d.getHours() * 60 + d.getMinutes();
      function hm(t, fallback) { if (!t) return fallback; var x = new Date(t); return x.getHours() * 60 + x.getMinutes(); }
      var rise = hm(weather && weather.sunrise, 360), set = hm(weather && weather.sunset, 1080);
      return mins < rise || mins >= set;
    },

    compact: function (v) {
      if (isNaN(v)) return '—';
      if (v >= 1000000) return fmt(v / 1000000, 2) + 'M';
      if (v >= 10000) return fmt(v / 1000, 1) + 'k';
      if (v >= 1000) return fmt(v / 1000, 2) + 'k';
      if (v >= 100) return fmt(v, 0);
      return fmt(v, 2);
    },
    money: function (v) {
      var s = SYMBOLS[CURRENCY] || CURRENCY + ' ';
      if (isNaN(v)) return s + '—';
      return s + (v >= 1000 ? fmt(v, 0) : fmt(v, 2));
    },
    change: function (v) { return isNaN(v) ? '' : (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 1) + '%'; },
    degrees: function (v) {
      if (v === undefined || v === null || isNaN(v)) return '—';
      var unit = Prefs.temperature();
      var f = unit === 'F' || (unit === 'auto' && Place.fahrenheit);
      return Math.round(f ? v * 9 / 5 + 32 : v) + '°';
    },
    /** "3 PM", "15:00", "15 Uhr": the hourly forecast. */
    hour: function (at) { return formatDate('format|h a', at); },
    /** "Seg", "Mon", "Lun", "Mo", "Пн": the short day of the week, capitalized and without the abbreviation's dot. */
    weekday: function (at) {
      var s = formatDate('format|EEE', at).replace(/\.$/, '');
      return s.charAt(0).toUpperCase() + s.substring(1);
    },
    /** "5:21 AM", "05:21": the clock, sunrise and sunset. */
    time: function (at) { return formatDate('format|h:mm a', at); },
    /** "12 min ago" when the data is old (no internet), or empty. */
    staleness: function (at, every) {
      if (!at) return '';
      var age = Date.now() - at;
      if (age < every * 2) return '';
      var m = Math.floor(age / 60000), h = Math.floor(m / 60);
      return m < 60 ? trf('{n} min ago', {n: m}) : trf('{n} h ago', {n: h});
    },
    condition: function (code, day) {
      if (code === undefined || code === null || code < 0) return '';
      if (code === 0) return day ? tr('Clear') : tr('night|Clear');
      if (code === 1) return day ? tr('Mostly Sunny') : tr('Mostly Clear');
      if (code === 2) return tr('Partly Cloudy');
      if (code === 3) return tr('Cloudy');
      if (code === 45 || code === 48) return tr('Fog');
      if (code >= 51 && code <= 57) return tr('Drizzle');
      if (code === 65 || code === 67 || code === 82) return tr('Heavy Rain');
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return tr('Snow');
      if (code >= 95) return tr('Thunderstorms');
      return tr('Rain');
    },
    symbol: function (code, day) {
      if (code <= 1) return day ? 'sunny' : 'clear_night';
      if (code === 2) return day ? 'partly_cloudy_day' : 'partly_cloudy_night';
      if (code === 3) return 'cloud';
      if (code === 45 || code === 48) return 'foggy';
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snowflake';
      if (code >= 95) return 'thunderstorm';
      return 'rainy';
    },
    coinName: function (i) { return i === 3 ? tr('Dollar') : ['Bitcoin', 'Ethereum', 'Solana'][i]; }
  };
})();
