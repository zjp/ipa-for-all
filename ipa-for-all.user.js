// ==UserScript==
// @name         IPA for All
// @namespace    ipa-for-all
// @version      0.1.0
// @description  Per-symbol pronunciation tooltips for IPA transcriptions in every language on Wikipedia, not just English.
// @homepageURL  https://github.com/zjp/ipa-for-all
// @downloadURL  https://github.com/zjp/ipa-for-all/raw/main/ipa-for-all.user.js
// @updateURL    https://github.com/zjp/ipa-for-all/raw/main/ipa-for-all.user.js
// @match        https://*.wikipedia.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * How it works
 * ------------
 * Non-English transcriptions on Wikipedia render as
 *     <span class="IPA"><a href="/wiki/Help:IPA/French">[paʁi]</a></span>
 * and the linked key page holds tables of  symbol | examples | English approximation.
 * We fetch that key (once, cached in localStorage), turn its tables into a
 * symbol -> explanation map, split the transcription into symbols by longest
 * match against the map, and show the explanation on hover.
 * Symbols missing from a language's key fall back to the generic Help:IPA chart.
 */
(function () {
  'use strict';

  const CACHE_PREFIX = 'ipa4all:v1:';
  const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
  const GENERIC_KEY = 'Help:IPA';
  const EAGER_KEY_LIMIT = 6; // more distinct languages than this on one page: load on hover instead
  const TIES = /[\u0361\u035C]/g; // tie bars: t\u0361s is looked up as ts
  const TIE = /[\u0361\u035C]/;
  const MARK = /\p{M}/u;

  // Last resort for marks that neither the language key nor Help:IPA explains.
  const BUILTIN = {
    'ˈ': 'primary stress (on the following syllable)',
    'ˌ': 'secondary stress (on the following syllable)',
    '.': 'syllable break',
    'ː': 'long (preceding sound is lengthened)',
    'ˑ': 'half-long',
    '‿': 'linking (no break between words)',
    '|': 'minor (foot) break',
    '‖': 'major (intonation) break',
    'ʰ': 'aspirated (followed by a puff of air)',
    'ʲ': 'palatalized (with a y-like quality)',
    'ʷ': 'labialized (with rounded lips)',
    'ˠ': 'velarized',
    'ˤ': 'pharyngealized',
    'ʼ': 'ejective',
    'ˀ': 'glottalized',
    'ⁿ': 'nasal release / prenasalized',
    '˥': 'extra-high tone', '˦': 'high tone', '˧': 'mid tone', '˨': 'low tone', '˩': 'extra-low tone',
    '\u0303': 'nasalized',
    '\u0329': 'syllabic consonant', '\u030D': 'syllabic consonant',
    '\u032F': 'non-syllabic (glide-like)', '\u0311': 'non-syllabic (glide-like)',
    '\u0325': 'voiceless', '\u030A': 'voiceless',
    '\u032C': 'voiced',
    '\u032A': 'dental',
    '\u031A': 'unreleased',
    '\u0306': 'extra-short',
    '\u0308': 'centralized',
    '\u031D': 'raised', '\u031E': 'lowered',
    '\u031F': 'advanced', '\u0320': 'retracted',
    '\u0301': 'high tone', '\u0300': 'low tone', '\u0304': 'mid tone',
    '\u030C': 'rising tone', '\u0302': 'falling tone',
    '\u030B': 'extra-high tone', '\u030F': 'extra-low tone',
    '\u0324': 'breathy voice', '\u0330': 'creaky voice',
    '˞': 'r-colored',
  };

  /* ---------------------------------------------------------------- key parsing */

  function normalize(s) {
    return s.normalize('NFD').replace(TIES, '');
  }

  // Lay a table out as a grid so that rowspan/colspan cells are visible from every row they cover.
  function tableGrid(table) {
    const grid = [];
    const rows = Array.from(table.rows);
    rows.forEach((tr, r) => {
      grid[r] = grid[r] || [];
      let c = 0;
      for (const cell of Array.from(tr.cells)) {
        while (grid[r][c]) c++;
        const rs = Math.min(Math.max(cell.rowSpan || 1, 1), rows.length - r);
        const cs = Math.max(cell.colSpan || 1, 1);
        for (let dr = 0; dr < rs; dr++) {
          grid[r + dr] = grid[r + dr] || [];
          for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = cell;
        }
        c += cs;
      }
    });
    return grid;
  }

  const JUNK = 'style, link, script, sup.reference, .reference, .ext-phonos-attribution, .mw-editsection, .noprint';

  function cleanClone(cell) {
    const clone = cell.cloneNode(true);
    clone.querySelectorAll(JUNK).forEach((n) => n.remove());
    return clone;
  }

  // Reduce a key cell to a tiny, safe rich-text form: [[text, isBold], ...]
  function richText(cell) {
    const clone = cleanClone(cell);
    clone.querySelectorAll('br, li').forEach((n) => n.before(clone.ownerDocument.createTextNode(n.tagName === 'BR' ? ', ' : ' · ')));
    const runs = [];
    (function walk(node, bold) {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const t = child.nodeValue.replace(/\s+/g, ' ');
          if (!t) continue;
          const last = runs[runs.length - 1];
          if (last && last[1] === bold) last[0] += t;
          else runs.push([t, bold]);
        } else if (child.nodeType === 1) {
          walk(child, bold || /^(B|STRONG|U)$/.test(child.tagName));
        }
      }
    })(clone, false);
    if (runs.length) {
      runs[0][0] = runs[0][0].replace(/^[\s·,]+/, '');
      runs[runs.length - 1][0] = runs[runs.length - 1][0].replace(/[\s·,]+$/, '');
    }
    const out = runs.filter((r) => r[0]);
    let budget = 220; // keep tooltips tooltip-sized
    for (let i = 0; i < out.length; i++) {
      if (out[i][0].length > budget) {
        out[i][0] = out[i][0].slice(0, budget).trimEnd() + '…';
        out.length = i + 1;
        break;
      }
      budget -= out[i][0].length;
    }
    return out;
  }

  function headerRole(text) {
    const t = text.trim().toLowerCase();
    if (/^(ipa|symbols?)\b/.test(t)) return 'symbol';
    if (/approximat|equivalent|nearest/.test(t)) return 'approx';
    if (/^examples?\b|^words?\b/.test(t)) return 'example';
    if (/descri|explanation|meaning|^notes?\b/.test(t)) return 'desc';
    return null;
  }

  function symbolsOf(cell) {
    const clone = cleanClone(cell);
    clone.querySelectorAll('.ext-phonos').forEach((n) => n.remove());
    const spans = clone.querySelectorAll('.IPA');
    const texts = spans.length ? Array.from(spans, (s) => s.textContent) : [clone.textContent];
    const out = [];
    for (const t of texts) {
      for (let piece of t.split(/[\s,;~/]+|\bor\b/)) {
        piece = normalize(piece.replace(/[\[\]()⟨⟩◌\u200B-\u200F\u2060]/g, '')).replace(/^-+|-+$/g, '');
        if (piece && piece.length <= 8) out.push(piece);
      }
    }
    return out;
  }

  // Parse a Help:IPA/... page (as a Document) into { symbol: {n, x, a, d, s} }
  //   n = sound name, x = examples, a = English approximation, d = description,
  //   o = other columns as [[header, text]], s = section
  function parseKey(doc) {
    const map = {};
    for (const table of Array.from(doc.querySelectorAll('table.wikitable'))) {
      if (table.querySelector('table')) continue; // layout wrapper; the inner tables are visited on their own
      const grid = tableGrid(table);
      const caption = table.caption ? cleanClone(table.caption).textContent.trim() : '';
      let roles = null;
      let labels = [];
      let section = caption;
      let run = null; // consecutive header rows are read together: "IPA" may sit above per-dialect sub-headers
      const text = (cell) => cleanClone(cell).textContent.replace(/\^\s*top/i, '').replace(/\s+/g, ' ').trim();
      for (const row of grid) {
        if (!row || !row.length) continue;
        const distinct = row.filter((cell, i) => cell && row.indexOf(cell) === i);
        const rowRoles = row.map((cell) => (cell ? headerRole(text(cell)) : null));
        // some keys write their header row as plain bold cells instead of <th>
        const looksLikeHeader = rowRoles.includes('symbol') && rowRoles.every(Boolean) && distinct.every((cell) => text(cell).length < 30);
        if (looksLikeHeader || distinct.every((cell) => cell.tagName === 'TH')) {
          if (!run) run = { roles: [], labels: [] };
          row.forEach((cell, c) => {
            run.roles[c] = run.roles[c] || rowRoles[c];
            if (cell) run.labels[c] = text(cell);
          });
          if (distinct.length === 1 && !rowRoles.includes('symbol')) section = text(distinct[0]) || section;
          continue;
        }
        if (run) {
          if (run.roles.includes('symbol')) { roles = run.roles; labels = run.labels; }
          run = null;
        }
        if (!roles) continue;
        // A table may hold several symbol|example|approximation groups side by side,
        // and one group may have several symbol columns (one per dialect).
        for (let c = 0; c < row.length; c++) {
          if (roles[c] !== 'symbol' || roles[c - 1] === 'symbol') continue;
          let end = c;
          while (roles[end] === 'symbol') end++;
          const symCells = row.slice(c, end).filter((cell, i, all) => cell && all.indexOf(cell) === i);
          const symbols = [].concat(...symCells.map(symbolsOf));
          if (!symbols.length) continue;
          const entry = {};
          for (const cell of symCells) {
            const link = cell.querySelector('.IPA a[title]');
            if (link && !/^(Help|File|Wikipedia):/.test(link.title)) { entry.n = link.title; break; }
          }
          for (let k = end; k < row.length && roles[k] !== 'symbol'; k++) {
            if (!row[k] || row[k] === row[k - 1] || symCells.includes(row[k])) continue;
            const rich = richText(row[k]);
            if (!rich.length) continue;
            const field = { example: 'x', approx: 'a', desc: 'd' }[roles[k]];
            if (field) { if (!entry[field]) entry[field] = rich; }
            else if ((entry.o = entry.o || []).length < 4) entry.o.push([(labels[k] || '').slice(0, 30), rich]);
          }
          if (section && section.length < 40) entry.s = section;
          if (!entry.n && !entry.x && !entry.a && !entry.d && !entry.o) continue;
          for (const sym of symbols) if (!map[sym]) map[sym] = entry;
        }
      }
    }
    // Tones, length and stress are usually listed on a carrier letter ("á", "aː", "ˈa").
    // Make the bare mark findable too so it can be explained on any sound.
    for (const [sym, entry] of Object.entries(map)) {
      if (!/tone|supra|stress|prosod|diacritic|length|marks|other/i.test(entry.s || '')) continue;
      const chars = Array.from(sym);
      if (chars.length < 2) continue;
      const first = chars[0];
      const last = chars[chars.length - 1];
      let bare = null;
      if (/\p{L}/u.test(first) && !/\p{Lm}/u.test(first) && chars.slice(1).every((ch) => /[\p{M}\p{Lm}\p{Sk}]/u.test(ch))) bare = chars.slice(1).join('');
      else if (/[ˈˌꜜꜛ↗↘]/.test(first) && chars.length === 2 && /\p{L}/u.test(last)) bare = first;
      if (bare && !map[bare]) map[bare] = entry;
    }
    return map;
  }

  /* ---------------------------------------------------------------- segmentation */

  // Split a transcription into [{text, entries}] where entries is a list of
  // {sym, info} explanations (empty for brackets, spaces and anything unknown).
  function segment(text, key, generic) {
    const maxLen = Math.min(8, Math.max(1, ...Object.keys(key).map((k) => k.length)));
    const lookup = (sym) => key[sym] || (generic && generic[sym]) || (BUILTIN[sym] ? { d: [[BUILTIN[sym], false]] } : null);
    const chars = Array.from(text);
    const out = [];
    const plain = (t) => {
      const last = out[out.length - 1];
      if (last && !last.entries.length) last.text += t;
      else out.push({ text: t, entries: [] });
    };
    let i = 0;
    while (i < chars.length) {
      let matched = 0;
      let entry = null;
      let sym = '';
      let leftover = [];
      // longest run of characters that the language's own key knows
      for (let len = Math.min(maxLen, chars.length - i); len >= 1; len--) {
        const cand = normalize(chars.slice(i, i + len).join(''));
        if (cand && key[cand]) { matched = len; entry = key[cand]; sym = cand; break; }
        // a diphthong carrying a tone mark (e\u0300\u026A) is still the key's diphthong (e\u026A)
        const bare = cand.replace(/\p{M}/gu, '');
        if (bare !== cand && bare.length > 1 && key[bare]) {
          matched = len; entry = key[bare]; sym = bare;
          leftover = Array.from(cand).filter((ch) => MARK.test(ch));
          break;
        }
      }
      if (!matched) {
        const ch = normalize(chars[i]);
        const base = Array.from(ch)[0] || '';
        if (/[\p{L}\p{M}\p{Lm}\p{Sk}ˈˌː.‿|‖!ǀǁǂǃʘ]/u.test(base) || BUILTIN[base]) {
          matched = 1;
          sym = base;
          entry = lookup(base);
          // precomposed letter (e.g. ã) whose marks were split off by NFD
          leftover = Array.from(ch).slice(1);
        }
      }
      if (!matched) { plain(chars[i]); i++; continue; }
      const entries = [];
      if (entry) entries.push({ sym, info: entry });
      for (const m of leftover) { const e = lookup(m); if (e) entries.push({ sym: '◌' + m, info: e }); }
      let end = i + matched;
      // diacritics and tie bars stay attached to the sound they modify
      while (end < chars.length && (MARK.test(chars[end]) || TIE.test(chars[end]))) {
        const m = normalize(chars[end]);
        if (m) {
          const e = lookup(m);
          if (e) entries.push({ sym: '◌' + m, info: e });
        } else if (end + 1 < chars.length) {
          // tie bar: pull in the second half of the affricate/diphthong
          end++;
          const e = lookup(normalize(chars[end]));
          if (e) entries.push({ sym: normalize(chars[end]), info: e });
        }
        end++;
      }
      const t = chars.slice(i, end).join('');
      if (entries.length) out.push({ text: t, entries });
      else plain(t);
      i = end;
    }
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseKey, segment, normalize };
    return;
  }

  /* ---------------------------------------------------------------- key loading */

  const pending = new Map();

  function readCache(title) {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_PREFIX + title));
      if (raw && Date.now() - raw.t < CACHE_TTL_MS) return raw.map;
    } catch (e) { /* storage unavailable or corrupt */ }
    return null;
  }

  function loadKey(title) {
    if (pending.has(title)) return pending.get(title);
    const cached = readCache(title);
    const promise = cached ? Promise.resolve(cached) : fetch(
      '/w/api.php?action=parse&prop=text&redirects=1&disabletoc=1&disableeditsection=1&format=json&formatversion=2&page=' +
        encodeURIComponent(title),
      { credentials: 'omit' }
    )
      .then((r) => r.json())
      .then((data) => {
        const html = data && data.parse && data.parse.text;
        if (!html) return {};
        const map = parseKey(new DOMParser().parseFromString(html, 'text/html'));
        try { localStorage.setItem(CACHE_PREFIX + title, JSON.stringify({ t: Date.now(), map })); } catch (e) { /* full */ }
        return map;
      })
      .catch(() => { pending.delete(title); return {}; });
    pending.set(title, promise);
    return promise;
  }

  /* ---------------------------------------------------------------- page wiring */

  const LINK_SELECTOR = '.IPA a[href*="/Help:IPA/"], a[href*="/Help:IPA/"] > .IPA';

  function keyTitle(link) {
    try {
      const path = decodeURIComponent(new URL(link.href, location.href).pathname);
      const m = path.match(/\/(Help:IPA\/[^#?]+)$/);
      return m ? m[1].replace(/_/g, ' ') : null;
    } catch (e) { return null; }
  }

  function annotate(link, key, generic) {
    if (link.dataset.ipa4all === 'done') return;
    link.dataset.ipa4all = 'done';
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    let any = false;
    for (const node of textNodes) {
      const parent = node.parentElement;
      if (parent.closest('[title]:not(a), .ipa4all-seg') && parent !== link) continue; // already explained (IPAc-en style)
      const parts = segment(node.nodeValue, key, generic);
      if (!parts.some((p) => p.entries.length)) continue;
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (!part.entries.length) { frag.append(part.text); continue; }
        const span = document.createElement('span');
        span.className = 'ipa4all-seg';
        span.textContent = part.text;
        span._ipa4all = part.entries;
        frag.append(span);
        any = true;
      }
      node.replaceWith(frag);
    }
    if (any) {
      // the native "Help:IPA/French" title tooltip would sit on top of ours
      if (link.title) { link.dataset.ipa4allTitle = link.title; link.removeAttribute('title'); }
    }
  }

  function scan(root) {
    const byKey = new Map();
    for (const el of root.querySelectorAll(LINK_SELECTOR)) {
      const link = el.closest('a');
      if (!link || link.dataset.ipa4all) continue;
      if (link.closest('.IPAc-en, .ipa4all-tip')) continue;
      const title = keyTitle(link);
      if (!title) continue;
      link.dataset.ipa4all = 'pending';
      if (!byKey.has(title)) byKey.set(title, []);
      byKey.get(title).push(link);
    }
    if (!byKey.size) return;
    const run = (title, links) =>
      Promise.all([loadKey(title), loadKey(GENERIC_KEY)]).then(([key, generic]) => {
        links.forEach((l) => annotate(l, key, generic));
      });
    let eager = 0;
    for (const [title, links] of byKey) {
      if (readCache(title) || eager++ < EAGER_KEY_LIMIT) { run(title, links); continue; }
      const onHover = () => {
        links.forEach((l) => l.removeEventListener('mouseenter', onHover));
        run(title, links);
      };
      links.forEach((l) => l.addEventListener('mouseenter', onHover));
    }
  }

  /* ---------------------------------------------------------------- tooltip */

  const style = document.createElement('style');
  style.textContent = `
    .ipa4all-seg { border-bottom: 1px dotted currentColor; cursor: help; }
    .ipa4all-seg:hover { background: var(--background-color-progressive-subtle, #eaf3ff); border-bottom-style: solid; }
    .ipa4all-tip {
      position: absolute; z-index: 1100; max-width: 22em; box-sizing: border-box;
      padding: 8px 10px; border-radius: 4px; font-size: 13px; line-height: 1.45;
      font-family: sans-serif; text-align: left; white-space: normal; pointer-events: none;
      color: var(--color-base, #202122); background: var(--background-color-base, #fff);
      border: 1px solid var(--border-color-base, #a2a9b1); box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .ipa4all-tip .ipa4all-entry + .ipa4all-entry { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border-color-subtle, #c8ccd1); }
    .ipa4all-tip .ipa4all-sym { font-size: 1.5em; line-height: 1.1; margin-right: .4em; font-family: "Charis SIL", "Doulos SIL", "Gentium Plus", "Noto Sans", "DejaVu Sans", sans-serif; }
    .ipa4all-tip .ipa4all-name { color: var(--color-subtle, #54595d); }
    .ipa4all-tip .ipa4all-label { color: var(--color-subtle, #54595d); font-size: .85em; text-transform: uppercase; letter-spacing: .03em; margin-right: .4em; }
    .ipa4all-tip b { color: var(--color-progressive, #36c); }
  `;
  document.head.append(style);

  let tip = null;

  function addRich(parent, runs) {
    for (const [text, bold] of runs) {
      if (bold) { const b = document.createElement('b'); b.textContent = text; parent.append(b); }
      else parent.append(text);
    }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function showTip(seg) {
    hideTip();
    tip = el('div', 'ipa4all-tip');
    tip.setAttribute('role', 'tooltip');
    for (const { sym, info } of seg._ipa4all) {
      const box = el('div', 'ipa4all-entry');
      const head = el('div');
      head.append(el('span', 'ipa4all-sym', sym));
      const name = info.n ? info.n.replace(/\s*\(.*\)$/, '').toLowerCase() : info.s || '';
      if (name) head.append(el('span', 'ipa4all-name', name));
      box.append(head);
      const lines = [['like', info.a], ['e.g.', info.x], ['', info.d]].concat(info.o || []);
      for (const [label, rich] of lines) {
        if (!rich) continue;
        const line = el('div');
        if (label) line.append(el('span', 'ipa4all-label', label));
        addRich(line, rich);
        box.append(line);
      }
      tip.append(box);
    }
    document.body.append(tip);
    const r = seg.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(8, Math.min(left, document.documentElement.clientWidth - t.width - 8));
    let top = r.top - t.height - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = top + window.scrollY + 'px';
  }

  function hideTip() {
    if (tip) { tip.remove(); tip = null; }
  }

  document.addEventListener('mouseover', (e) => {
    const seg = e.target.closest && e.target.closest('.ipa4all-seg');
    if (seg && seg._ipa4all) showTip(seg);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('.ipa4all-seg')) hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });

  scan(document);
  // content swapped in later (live preview, VisualEditor save, etc.)
  if (window.mw && mw.hook) mw.hook('wikipage.content').add(($c) => scan($c && $c[0] ? $c[0] : document));
})();
