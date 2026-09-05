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

    wx: $("wx"), wxIcon: $("wxIcon"), wxTemp: $("wxTemp"), wxText: $("wxText"),
    wxSub: $("wxSub"), wxHours: $("wxHours"),

    mediaTile: $("mediaTile"), ambientArt: $("ambientArt"),
    ambientClip: $("ambientClip"), ambientStill: $("ambientStill"),
    artImg: $("artImg"), artRing: $("artRing"), artBloom: $("artBloom"),
    artPlate: document.querySelector(".media__plate"),
    spectrumWrap: $("spectrumWrap"), spectrum: $("spectrum"),
    mediaSource: $("mediaSource"),
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
  var RING_LENGTH = 363.4;           // perimeter of the 96.8 square, rx 13;
                                     // remeasured from the DOM on boot
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
    reduceMotion: false,
    trackKey: null,
    clips: [],
    clipIndex: 0,
    clipShown: false
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

  /* --------------------------------------------------------------- weather */

  /* WMO code groups to a Phosphor glyph. Clear and partly-cloudy also depend
     on whether the sun is up, which is the difference between a dashboard
     that looks aware and one that shows a sun at 3am. */
  function weatherIcon(kind, day) {
    if (kind === "clear") return day ? "ph-sun" : "ph-moon";
    if (kind === "partly") return day ? "ph-cloud-sun" : "ph-cloud-moon";
    if (kind === "fog") return "ph-cloud-fog";
    if (kind === "drizzle") return "ph-cloud-rain";
    if (kind === "rain") return "ph-cloud-rain";
    if (kind === "snow") return "ph-cloud-snow";
    if (kind === "storm") return "ph-cloud-lightning";
    return "ph-cloud";
  }

  var WX_GROUP = {
    0: "clear", 1: "clear", 2: "partly", 3: "cloud", 45: "fog", 48: "fog",
    51: "drizzle", 53: "drizzle", 55: "drizzle", 56: "drizzle", 57: "drizzle",
    61: "rain", 63: "rain", 65: "rain", 66: "rain", 67: "rain",
    71: "snow", 73: "snow", 75: "snow", 77: "snow",
    80: "rain", 81: "rain", 82: "rain", 85: "snow", 86: "snow",
    95: "storm", 96: "storm", 99: "storm"
  };

  function renderWeather(w) {
    if (!w || !w.ok) {
      el.wx.hidden = true;
      return;
    }
    el.wx.hidden = false;
    el.wxIcon.className = "ph " + weatherIcon(w.icon, w.day) + " wx__icon";
    el.wxTemp.textContent = w.temp;
    el.wxText.textContent = w.text;

    var sub = "feels " + w.feels + "\u00b0";
    if (w.high !== null && w.low !== null) {
      sub += "   high " + w.high + "\u00b0   low " + w.low + "\u00b0";
    }
    el.wxSub.textContent = sub;

    var hours = w.hours || [];
    var html = "";
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      var kind = WX_GROUP[h.code] || "cloud";
      // Anything past sunset in the strip is still drawn with day glyphs; the
      // hourly feed carries no is_day flag and guessing it would be worse.
      html += '<div class="wx__hour">'
        + '<span class="wx__hour-at">' + h.at + '</span>'
        + '<i class="ph ' + weatherIcon(kind, true) + '" aria-hidden="true"></i>'
        + '<span class="wx__hour-temp">' + (h.temp === null ? "--" : h.temp)
        + "\u00b0</span></div>";
    }
    el.wxHours.innerHTML = html;
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

  /* -------------------------------------------------------------- spectrum */

  /* The server sends bands about 23 times a second. Drawing straight from
     those frames looks stepped, so the canvas eases toward each new target on
     its own rAF loop, and the loop stops entirely once the music does. */
  var spectrum = {
    target: null,
    value: null,
    energy: 0,
    lastFrame: 0,
    raf: 0,
    ctx: null,
    w: 0,
    h: 0,
    dpr: 1
  };

  function spectrumSize() {
    var canvas = el.spectrum;
    var rect = canvas.parentNode.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    if (w === spectrum.w && h === spectrum.h && spectrum.dpr === dpr) return;
    spectrum.w = w; spectrum.h = h; spectrum.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    spectrum.ctx = canvas.getContext("2d");
    if (spectrum.ctx) spectrum.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function accentRgb() {
    var v = getComputedStyle(el.root).getPropertyValue("--accent-rgb").trim();
    return v || "86, 214, 195";
  }

  function roundedBar(ctx, x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h) r = h;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  function drawSpectrum() {
    spectrumSize();
    var ctx = spectrum.ctx;
    if (!ctx || !spectrum.value) return;
    var w = spectrum.w, h = spectrum.h, n = spectrum.value.length;
    ctx.clearRect(0, 0, w, h);

    var gap = n > 20 ? 2 : 4;
    var bw = (w - gap * (n - 1)) / n;
    if (bw <= 0) return;

    var rgb = accentRgb();
    for (var i = 0; i < n; i++) {
      var bh = Math.max(2, spectrum.value[i] * h);
      var top = h - bh;
      // The gradient has to run from each bar's own tip, not from the top of
      // the canvas: shared over the full height, short bars only ever pick up
      // the faint end of it and the whole field washes out.
      var grad = ctx.createLinearGradient(0, top, 0, h);
      grad.addColorStop(0, "rgba(" + rgb + ", 1)");
      grad.addColorStop(1, "rgba(" + rgb + ", 0.42)");
      ctx.fillStyle = grad;
      roundedBar(ctx, i * (bw + gap), top, bw, bh, bw * 0.4);
    }

    // A hairline floor so the field still reads as an instrument when quiet.
    ctx.fillStyle = "rgba(" + rgb + ", 0.22)";
    ctx.fillRect(0, h - 1, w, 1);
  }

  function spectrumTick() {
    var v = spectrum.value, t = spectrum.target;
    var settled = true;
    var sum = 0;
    for (var i = 0; i < v.length; i++) {
      var d = t[i] - v[i];
      v[i] += d * (d > 0 ? 0.42 : 0.16);
      if (Math.abs(d) > 0.004 || v[i] > 0.004) settled = false;
      sum += v[i];
    }
    spectrum.energy = sum / v.length;
    drawSpectrum();

    // The cover breathes with the overall level: the cheapest way to tie the
    // artwork to the music without touching the image itself.
    if (el.artPlate) {
      el.artPlate.style.transform =
        "scale(" + (1 + spectrum.energy * 0.05).toFixed(4) + ")";
    }
    el.artBloom.style.opacity = Math.min(1, spectrum.energy * 2.1).toFixed(3);
    el.artBloom.style.transform =
      "scale(" + (0.82 + spectrum.energy * 0.5).toFixed(3) + ")";

    if (Date.now() - spectrum.lastFrame > 900 && settled) {
      spectrum.raf = 0;
      el.spectrumWrap.hidden = true;
      if (el.artPlate) el.artPlate.style.transform = "";
      el.artBloom.style.opacity = "0";
      return;
    }
    spectrum.raf = window.requestAnimationFrame(spectrumTick);
  }

  function onSpectrumFrame(bands) {
    if (state.reduceMotion || !bands || !bands.length) return;
    if (!spectrum.value || spectrum.value.length !== bands.length) {
      spectrum.value = [];
      spectrum.target = [];
      for (var i = 0; i < bands.length; i++) {
        spectrum.value.push(0);
        spectrum.target.push(0);
      }
    }
    for (var j = 0; j < bands.length; j++) spectrum.target[j] = bands[j] / 100;
    spectrum.lastFrame = Date.now();
    if (el.spectrumWrap.hidden) {
      el.spectrumWrap.hidden = false;
      spectrum.w = 0;                       // force a resize on first reveal
    }
    if (!spectrum.raf && !document.hidden) {
      spectrum.raf = window.requestAnimationFrame(spectrumTick);
    }
  }

  /* ----------------------------------------------------------- media view */

  var SCRAMBLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/";

  /* A short decode on the title is the one moment this panel earns a
     flourish: it marks that the track actually changed. */
  function setTitle(text, animate) {
    var node = el.mediaTitle;
    if (!animate || state.reduceMotion) {
      node.textContent = text;
      fitTitle();
      return;
    }
    var start = Date.now();
    (function step() {
      var p = Math.min(1, (Date.now() - start) / 460);
      var shown = Math.floor(p * text.length);
      var out = text.slice(0, shown);
      for (var i = shown; i < text.length; i++) {
        out += text.charAt(i) === " " ? " "
          : SCRAMBLE.charAt(Math.floor(Math.random() * SCRAMBLE.length));
      }
      node.textContent = out;
      if (p < 1) window.requestAnimationFrame(step);
      else { node.textContent = text; fitTitle(); }
    })();
  }

  /* A wall dashboard should eventually show the whole name, so an overlong
     title scrolls instead of ending in an ellipsis forever. */
  function fitTitle() {
    var box = el.mediaTitle.parentNode;
    box.classList.remove("media__title--scroll");
    var overflow = el.mediaTitle.scrollWidth - box.clientWidth;
    if (overflow > 8 && !state.reduceMotion) {
      box.style.setProperty("--scroll-by", (-overflow - 12) + "px");
      box.classList.add("media__title--scroll");
    }
  }

  function renderMedia(m) {
    state.media = m;
    var playing = m.status === "playing";
    var has = m.active;

    el.mediaTile.setAttribute("data-state", has ? (playing ? "playing" : "paused") : "idle");

    var key = has ? (m.title || "") + "|" + (m.artist || "") : "idle";
    var changed = key !== state.trackKey;
    state.trackKey = key;

    if (has) {
      if (changed) setTitle(m.title || "Unknown track", true);
      el.mediaArtist.textContent = m.artist || (m.album || "");
      el.mediaSource.textContent = m.source || "";
    } else {
      if (changed) setTitle("Nothing playing", false);
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
      setRing(0);
      return;
    }
    var pos = currentPosition();
    el.posText.textContent = fmtClock(pos);
    el.durText.textContent = fmtClock(m.duration);
    el.seek.value = Math.round(pos / m.duration * 1000);
    setRangeFill(el.seek);
    setRing(pos / m.duration);
  }

  function setRing(fraction) {
    var f = fraction > 0 ? (fraction > 1 ? 1 : fraction) : 0;
    el.artRing.style.strokeDashoffset = (RING_LENGTH * (1 - f)).toFixed(1);
  }

  /* Rounded-rect perimeters differ slightly between engines, and a stale
     constant leaves the ring a hair short of closing at 100%. Ask the DOM. */
  function measureRing() {
    if (!el.artRing.getTotalLength) return;
    var len = el.artRing.getTotalLength();
    if (len > 10) {
      RING_LENGTH = len;
      el.artRing.style.strokeDasharray = len.toFixed(2);
      el.artRing.style.strokeDashoffset = len.toFixed(2);
    }
  }

  function setRangeFill(input) {
    var min = parseFloat(input.min) || 0;
    var max = parseFloat(input.max) || 100;
    var pct = max > min ? (parseFloat(input.value) - min) / (max - min) * 100 : 0;
    input.style.setProperty("--pct", pct.toFixed(2) + "%");
  }

  function loadArt(m) {
    showClip(!m.has_art);
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

  /* ---------------------------------------------------------------- ambient */

  /* Anything dropped into web/ambient becomes the backdrop the glass refracts
     over. Album artwork still wins when something is playing, because the art
     is the more useful signal. */
  function loadClips() {
    if (!window.fetch) return;
    fetch("/api/ambient").then(function (r) {
      return r.ok ? r.json() : { items: [] };
    }).then(function (data) {
      state.clips = data.items || [];
      if (!state.clips.length) return;
      state.clipIndex = Math.floor(Math.random() * state.clips.length);
      applyClip();
      if (state.clips.length > 1) {
        window.setInterval(function () {
          state.clipIndex = (state.clipIndex + 1) % state.clips.length;
          applyClip();
        }, 360000);                       // a new one every six minutes
      }
    })["catch"](function () {});
  }

  function applyClip() {
    var clip = state.clips[state.clipIndex];
    if (!clip) return;
    var isVideo = clip.kind === "video";
    // A GIF cannot go in a <video>, so stills get their own element rather
    // than being silently dropped.
    el.ambientClip.setAttribute("data-active", isVideo ? "true" : "false");
    el.ambientStill.setAttribute("data-active", isVideo ? "false" : "true");
    if (isVideo) {
      el.ambientStill.removeAttribute("src");
      el.ambientClip.src = clip.url;
      el.ambientClip.load();
      if (state.clipShown) playClip();
    } else {
      el.ambientClip.pause();
      el.ambientClip.removeAttribute("src");
      el.ambientStill.src = clip.url;
    }
    if (state.clipShown) markClipShown(true);
  }

  function markClipShown(on) {
    var flag = on ? "true" : "false";
    el.ambientClip.setAttribute("data-shown", flag);
    el.ambientStill.setAttribute("data-shown", flag);
  }

  function playClip() {
    var attempt = el.ambientClip.play();
    if (attempt && attempt["catch"]) attempt["catch"](function () {});
  }

  /* Decoding video costs battery, so it only runs when it is actually the
     thing on screen. */
  function showClip(on) {
    if (!state.clips.length) return;
    if (on === state.clipShown) return;
    state.clipShown = on;
    markClipShown(on);
    if (on && !document.hidden) playClip();
    else el.ambientClip.pause();
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
    // Nothing should animate for a screen nobody is looking at.
    if (document.hidden && spectrum.raf) {
      window.cancelAnimationFrame(spectrum.raf);
      spectrum.raf = 0;
    }
    if (document.hidden) el.ambientClip.pause();
    else if (state.clipShown) playClip();
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
        if (msg.weather) renderWeather(msg.weather);
        if (!msg.media_available) {
          el.mediaArtist.textContent = "Media controls are unavailable on this machine.";
        }
      } else if (msg.type === "stats") {
        renderStats(msg);
      } else if (msg.type === "media") {
        renderMedia(msg);
      } else if (msg.type === "fft") {
        onSpectrumFrame(msg.b);
      } else if (msg.type === "weather") {
        renderWeather(msg);
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
    measureRing();
    loadClips();
    tickClock();
    setRangeFill(el.seek);
    setRangeFill(el.vol);
    setConn("connecting", "Connecting");
    connect();

    window.addEventListener("resize", function () {
      spectrum.w = 0;
      fitTitle();
    });

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
