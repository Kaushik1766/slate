/* Slate - dashboard client
 * ---------------------------------------------------------------------------
 * Written in ES2015 on purpose: an old tablet is the target device, so no
 * optional chaining, no nullish coalescing, no fetch-only APIs on hot paths.
 * All continuous values are written straight to the DOM or to CSS custom
 * properties; nothing re-renders a tree on a timer.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    root: document.documentElement,
    host: $("hostName"), os: $("osName"),
    connChip: $("connChip"), connIcon: $("connIcon"), connText: $("connText"),
    wakeBtn: $("wakeBtn"), themeBtn: $("themeBtn"), themeIcon: $("themeIcon"),
    fsBtn: $("fsBtn"), fsIcon: $("fsIcon"),

    clockHM: $("clockHM"), clockS: $("clockS"), clockDate: $("clockDate"),
    uptime: $("uptime"), procs: $("procs"),

    mediaTile: $("mediaTile"), ambientArt: $("ambientArt"),
    artImg: $("artImg"), mediaSource: $("mediaSource"),
    mediaTitle: $("mediaTitle"), mediaArtist: $("mediaArtist"),
    seek: $("seek"), scrub: $("scrub"),
    posText: $("posText"), durText: $("durText"),
    prevBtn: $("prevBtn"), playBtn: $("playBtn"), nextBtn: $("nextBtn"),
    playIcon: $("playIcon"),
    muteBtn: $("muteBtn"), muteIcon: $("muteIcon"), vol: $("vol"),
    volText: $("volText"), volumeWrap: $("volumeWrap"),

    cpuName: $("cpuName"), cpuArc: $("cpuArc"), cpuLoad: $("cpuLoad"),
    cpuTemp: $("cpuTemp"), cpuPower: $("cpuPower"), cores: $("cores"),

    gpuName: $("gpuName"), gpuArc: $("gpuArc"), gpuLoad: $("gpuLoad"),
    gpuTemp: $("gpuTemp"), gpuHot: $("gpuHot"), gpuPower: $("gpuPower"),
    gpuClock: $("gpuClock"), vramText: $("vramText"), vramBar: $("vramBar"),

    ramPct: $("ramPct"), ramText: $("ramText"), ramLadder: $("ramLadder"),
    swapText: $("swapText"), toast: $("toast")
  };

  var DIAL_CIRCUMFERENCE = 326.73;   // 2 * pi * r, r = 52 in the SVG viewBox
  var LADDER_RUNGS = 20;

  var state = {
    booting: true,
    socket: null,
    retry: 0,
    coreCount: 0,
    artRev: -1,
    accent: { h: 168, s: 0.52 },     // mint, until artwork says otherwise
    media: null,
    mediaBase: 0,
    mediaMark: 0,
    seeking: false,
    volumeHeldUntil: 0,
    seekHeldUntil: 0,
    hint: null,
    hintShown: false,
    reduceMotion: false
  };

  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  state.reduceMotion = mq ? mq.matches : false;
  if (mq && mq.addEventListener) {
    mq.addEventListener("change", function (e) { state.reduceMotion = e.matches; });
  }

  /* ------------------------------------------------------------ formatting */

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function fmtClock(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    var s = Math.floor(secs % 60);
    var m = Math.floor(secs / 60) % 60;
    var h = Math.floor(secs / 3600);
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }

  function fmtUptime(secs) {
    var d = Math.floor(secs / 86400);
    var h = Math.floor(secs / 3600) % 24;
    var m = Math.floor(secs / 60) % 60;
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }

  function heat(value, warm, hot) {
    if (value === null || value === undefined) return "";
    if (value >= hot) return "hot";
    if (value >= warm) return "warm";
    return "";
  }

  function setStat(node, text, heatLevel, muted) {
    node.textContent = text;
    if (heatLevel) node.setAttribute("data-heat", heatLevel);
    else node.removeAttribute("data-heat");
    if (muted) node.setAttribute("data-muted", "true");
    else node.removeAttribute("data-muted");
  }

  /* ---------------------------------------------------------------- accent */

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      var hue = function (t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = hue(h + 1 / 3); g = hue(h); b = hue(h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function isLightTheme() {
    var explicit = el.root.getAttribute("data-theme");
    if (explicit === "light") return true;
    if (explicit === "dark") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }

  /* One accent, two lightness targets. The hue never changes between themes,
     but a mint that reads well on near-black would fail contrast as text on
     bright glass, so light mode gets the darker rendering of the same hue. */
  function applyAccent() {
    var light = isLightTheme();
    var s = Math.min(0.82, Math.max(0.34, state.accent.s));
    var rgb = hslToRgb(state.accent.h, s, light ? 0.32 : 0.66);
    el.root.style.setProperty("--accent-rgb", rgb[0] + ", " + rgb[1] + ", " + rgb[2]);
  }

  /* Pick the most convincing colour in the artwork: strongly saturated,
     mid-lightness, and actually common in the image. */
  function accentFromImage(img) {
    try {
      var size = 24;
      var canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      var ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, size, size);
      var data = ctx.getImageData(0, 0, size, size).data;

      var buckets = {};
      var best = null;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        var hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (hsl[2] < 0.12 || hsl[2] > 0.92) continue;   // near black / near white
        if (hsl[1] < 0.14) continue;                     // grey carries no hue
        var key = Math.round(hsl[0] / 15);
        var slot = buckets[key];
        if (!slot) slot = buckets[key] = { n: 0, h: 0, s: 0 };
        slot.n += 1;
        slot.h += hsl[0];
        slot.s += hsl[1];
      }
      for (var k in buckets) {
        if (!Object.prototype.hasOwnProperty.call(buckets, k)) continue;
        var b = buckets[k];
        var score = b.n * (b.s / b.n);
        if (!best || score > best.score) {
          best = { score: score, h: b.h / b.n, s: b.s / b.n };
        }
      }
      return best ? { h: best.h, s: best.s } : null;
    } catch (err) {
      return null;                                       // tainted canvas, etc.
    }
  }

  /* ----------------------------------------------------------------- clock */

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    "Saturday"];

  function tickClock() {
    var now = new Date();
    el.clockHM.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
    el.clockS.textContent = pad(now.getSeconds());
    el.clockDate.textContent = DAYS[now.getDay()] + ", " + now.getDate() + " "
      + MONTHS[now.getMonth()];
    window.setTimeout(tickClock, 1000 - (Date.now() % 1000) + 8);
  }

  /* ------------------------------------------------------------ stats view */

  function setDial(arc, numNode, value) {
    var pct = value === null || value === undefined ? 0 : Math.min(100, Math.max(0, value));
    arc.style.strokeDashoffset = (DIAL_CIRCUMFERENCE * (1 - pct / 100)).toFixed(2);
    numNode.textContent = value === null || value === undefined ? "--" : Math.round(pct);
  }

  function buildCores(n) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < n; i++) {
      var core = document.createElement("div");
      core.className = "core";
      var fill = document.createElement("span");
      fill.className = "core__fill";
      core.appendChild(fill);
      frag.appendChild(core);
    }
    el.cores.innerHTML = "";
    el.cores.appendChild(frag);
    state.coreCount = n;
  }

  function buildLadder() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < LADDER_RUNGS; i++) {
      var rung = document.createElement("div");
      rung.className = "rung";
      frag.appendChild(rung);
    }
    el.ramLadder.appendChild(frag);
  }

  function renderStats(s) {
    if (state.booting) {
      state.booting = false;
      el.root.removeAttribute("data-booting");
    }

    var cpu = s.cpu;
    el.cpuName.textContent = cpu.name;
    setDial(el.cpuArc, el.cpuLoad, cpu.load);

    if (cpu.temp !== null && cpu.temp !== undefined) {
      setStat(el.cpuTemp, Math.round(cpu.temp) + "°", heat(cpu.temp, 72, 88), false);
    } else {
      setStat(el.cpuTemp, s.caps && s.caps.admin ? "no sensor" : "needs admin", "", true);
    }
    setStat(el.cpuPower, cpu.power ? Math.round(cpu.power) + " W" : "--", "", !cpu.power);

    if (cpu.cores && cpu.cores.length !== state.coreCount) buildCores(cpu.cores.length);
    if (cpu.cores) {
      var fills = el.cores.children;
      for (var i = 0; i < fills.length && i < cpu.cores.length; i++) {
        var v = Math.min(100, Math.max(3, cpu.cores[i]));
        fills[i].firstChild.style.transform = "scaleY(" + (v / 100).toFixed(3) + ")";
      }
    }

    var gpu = s.gpu;
    if (gpu) {
      el.gpuName.textContent = gpu.name;
      setDial(el.gpuArc, el.gpuLoad, gpu.load);
      setStat(el.gpuTemp, gpu.temp !== null && gpu.temp !== undefined
        ? Math.round(gpu.temp) + "°" : "--", heat(gpu.temp, 70, 85), false);
      setStat(el.gpuHot, gpu.hotspot ? Math.round(gpu.hotspot) + "°" : "--",
        heat(gpu.hotspot, 80, 95), !gpu.hotspot);
      setStat(el.gpuPower, gpu.power ? Math.round(gpu.power) + " W" : "--", "", !gpu.power);
      setStat(el.gpuClock, gpu.clock ? Math.round(gpu.clock) + " MHz" : "--", "", !gpu.clock);
      if (gpu.vram_used && gpu.vram_total) {
        el.vramText.textContent = (gpu.vram_used / 1024).toFixed(1) + " / "
          + (gpu.vram_total / 1024).toFixed(1) + " GB";
        el.vramBar.style.transform = "scaleX(" + (gpu.vram_pct / 100).toFixed(3) + ")";
      } else {
        el.vramText.textContent = "--";
        el.vramBar.style.transform = "scaleX(0)";
      }
    } else {
      el.gpuName.textContent = "not detected";
      setDial(el.gpuArc, el.gpuLoad, null);
    }

    el.ramPct.textContent = Math.round(s.ram.pct);
    el.ramText.textContent = s.ram.used_gb.toFixed(1) + " / " + s.ram.total_gb.toFixed(1) + " GB";
    var lit = s.ram.pct / 100 * LADDER_RUNGS;
    var rungs = el.ramLadder.children;
    for (var r = 0; r < rungs.length; r++) {
      var full = r + 1 <= Math.floor(lit);
      var edge = !full && r < lit;
      rungs[r].setAttribute("data-on", full ? "true" : (edge ? "edge" : "false"));
    }
    el.swapText.textContent = s.swap.total_gb > 0
      ? s.swap.used_gb.toFixed(1) + " / " + s.swap.total_gb.toFixed(1) + " GB"
      : "off";

    el.uptime.textContent = fmtUptime(s.sys.uptime_s);
    el.procs.textContent = s.sys.procs;
    el.host.textContent = s.sys.host;
    el.os.textContent = s.sys.os;

    renderNotice(s.caps);
  }

  var ADMIN_HINT = "Start Slate with run-admin.bat for CPU temperature, clocks and fan speed.";

  function renderNotice(caps) {
    if (!caps) return;
    var message = null;
    if (!caps.cpu_temp && !caps.admin) message = ADMIN_HINT;
    else if (!caps.lhm) message = "The sensor library did not load, so only load and memory are live.";
    state.hint = message;
    el.cpuTemp.style.cursor = message ? "pointer" : "";
    // Said once on connect, then available on demand: an always-on dashboard
    // should not carry a permanent banner about a thing you already read.
    if (message && !state.hintShown) {
      state.hintShown = true;
      window.setTimeout(function () { toast(message); }, 1400);
    }
  }

  /* ----------------------------------------------------------- media view */

  function renderMedia(m) {
    state.media = m;
    var playing = m.status === "playing";
    var has = m.active;

    el.mediaTile.setAttribute("data-state", has ? (playing ? "playing" : "paused") : "idle");

    if (has) {
      el.mediaTitle.textContent = m.title || "Unknown track";
      el.mediaArtist.textContent = m.artist || (m.album || "");
      el.mediaSource.textContent = m.source || "";
    } else {
      el.mediaTitle.textContent = "Nothing playing";
      el.mediaArtist.textContent = "Start something on this PC and it shows up here.";
      el.mediaSource.textContent = "";
    }

    el.playIcon.className = "ph " + (playing ? "ph-pause" : "ph-play");
    el.prevBtn.disabled = !(m.can && m.can.prev);
    el.nextBtn.disabled = !(m.can && m.can.next);
    el.playBtn.disabled = !(m.can && m.can.play);
    var scrubbable = m.duration > 1;
    el.seek.disabled = !(m.can && m.can.seek) || !scrubbable;
    el.scrub.style.display = scrubbable ? "" : "none";

    // Server clock only: position and updated_at come from the same source.
    var drift = m.ts && m.updated_at ? Math.max(0, m.ts - m.updated_at) : 0;
    state.mediaBase = (m.position || 0) + (playing ? drift : 0);
    state.mediaMark = now();

    if (Date.now() > state.seekHeldUntil) paintProgress();

    if (m.volume && m.volume.supported) {
      el.volumeWrap.style.display = "";
      if (Date.now() > state.volumeHeldUntil) {
        el.vol.value = m.volume.level;
        el.volText.textContent = m.volume.level;
        setRangeFill(el.vol);
      }
      el.muteIcon.className = "ph " + (m.volume.muted ? "ph-speaker-slash" : "ph-speaker-high");
      el.muteBtn.setAttribute("aria-pressed", m.volume.muted ? "true" : "false");
    } else {
      el.volumeWrap.style.display = "none";
    }

    loadArt(m);
  }

  function now() {
    return window.performance && performance.now ? performance.now() / 1000
      : Date.now() / 1000;
  }

  function currentPosition() {
    var m = state.media;
    if (!m || !(m.duration > 1)) return 0;
    var pos = state.mediaBase;
    if (m.status === "playing") pos += now() - state.mediaMark;
    return Math.min(m.duration, Math.max(0, pos));
  }

  function paintProgress() {
    var m = state.media;
    if (!m || !(m.duration > 1)) {
      el.posText.textContent = "0:00";
      el.durText.textContent = "0:00";
      el.seek.value = 0;
      setRangeFill(el.seek);
      return;
    }
    var pos = currentPosition();
    el.posText.textContent = fmtClock(pos);
    el.durText.textContent = fmtClock(m.duration);
    el.seek.value = Math.round(pos / m.duration * 1000);
    setRangeFill(el.seek);
  }

  function setRangeFill(input) {
    var min = parseFloat(input.min) || 0;
    var max = parseFloat(input.max) || 100;
    var pct = max > min ? (parseFloat(input.value) - min) / (max - min) * 100 : 0;
    input.style.setProperty("--pct", pct.toFixed(2) + "%");
  }

  function loadArt(m) {
    if (!m.has_art) {
      if (state.artRev !== -1) {
        state.artRev = -1;
        el.artImg.hidden = true;
        el.artImg.setAttribute("data-shown", "false");
        el.ambientArt.setAttribute("data-loaded", "false");
        el.ambientArt.style.backgroundImage = "";
        state.accent = { h: 168, s: 0.52 };
        applyAccent();
      }
      return;
    }
    if (m.art_rev === state.artRev) return;
    state.artRev = m.art_rev;

    var url = "/api/art?rev=" + m.art_rev;
    var probe = new Image();
    probe.onload = function () {
      el.artImg.src = url;
      el.artImg.hidden = false;
      el.artImg.setAttribute("data-shown", "true");
      el.ambientArt.style.backgroundImage = "url(" + url + ")";
      el.ambientArt.setAttribute("data-loaded", "true");
      var picked = accentFromImage(probe);
      if (picked) { state.accent = picked; applyAccent(); }
    };
    probe.onerror = function () {
      el.artImg.hidden = true;
      el.artImg.setAttribute("data-shown", "false");
    };
    probe.src = url;
  }

  /* -------------------------------------------------------------- controls */

  function send(action, value) {
    var payload = { action: action };
    if (value !== undefined && value !== null) payload.value = value;
    if (state.socket && state.socket.readyState === 1) {
      state.socket.send(JSON.stringify(payload));
      return;
    }
    var qs = value !== undefined && value !== null ? "?value=" + encodeURIComponent(value) : "";
    if (window.fetch) {
      fetch("/api/media/" + action + qs, { method: "POST" })["catch"](function () {
        toast("Could not reach the PC");
      });
    }
  }

  var toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.setAttribute("data-show", "true");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      el.toast.setAttribute("data-show", "false");
    }, 2600);
  }

  el.cpuTemp.addEventListener("click", function () {
    if (state.hint) toast(state.hint);
  });

  el.playBtn.addEventListener("click", function () { send("playpause"); });
  el.nextBtn.addEventListener("click", function () { send("next"); });
  el.prevBtn.addEventListener("click", function () { send("prev"); });

  el.muteBtn.addEventListener("click", function () {
    var m = state.media;
    var muted = !!(m && m.volume && m.volume.muted);
    state.volumeHeldUntil = Date.now() + 1200;
    el.muteIcon.className = "ph " + (!muted ? "ph-speaker-slash" : "ph-speaker-high");
    send("mute", muted ? 0 : 1);
  });

  var volTimer = null;
  el.vol.addEventListener("input", function () {
    state.volumeHeldUntil = Date.now() + 1400;
    el.volText.textContent = el.vol.value;
    setRangeFill(el.vol);
    if (volTimer) return;                       // throttle: COM writes are not free
    volTimer = window.setTimeout(function () {
      volTimer = null;
      send("volume", parseInt(el.vol.value, 10));
    }, 110);
  });

  el.seek.addEventListener("input", function () {
    var m = state.media;
    if (!m || !(m.duration > 1)) return;
    state.seeking = true;
    state.seekHeldUntil = Date.now() + 2000;
    el.posText.textContent = fmtClock(el.seek.value / 1000 * m.duration);
    setRangeFill(el.seek);
  });

  el.seek.addEventListener("change", function () {
    var m = state.media;
    state.seeking = false;
    if (!m || !(m.duration > 1)) return;
    var target = el.seek.value / 1000 * m.duration;
    state.mediaBase = target;
    state.mediaMark = now();
    state.seekHeldUntil = Date.now() + 1200;
    send("seek", Math.round(target));
  });

  /* --------------------------------------------------- theme, wake, screen */

  function resolveThemeIcon() {
    el.themeIcon.className = "ph " + (isLightTheme() ? "ph-moon" : "ph-sun");
  }

  el.themeBtn.addEventListener("click", function () {
    var next = isLightTheme() ? "dark" : "light";
    el.root.setAttribute("data-theme", next);
    try { window.localStorage.setItem("slate.theme", next); } catch (e) {}
    resolveThemeIcon();
    applyAccent();
  });

  var wakeLock = null;

  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  function requestWake() {
    if (!navigator.wakeLock) { toast("This browser cannot hold the screen awake"); return; }
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
      lock.addEventListener("release", function () { wakeLock = null; });
      el.wakeBtn.setAttribute("aria-pressed", "true");
    })["catch"](function () {
      el.wakeBtn.setAttribute("aria-pressed", "false");
      toast("The screen lock was refused");
    });
  }

  el.wakeBtn.addEventListener("click", function () {
    var on = el.wakeBtn.getAttribute("aria-pressed") === "true";
    if (on) {
      releaseWake();
      el.wakeBtn.setAttribute("aria-pressed", "false");
      try { window.localStorage.setItem("slate.wake", "0"); } catch (e) {}
    } else {
      requestWake();
      try { window.localStorage.setItem("slate.wake", "1"); } catch (e) {}
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible"
      && el.wakeBtn.getAttribute("aria-pressed") === "true" && !wakeLock) {
      requestWake();
    }
  });

  el.fsBtn.addEventListener("click", function () {
    var doc = document;
    var root = doc.documentElement;
    var isFull = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (isFull) {
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
    } else if (root.requestFullscreen) {
      root.requestFullscreen()["catch"](function () {});
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
  });

  function syncFsIcon() {
    var isFull = document.fullscreenElement || document.webkitFullscreenElement;
    el.fsIcon.className = "ph " + (isFull ? "ph-arrows-in" : "ph-arrows-out");
  }
  document.addEventListener("fullscreenchange", syncFsIcon);
  document.addEventListener("webkitfullscreenchange", syncFsIcon);

  /* ------------------------------------------------------------- transport */

  function setConn(stateName, text) {
    el.connChip.setAttribute("data-state", stateName);
    el.connText.textContent = text;
    el.connIcon.className = "ph " + (
      stateName === "live" ? "ph-broadcast"
        : stateName === "down" ? "ph-wifi-slash" : "ph-circle-notch");
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var socket = new WebSocket(proto + "//" + location.host + "/ws");
    state.socket = socket;

    socket.onopen = function () {
      state.retry = 0;
      setConn("live", "Live");
    };

    socket.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === "hello") {
        if (msg.stats) renderStats(msg.stats);
        if (msg.media) renderMedia(msg.media);
        if (!msg.media_available) {
          el.mediaArtist.textContent = "Media controls are unavailable on this machine.";
        }
      } else if (msg.type === "stats") {
        renderStats(msg);
      } else if (msg.type === "media") {
        renderMedia(msg);
      } else if (msg.type === "error") {
        toast(msg.where + ": " + msg.message);
      }
    };

    socket.onclose = function () {
      state.socket = null;
      var wait = Math.min(8000, 700 * Math.pow(1.6, state.retry));
      state.retry += 1;
      setConn("down", "Reconnecting");
      window.setTimeout(connect, wait);
    };

    socket.onerror = function () { try { socket.close(); } catch (e) {} };
  }

  /* ----------------------------------------------------------------- start */

  (function boot() {
    var saved = null;
    try { saved = window.localStorage.getItem("slate.theme"); } catch (e) {}
    if (saved === "light" || saved === "dark") el.root.setAttribute("data-theme", saved);
    resolveThemeIcon();
    applyAccent();

    buildLadder();
    tickClock();
    setRangeFill(el.seek);
    setRangeFill(el.vol);
    setConn("connecting", "Connecting");
    connect();

    var wakePref = null;
    try { wakePref = window.localStorage.getItem("slate.wake"); } catch (e) {}
    if (wakePref === "1") requestWake();

    // Progress is interpolated locally; the server only re-anchors it once a
    // second. 4 Hz is smooth enough and costs one style write.
    window.setInterval(function () {
      if (!state.seeking && Date.now() > state.seekHeldUntil) paintProgress();
    }, 250);

    if (window.matchMedia) {
      var scheme = window.matchMedia("(prefers-color-scheme: light)");
      if (scheme.addEventListener) {
        scheme.addEventListener("change", function () {
          resolveThemeIcon();
          applyAccent();
        });
      }
    }
  })();
})();
