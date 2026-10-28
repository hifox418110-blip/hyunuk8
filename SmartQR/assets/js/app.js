(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const stage = $('#stage');
  const panel = $('#inputPanel');
  const form = $('#qrForm');
  const errorMsg = $('#errorMsg');
  const qrCard = $('#qrCard');
  const canvas = $('#qrCanvas');
  const summary = $('#qrSummary');
  const customColor = $('#customColor');
  const emblemToggle = $('#emblemToggle');
  const contrastWarn = $('#contrastWarn');
  const drawer = $('#historyDrawer');
  const backdrop = $('#drawerBackdrop');
  const historyList = $('#historyList');
  const historyEmpty = $('#historyEmpty');
  const historyCount = $('#historyCount');

  const STYLE_KEY = 'smartqr.style';
  const HISTORY_KEY = 'smartqr.history';
  const HISTORY_LIMIT = 30;
  const DEFAULT_STYLE = { color: '#111111', dot: 'square', eye: 'square', emblem: false };

  const TYPE_LABELS = { url: 'URL', contact: '연락처', email: '이메일', sms: '문자' };

  // Library only encodes Latin-1 by default; payloads may contain Korean.
  qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

  const emblemImg = new Image();
  // Inlined as a data URL: a file:// image would taint the canvas and block JPG export.
  emblemImg.src = window.KMOU_EMBLEM;
  emblemImg.onload = () => { if (current && style.emblem) render(); };

  let type = 'url';
  let style = { ...DEFAULT_STYLE, ...load(STYLE_KEY, {}) };
  let history = load(HISTORY_KEY, []).filter((h) => h.type in TYPE_LABELS);
  let current = null; // { id, type, fields, payload, label }

  /* ---------- Input ---------- */

  $('#startBtn').addEventListener('click', () => {
    stage.classList.add('input-open');
    focusFirstField();
  });

  $$('.type-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      setType(btn.dataset.type);
      focusFirstField();
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fields = readFields(type);
    const result = BUILDERS[type](fields);
    $$('.fields.active .invalid').forEach((el) => el.classList.remove('invalid'));

    if (result.error) {
      errorMsg.textContent = result.error;
      const bad = result.field && form.elements[result.field];
      if (bad) { bad.classList.add('invalid'); bad.focus(); }
      return;
    }

    errorMsg.textContent = '';
    if (result.normalized) writeFields(result.normalized);
    current = addToHistory(type, readFields(type), result.payload, result.label);
    showResult();
    document.activeElement.blur();
  });

  form.addEventListener('input', (e) => {
    errorMsg.textContent = '';
    e.target.classList.remove('invalid');
  });

  function setType(next) {
    type = next;
    $$('.type-tabs button').forEach((b) => {
      const on = b.dataset.type === next;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    $$('.fields').forEach((f) => f.classList.toggle('active', f.dataset.type === next));
    errorMsg.textContent = '';
  }

  function focusFirstField() {
    const el = $('.fields.active input, .fields.active select');
    if (el) el.focus();
  }

  function readFields(t) {
    const out = {};
    $$(`.fields[data-type="${t}"] [name]`).forEach((el) => {
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
    });
    return out;
  }

  function writeFields(values) {
    Object.entries(values).forEach(([name, value]) => {
      const el = form.elements[name];
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = value;
    });
  }

  /* ---------- Payload builders ---------- */

  const BUILDERS = {
    url({ url }) {
      const href = normalizeUrl(url);
      if (!href) return { error: '올바른 URL을 입력해 주세요. (예: https://kmou.ac.kr)', field: 'url' };
      const u = new URL(href);
      return { payload: href, label: u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname), normalized: { url: href } };
    },

    contact({ name, phone, contactEmail, org, title, website }) {
      if (!name) return { error: '이름을 입력해 주세요.', field: 'name' };
      if (contactEmail && !isEmail(contactEmail)) return { error: '이메일 형식이 올바르지 않아요.', field: 'contactEmail' };
      const esc = (s) => s.replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(name)};;;;`, `FN:${esc(name)}`];
      if (org) lines.push(`ORG:${esc(org)}`);
      if (title) lines.push(`TITLE:${esc(title)}`);
      if (phone) lines.push(`TEL;TYPE=CELL:${phone}`);
      if (contactEmail) lines.push(`EMAIL:${contactEmail}`);
      const site = website && normalizeUrl(website);
      if (website && !site) return { error: '웹사이트 주소가 올바르지 않아요.', field: 'website' };
      if (site) lines.push(`URL:${site}`);
      lines.push('END:VCARD');
      return { payload: lines.join('\n'), label: org ? `${name} · ${org}` : name, normalized: site ? { website: site } : null };
    },

    email({ to, subject, body }) {
      if (!isEmail(to)) return { error: '받는 사람 이메일을 올바르게 입력해 주세요.', field: 'to' };
      const params = [];
      if (subject) params.push('subject=' + encodeURIComponent(subject));
      if (body) params.push('body=' + encodeURIComponent(body));
      return { payload: `mailto:${to}${params.length ? '?' + params.join('&') : ''}`, label: to };
    },

    sms({ smsTo, message }) {
      const number = smsTo.replace(/[^\d+]/g, '');
      if (number.length < 3) return { error: '받는 번호를 입력해 주세요.', field: 'smsTo' };
      return { payload: `SMSTO:${number}:${message}`, label: smsTo };
    },
  };

  function normalizeUrl(raw) {
    let value = (raw || '').trim();
    if (!value) return null;
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = 'https://' + value;
    try {
      const parsed = new URL(value);
      if (/^https?:$/.test(parsed.protocol) && !parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function isEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
  }

  /* ---------- Result view ---------- */

  function showResult() {
    render();
    summary.innerHTML = '';
    const tag = document.createElement('b');
    tag.textContent = TYPE_LABELS[current.type];
    summary.append(tag, current.label);

    if (!stage.classList.contains('generated')) {
      stage.classList.add('input-open');
      const first = panel.getBoundingClientRect();
      stage.classList.add('generated');
      const last = panel.getBoundingClientRect();
      panel.animate(
        [{ transform: `translate(${first.left - last.left}px, ${first.top - last.top}px)` }, { transform: 'none' }],
        { duration: 700, easing: 'cubic-bezier(.65, 0, .35, 1)' }
      );
    } else {
      qrCard.classList.remove('refresh');
      void qrCard.offsetWidth;
      qrCard.classList.add('refresh');
    }
  }

  function render() {
    if (current) drawQr(canvas, current.payload, style);
  }

  qrCard.addEventListener('click', () => {
    if (!current) return;
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/jpeg', 0.95);
    link.download = `smart-qr_${current.type}_${current.label}`.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) + '.jpg';
    document.body.appendChild(link);
    link.click();
    link.remove();
  });

  /* ---------- QR renderer ---------- */

  function drawQr(target, text, opts) {
    const qr = qrcode(0, opts.emblem ? 'H' : 'M');
    qr.addData(text, 'Byte');
    qr.make();

    const n = qr.getModuleCount();
    const size = target.width;
    const cell = Math.max(1, Math.floor(size / (n + 8)));
    const offset = Math.round((size - cell * n) / 2);
    const ctx = target.getContext('2d');

    const aligns = alignmentCenters(n);
    const inEye = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    const inAlign = (r, c) => aligns.some(([ar, ac]) => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2);
    const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && !inEye(r, c) && !inAlign(r, c) && qr.isDark(r, c);

    const modules = new Path2D();
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!dark(r, c)) continue;
        const x = offset + c * cell;
        const y = offset + r * cell;
        // Separated shapes on the timing lines break many decoders.
        const shape = opts.dot !== 'liquid' && (r === 6 || c === 6) ? 'square' : opts.dot;
        addModule(modules, shape, x, y, cell, r, c, dark);
      }
    }

    const eyes = new Path2D();
    [[0, 0], [0, n - 7], [n - 7, 0]].forEach(([r, c]) => {
      addRing(eyes, opts.eye, offset + c * cell, offset + r * cell, cell, 7);
    });
    aligns.forEach(([r, c]) => {
      addRing(eyes, opts.eye, offset + (c - 2) * cell, offset + (r - 2) * cell, cell, 5);
    });

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = makeFill(ctx, opts.color, offset, offset + cell * n);
    ctx.fill(modules);
    ctx.fill(eyes, 'evenodd');

    if (opts.emblem && emblemImg.complete && emblemImg.naturalWidth) {
      const center = size / 2;
      const logo = Math.round(cell * n * 0.22);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(center, center, logo / 2 + cell * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.drawImage(emblemImg, center - logo / 2, center - logo / 2, logo, logo);
    }
  }

  function alignmentCenters(n) {
    const version = (n - 17) / 4;
    if (version < 2) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const pos = [6];
    for (let p = n - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
    const centers = [];
    pos.forEach((r) => pos.forEach((c) => {
      const onFinder = (r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6);
      if (!onFinder) centers.push([r, c]);
    }));
    return centers;
  }

  function addModule(path, shape, x, y, s, r, c, dark) {
    if (shape === 'dot') {
      const rad = s * 0.45;
      path.moveTo(x + s / 2 + rad, y + s / 2);
      path.arc(x + s / 2, y + s / 2, rad, 0, Math.PI * 2);
    } else if (shape === 'rounded') {
      const g = s * 0.06;
      path.roundRect(x + g, y + g, s - g * 2, s - g * 2, s * 0.3);
    } else if (shape === 'liquid') {
      const up = dark(r - 1, c), down = dark(r + 1, c), left = dark(r, c - 1), right = dark(r, c + 1);
      const k = s / 2;
      path.roundRect(x, y, s, s, [
        !up && !left ? k : 0,
        !up && !right ? k : 0,
        !down && !right ? k : 0,
        !down && !left ? k : 0,
      ]);
    } else {
      path.rect(x, y, s, s);
    }
  }

  // Finder (size 7) and alignment (size 5) patterns: outer ring, gap, solid center.
  function addRing(path, shape, x, y, s, size) {
    [size, size - 2, size - 4].forEach((k, i) => {
      const inset = i * s;
      const w = k * s;
      if (shape === 'circle') {
        const cx = x + (size * s) / 2, cy = y + (size * s) / 2;
        path.moveTo(cx + w / 2, cy);
        path.arc(cx, cy, w / 2, 0, Math.PI * 2);
      } else if (shape === 'rounded') {
        path.roundRect(x + inset, y + inset, w, w, w * 0.3);
      } else {
        path.rect(x + inset, y + inset, w, w);
      }
    });
  }

  function makeFill(ctx, color, from, to) {
    const stops = color.split(',');
    if (stops.length < 2) return stops[0];
    const grad = ctx.createLinearGradient(from, from, to, to);
    stops.forEach((stop, i) => grad.addColorStop(i / (stops.length - 1), stop));
    return grad;
  }

  /* ---------- Style panel ---------- */

  $$('.swatch[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => updateStyle({ color: btn.dataset.color }));
  });

  customColor.addEventListener('input', () => updateStyle({ color: customColor.value }));

  $$('.segmented').forEach((group) => {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) updateStyle({ [group.dataset.option]: btn.dataset.value });
    });
  });

  emblemToggle.addEventListener('change', () => updateStyle({ emblem: emblemToggle.checked }));

  let saveTimer;
  function updateStyle(patch) {
    style = { ...style, ...patch };
    syncStyleControls();
    render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save(STYLE_KEY, style);
      if (current) {
        const entry = history.find((h) => h.id === current.id);
        if (entry) { entry.style = { ...style }; saveHistory(); }
      }
    }, 300);
  }

  function syncStyleControls() {
    let matched = false;
    $$('.swatch[data-color]').forEach((btn) => {
      const on = btn.dataset.color === style.color;
      btn.classList.toggle('active', on);
      matched = matched || on;
    });
    const custom = $('.swatch-custom');
    custom.classList.toggle('active', !matched);
    if (!matched) {
      custom.style.background = style.color;
      customColor.value = style.color;
    } else {
      custom.style.background = '';
    }

    $$('.segmented').forEach((group) => {
      $$('button', group).forEach((b) => b.classList.toggle('active', b.dataset.value === style[group.dataset.option]));
    });
    emblemToggle.checked = style.emblem;

    const lightest = Math.max(...style.color.split(',').map(luminance));
    contrastWarn.hidden = lightest < 0.4;
  }

  function luminance(hex) {
    const v = parseInt(hex.slice(1), 16);
    const ch = [v >> 16, (v >> 8) & 255, v & 255].map((x) => {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /* ---------- History ---------- */

  function addToHistory(t, fields, payload, label) {
    const existing = history.findIndex((h) => h.type === t && h.payload === payload);
    if (existing !== -1) history.splice(existing, 1);
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: t, fields, payload, label, style: { ...style }, createdAt: Date.now() };
    history.unshift(entry);
    history = history.slice(0, HISTORY_LIMIT);
    saveHistory();
    return entry;
  }

  function saveHistory() {
    save(HISTORY_KEY, history);
    renderHistory();
  }

  function renderHistory() {
    historyCount.hidden = history.length === 0;
    historyCount.textContent = history.length;
    historyEmpty.hidden = history.length > 0;
    $('#clearHistory').hidden = history.length === 0;

    historyList.innerHTML = '';
    history.forEach((entry) => {
      const li = document.createElement('li');
      li.className = 'history-item' + (current && current.id === entry.id ? ' current' : '');
      li.tabIndex = 0;

      const thumb = document.createElement('canvas');
      thumb.width = thumb.height = 400;
      drawQr(thumb, entry.payload, entry.style);

      const info = document.createElement('div');
      info.className = 'history-info';
      const title = document.createElement('strong');
      title.textContent = entry.label;
      const meta = document.createElement('span');
      const kind = document.createElement('em');
      kind.textContent = TYPE_LABELS[entry.type];
      meta.append(kind, timeAgo(entry.createdAt));
      info.append(title, meta);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.setAttribute('aria-label', '기록 삭제');
      del.innerHTML = $('#drawerClose').innerHTML;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        history = history.filter((h) => h.id !== entry.id);
        saveHistory();
      });

      li.append(thumb, info, del);
      li.addEventListener('click', () => restore(entry));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') restore(entry); });
      historyList.appendChild(li);
    });
  }

  function restore(entry) {
    setType(entry.type);
    writeFields(entry.fields);
    style = { ...DEFAULT_STYLE, ...entry.style };
    syncStyleControls();
    save(STYLE_KEY, style);
    current = entry;
    closeDrawer();
    showResult();
    renderHistory();
  }

  function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return '방금 전';
    if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
    if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}일 전`;
    return new Date(ts).toLocaleDateString('ko-KR');
  }

  $('#clearHistory').addEventListener('click', () => {
    if (!confirm('최근 기록을 모두 삭제할까요?')) return;
    history = [];
    saveHistory();
  });

  function openDrawer() {
    renderHistory();
    backdrop.hidden = false;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    $('#drawerClose').focus();
  }

  function closeDrawer() {
    backdrop.hidden = true;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  $('#historyBtn').addEventListener('click', openDrawer);
  $('#drawerClose').addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
  });

  /* ---------- Storage ---------- */

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  setType('url');
  syncStyleControls();
  renderHistory();
})();
