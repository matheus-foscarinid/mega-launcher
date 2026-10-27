/*
 * Free My TV's service on LG webOS, for what the web app's page can't reach itself:
 *  - one call to the TV's remote control API (127.0.0.1:3000). Newer webOS gives each app's page its own origin
 *    (file://io.freemytv-webos), and the API closes any connection that isn't from file:// ("invalid origin"); from
 *    here the handshake says file://.
 *  - a page of a public Letterboxd watchlist, which Letterboxd serves without CORS.
 * Plain ES5 with Node's built-in modules only: older webOS ships an old Node.
 */
var net = require('net');
var https = require('https');
var Service = require('webos-service');

var service = new Service(require('./package.json').name);

function buffer(x) {   // Buffer.from is missing before Node 4.5
  return Buffer.from ? Buffer.from(x) : new Buffer(x);
}

/** A client's text frame: masked, as the protocol asks. */
function frame(text) {
  var data = buffer(text), n = data.length;
  var mask = buffer([Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0]);
  for (var i = 0; i < n; i++) data[i] ^= mask[i % 4];
  return Buffer.concat([buffer(n < 126 ? [0x81, 0x80 | n] : [0x81, 0xfe, n >> 8, n & 0xff]), mask, data]);
}

/** done({clientKey, payload}), {refused: true} when the person said no on the TV, or null. */
function call(uri, clientKey, done) {
  var socket = net.connect(3000, '127.0.0.1'), buf = buffer([]), open = false, text = '', finished = false;
  var timer = setTimeout(function () { finish(null); }, 90000);   // time to answer the TV's prompt
  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    socket.destroy();
    done(result);
  }
  function send(obj) {
    socket.write(frame(JSON.stringify(obj)));
  }
  function onMessage(m) {
    if (m.type === 'registered') {
      clientKey = m.payload['client-key'];
      send({type: 'request', id: 'call', uri: 'ssap://' + uri});
    } else if (m.id === 'call') {
      finish(m.type === 'error' ? null : {clientKey: clientKey, payload: m.payload});
    } else if (m.type === 'error') {
      finish(m.id === 'register' ? {refused: true} : null);
    }
  }
  socket.on('connect', function () {
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: file://\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZnJlZW15dHYtd2Vib3MtYXBp\r\n\r\n');
  });
  socket.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      var end = buf.toString('binary').indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!/^HTTP\/1\.1 101/.test(buf.toString('utf8', 0, 12))) { finish(null); return; }
      open = true;
      buf = buf.slice(end + 4);
      var payload = {forcePairing: false, pairingType: 'PROMPT',
        manifest: {manifestVersion: 1, appVersion: '1.0', permissions: ['READ_INSTALLED_APPS']}};
      if (clientKey) payload['client-key'] = clientKey;
      send({type: 'register', id: 'register', payload: payload});
    }
    // The server's frames: unmasked, a message possibly in several (continuation frames until FIN).
    while (buf.length >= 2) {
      var fin = buf[0] & 0x80, op = buf[0] & 0x0f, n = buf[1] & 0x7f, off = 2;
      if (n === 126) {
        if (buf.length < 4) return;
        n = buf.readUInt16BE(2);
        off = 4;
      } else if (n === 127) {
        if (buf.length < 10) return;
        n = buf.readUInt32BE(6);
        off = 10;
      }
      if (buf.length < off + n) return;
      var data = buf.slice(off, off + n);
      buf = buf.slice(off + n);
      if (op === 8) { finish(null); return; }
      if (op !== 1 && op !== 0) continue;
      text += data.toString('utf8');
      if (!fin) continue;
      var m = null;
      try { m = JSON.parse(text); } catch (e) {}
      text = '';
      if (m) onMessage(m);
    }
  });
  socket.on('error', function () { finish(null); });
  socket.on('close', function () { finish(null); });
}

function decodeEntities(s) {
  return s.replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); }).replace(/&amp;/g, '&');
}

/** A watchlist page's films, as {slug, name ("Title (2024)")}, and how many pages it has. */
function parseWatchlist(html) {
  var films = [], tag = /<div[^>]*data-item-slug="[^"]*"[^>]*>/g, m;
  while ((m = tag.exec(html))) {
    var slug = /data-item-slug="([^"]*)"/.exec(m[0]), name = /data-item-name="([^"]*)"/.exec(m[0]);
    if (slug && name) films.push({slug: slug[1], name: decodeEntities(name[1])});
  }
  var pages = 1, link = /\/watchlist\/page\/(\d+)\//g;
  while ((m = link.exec(html))) pages = Math.max(pages, +m[1]);
  return {films: films, pages: pages};
}

/** done(error, html) for one page of a Letterboxd watchlist. */
function fetchWatchlist(user, page, done) {
  var path = '/' + user + '/watchlist/' + (page > 1 ? 'page/' + page + '/' : '');
  var finished = false;
  function finish(err, html) {
    if (finished) return;
    finished = true;
    done(err, html);
  }
  var req = https.get({host: 'letterboxd.com', path: path, headers: {'User-Agent': 'Mozilla/5.0 (Web0S; Linux) FreeMyTV',
    Accept: 'text/html'}}, function (res) {
    if (res.statusCode !== 200) { res.resume(); finish('HTTP ' + res.statusCode); return; }
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { finish(null, Buffer.concat(chunks).toString('utf8')); });
  });
  req.setTimeout(20000, function () { req.abort(); finish('timeout'); });
  req.on('error', function (e) { finish(e.message || 'no connection'); });
}

service.register('watchlist', function (message) {
  var p = message.payload || {}, user = String(p.user || ''), page = +p.page || 1;
  // only a Letterboxd username and a page number reach the request
  if (!/^[A-Za-z0-9_]{1,40}$/.test(user) || page < 1 || page > 100 || page !== Math.floor(page)) {
    message.respond({returnValue: false, errorText: 'Bad user or page'});
    return;
  }
  fetchWatchlist(user, page, function (err, html) {
    if (err) { message.respond({returnValue: false, errorText: err}); return; }
    var list = parseWatchlist(html);
    message.respond({returnValue: true, films: list.films, pages: list.pages});
  });
});

service.register('ssap', function (message) {
  var p = message.payload || {};
  // Only the app list, the one call the page makes: nothing else goes to the TV's API, nor gets its client key.
  if (p.uri !== 'com.webos.applicationManager/listLaunchPoints') {
    message.respond({returnValue: false, errorText: 'Only listLaunchPoints'});
    return;
  }
  call(p.uri, p.clientKey, function (result) {
    if (!result) message.respond({returnValue: false, errorText: 'No answer from the remote control API'});
    else {
      result.returnValue = true;
      message.respond(result);
    }
  });
});
