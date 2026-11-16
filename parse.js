// A fast Markdown renderer, byte-identical to marked 18.1.3 with its default
// options (GFM on, breaks off). Written from scratch for the make.fun
// "Make Markdown rendering faster" bounty. Public-domain structure: a
// two-phase renderer — block parsing into a small node tree, then inline
// parsing with a delimiter-stack emphasis pass (CommonMark algorithm).

// ---------- small helpers ----------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape &, <, >, ", ' (marked's escape). */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const r = ESC_MAP[s[i]];
    if (r !== undefined) {
      if (i > start) out += s.slice(start, i);
      out += r;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape <, >, ", ' always, and & only when it does not start a
// numeric reference or a &word; sequence (marked's escape with noEncode).
function escNoEncode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      if (entityRefLen(s, i) > 0) continue;
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    } else {
      const r = ESC_MAP[c];
      if (r !== undefined) {
        if (i > start) out += s.slice(start, i);
        out += r;
        start = i + 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}
function isAlphaNum(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
function isAsciiPunct(c) {
  return (
    (c >= '!' && c <= '/') ||
    (c >= ':' && c <= '@') ||
    (c >= '[' && c <= '`') ||
    (c >= '{' && c <= '~')
  );
}
// Unicode punctuation (P*) or symbol (S*) per CommonMark's definition.
const RE_PUNCT = /\p{P}|\p{S}/u;
function isPunct(c) {
  if (c === undefined) return false;
  if (c < '\u0080') return isAsciiPunct(c);
  return RE_PUNCT.test(c);
}
const RE_ALNUM = /\p{L}|\p{N}/u;
function isUnicodeAlnum(c) {
  if (c === undefined) return false;
  if (c < '\u0080') return isAlphaNum(c);
  return RE_ALNUM.test(c);
}
function isWhitespace(c) {
  if (c === undefined) return false;
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' || c === '\u00a0' || c === '\u1680' || (c >= '\u2000' && c <= '\u200a') || c === '\u2028' || c === '\u2029' || c === '\u202f' || c === '\u205f' || c === '\u3000';
}

// Unescape backslash escapes only (for link destinations and titles,
// where marked does NOT decode character references).
function unescapeBackslash(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Entity handling (marked's rule): a numeric reference &#...; / &#x...; is
// decoded (invalid -> U+FFFD, &#38; -> "&amp;"); a named-looking &word;
// (word chars, any length) passes through unchanged; any other & is
// escaped to &amp;.

function isWordChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
}
function isHex(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

// Length of the entity reference starting at s[i] ('&'), or 0 if none.
function entityRefLen(s, i) {
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const start = j;
      while (j < s.length && isHex(s[j]) && j - start < 6) j++;
      return j > start && s[j] === ';' ? j + 1 - i : 0;
    }
    const start = j;
    while (j < s.length && isDigit(s[j]) && j - start < 7) j++;
    return j > start && s[j] === ';' ? j + 1 - i : 0;
  }
  const start = j;
  while (j < s.length && isWordChar(s[j])) j++;
  return j > start && s[j] === ';' ? j + 1 - i : 0;
}

/** If s starts with an entity at position i, return {text, len} to emit, else null. */
function matchEntity(s, i) {
  if (s[i] !== '&') return null;
  const len = entityRefLen(s, i);
  if (len === 0) return null;
  if (s[i + 1] === '#') {
    // numeric reference: decode the value between &# / &#x and ;
    const body = s.slice(i + 2, i + len - 1);
    const hex = body[0] === 'x' || body[0] === 'X';
    const n = hex ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    let text;
    if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) text = '\uFFFD';
    else if (n === 38) text = '&amp;';
    else text = String.fromCodePoint(n);
    return { text, len };
  }
  return { text: s.slice(i, i + len), len };
}

/** Unescape backslash escapes and numeric/named entities in a string (used
 * for link destinations, titles and code-span-adjacent raw text). */

// ---------- URL handling ----------

// marked's cleanUrl (he): encode the href with encodeURI, then restore
// every %25 to % (so %XX sequences and bare % survive). Returns null when
// encodeURI throws (the link is then not formed).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Normalize a link label: collapse whitespace runs to one space, lowercase. */
function normalizeLabel(label) {
  // Unicode case folding: ß/ẞ fold to ss (ẞ lowercases to ß first)
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// ---------- inline parsing ----------

// Node types:
//  {t:'text', s}  {t:'code', s}  {t:'html', s}  {t:'br'}
//  {t:'delim', ch, n, canOpen, canClose}
//  {t:'link', href, title, children, img}
//  {t:'em'|'strong'|'del', children}

function flanking(prev, next) {
  // an absent neighbour (start/end of the inline text) counts as whitespace
  const prevWs = prev === undefined || isWhitespace(prev);
  const nextWs = next === undefined || isWhitespace(next);
  const prevPunct = prev !== undefined && isPunct(prev);
  const nextPunct = next !== undefined && isPunct(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { left, right };
}

function delimCanOpenClose(ch, prev, next) {
  const { left, right } = flanking(prev, next);
  if (ch === '*') return { canOpen: left, canClose: right };
  if (ch === '_') {
    return {
      canOpen: left && (!right || isPunct(prev)),
      canClose: right && (!left || isPunct(next)),
    };
  }
  // '~' strikethrough: same flanking as '*'
  return { canOpen: left, canClose: right };
}

// --- link destination / title parsing ---

// Parse a link destination starting at i (after '(' and skipped ws).
// Returns {href, next} (next = index after the destination) or null.
function parseDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    while (j < s.length && s[j] !== '>' && s[j] !== '\n') {
      if (s[j] === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) j++;
      j++;
    }
    if (j >= s.length || s[j] !== '>') return null;
    return { href: unescapeBackslash(s.slice(i + 1, j)), next: j + 1 };
  }
  // an empty destination is valid: [a]() and [a]( )
  if (s[i] === ')') return { href: '', next: i };
  let j = i;
  let depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return null;
  return { href: unescapeBackslash(s.slice(i, j)), next: j };
}

// Parse a link title starting at i (at ", ', or (). Returns {title, next} or null.
function parseTitle(s, i) {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < s.length && s[j] !== q) {
      if (s[j] === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) j++;
      j++;
    }
    if (j >= s.length) return null;
    return { title: unescapeBackslash(s.slice(i + 1, j)), next: j + 1 };
  }
  if (q === '(') {
    let j = i + 1;
    while (j < s.length && s[j] !== ')') {
      if (s[j] === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) j++;
      j++;
    }
    if (j >= s.length) return null;
    return { title: unescapeBackslash(s.slice(i + 1, j)), next: j + 1 };
  }
  return null;
}

function skipWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Try to parse an inline link starting after the ']' at index closeIdx.
// Returns {href, title, next} (next = index after ')') or null.
function parseInlineLink(s, closeIdx) {
  let i = closeIdx + 1;
  if (s[i] !== '(') return null;
  i++;
  i = skipWs(s, i);
  // a blank line inside the parens is not allowed
  if (s[i] === '\n' && s[i - 1] === '\n') return null;
  const d = parseDest(s, i);
  if (!d) return null;
  i = d.next;
  i = skipWs(s, i);
  let title = null;
  if (s[i] === '"' || s[i] === "'" || s[i] === '(') {
    const t = parseTitle(s, i);
    if (!t) return null;
    title = t.title;
    i = skipWs(s, t.next);
  }
  if (s[i] !== ')') return null;
  return { href: d.href, title, next: i + 1 };
}

// Find the index of the ']' matching the '[' at openIdx, or -1.
// Skips over code spans, escaped characters, and complete raw HTML
// constructs: a ']' inside a tag, comment, CDATA section, processing
// instruction or declaration does not end the link text (cm-524/536).
function findLinkTextEnd(s, openIdx) {
  let depth = 0;
  let i = openIdx + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '<') {
      const tag = matchRawHtml(s, i);
      if (tag) { i = tag.next; continue; }
    }
    if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const n = j - i;
      // find a matching run of exactly n backticks
      let k = j;
      let found = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let m = k;
          while (m < s.length && s[m] === '`') m++;
          if (m - k === n) { found = m; break; }
          k = m;
        } else k++;
      }
      if (found === -1) return -1;
      i = found;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return -1;
}

// Try to parse a link or image starting at i (s[i] is '[' or '!').
// Returns {node, next} or null.
function tryLink(s, i, refs, edgePrev, edgeNext) {
  const img = s[i] === '!';
  const open = img ? i + 1 : i;
  if (s[open] !== '[') return null;
  const close = findLinkTextEnd(s, open);
  if (close === -1) return null;
  const text = s.slice(open + 1, close);
  let href = null;
  let title = null;
  let next = -1;
  const after = s[close + 1];
  if (after === '(') {
    const r = parseInlineLink(s, close);
    if (r) {
      href = r.href;
      title = r.title;
      next = r.next;
    } else {
      // not a valid inline link: fall back to a shortcut reference
      const ref = refs.get(normalizeLabel(text));
      if (!ref || normalizeLabel(text) === '') return null;
      href = ref.href;
      title = ref.title;
      next = close + 1;
    }
  } else if (after === '[') {
    // full or collapsed reference
    let j;
    let label;
    if (s[close + 2] === ']') {
      label = text;
      next = close + 3;
    } else {
      j = close + 2;
      while (j < s.length && s[j] !== ']') {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        j++;
      }
      if (j >= s.length) return null;
      label = s.slice(close + 2, j);
      next = j + 1;
    }
    const ref = refs.get(normalizeLabel(label));
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
  } else {
    // shortcut reference
    const ref = refs.get(normalizeLabel(text));
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
    next = close + 1;
  }
  const clean = cleanUrl(href);
  if (clean === null) return null;
  href = clean;
  if (img) {
    const children = parseInline(text, refs);
    const alt = renderTextContent(children);
    return { node: { t: 'link', href, title, children: [], img: true, alt }, next };
  }
  const children = parseInline(text, refs, s[open - 1], s[close + 1]);
  // a link's text may not contain another link
  if (containsLink(children)) return null;
  return { node: { t: 'link', href, title, children, img: false }, next };
}

// Does this inline node list contain a link (not an image)?
function containsLink(nodes) {
  for (const n of nodes) {
    if (n.t === 'link' && !n.img) return true;
    if ((n.t === 'em' || n.t === 'strong' || n.t === 'del') && containsLink(n.children)) return true;
  }
  return false;
}

// Plain-text content of parsed inline nodes (for image alt text).
function renderTextContent(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.s;
    else if (n.t === 'html') out += n.s;
    else if (n.t === 'br') out += '\n';
    else if (n.t === 'link') {
      // an image node's children are empty; its text is the alt
      if (n.img) out += n.alt ?? '';
      else out += renderTextContent(n.children);
    }
    else if (n.t === 'em' || n.t === 'strong' || n.t === 'del') out += renderTextContent(n.children);
  }
  return out;
}

// --- raw inline HTML ---

// Match raw HTML at position i. Returns {html, next} or null.
function matchRawHtml(s, i) {
  if (s[i] !== '<') return null;
  const c1 = s[i + 1];
  if (c1 === '!') {
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are complete (abruptly closed) comments
      if (s.startsWith('<!-->', i)) return { html: '<!-->', next: i + 5 };
      if (s.startsWith('<!--->', i)) return { html: '<!--->', next: i + 6 };
      const end = s.indexOf('-->', i + 4);
      if (end === -1) return null;
      return { html: s.slice(i, end + 3), next: end + 3 };
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return { html: s.slice(i, end + 3), next: end + 3 };
    }
    // declaration <!A ...>
    if (/[A-Za-z]/.test(s[i + 2] || '')) {
      const end = s.indexOf('>', i + 2);
      if (end === -1) return null;
      return { html: s.slice(i, end + 1), next: end + 1 };
    }
    return null;
  }
  if (c1 === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return { html: s.slice(i, end + 2), next: end + 2 };
  }
  // open or close tag
  let j = i + 1;
  const isClose = s[j] === '/';
  if (isClose) j++;
  if (!/[A-Za-z]/.test(s[j] || '')) return null;
  while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (isClose) {
    // a closing tag takes no attributes: only whitespace, then '>'
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] === '>') return { html: s.slice(i, j + 1), next: j + 1 };
    return null;
  }
  // attributes: each must be preceded by whitespace
  while (j < s.length) {
    const c = s[j];
    if (c === '>') return { html: s.slice(i, j + 1), next: j + 1 };
    if (c === '/' && s[j + 1] === '>') return { html: s.slice(i, j + 2), next: j + 2 };
    if (c !== ' ' && c !== '\t' && c !== '\n') return null;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j >= s.length) return null;
    if (s[j] === '>') return { html: s.slice(i, j + 1), next: j + 1 };
    if (s[j] === '/' && s[j + 1] === '>') return { html: s.slice(i, j + 2), next: j + 2 };
    // attribute name: [A-Za-z_:] then [A-Za-z0-9_.:-]*
    if (!/[A-Za-z_:]/.test(s[j] || '')) return null;
    j++;
    while (j < s.length && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional =value; whitespace may sit around '='. Peek without
    // consuming, so a valueless attribute still leaves its separator
    // for the loop top to see (cm-616: a valueless attribute followed
    // by another attribute must not kill the tag).
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      j = k + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < s.length && s[j] !== q) j++;
        if (j >= s.length) return null;
        j++;
      } else {
        // unquoted value: no space, =, <, >, `, " or '
        let k2 = j;
        while (k2 < s.length && !/[ \t\n=<>"'`]/.test(s[k2])) k2++;
        if (k2 === j) return null;
        j = k2;
      }
    }
  }
  return null;
}

// --- autolinks ---

const RE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;
// <scheme:...> or <email>
function matchAutolink(s, i) {
  if (s[i] !== '<') return null;
  const end = s.indexOf('>', i + 1);
  if (end === -1 || end - i > 300) return null;
  const inner = s.slice(i + 1, end);
  if (/[ \t\n<>]/.test(inner) || inner.length === 0) return null;
  const m = RE_SCHEME.exec(inner);
  if (m) {
    const href = cleanUrl(inner);
    if (href === null) return null;
    return { href, text: inner, next: end + 1 };
  }
  // email
  if (/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(inner)) {
    return { href: 'mailto:' + inner, text: inner, next: end + 1 };
  }
  return null;
}

// GFM extended autolinks: www., http(s)://, bare email.
// Returns {href, text, next} or null. `prev` is the char before the match.
function matchExtendedAutolink(s, i, prev) {
  // must be at a word boundary: start, whitespace, or punctuation (not alnum)
  if (prev !== undefined && (isUnicodeAlnum(prev) || prev === '_' )) return null;
  let m = /^www\.[\w-]+(\.[\w-]+)*(:\d+)?[^\s<]*/.exec(s.slice(i));
  if (m) {
    let url = trimAutolinkEnd(m[0]);
    if (url.length <= 4) return null;
    return { href: 'http://' + url, text: url, next: i + url.length };
  }
  m = /^https?:\/\/[^\s<]+/.exec(s.slice(i));
  if (m) {
    let url = trimAutolinkEnd(m[0]);
    return { href: cleanUrl(url) ?? url, text: url, next: i + url.length };
  }
  // scheme autolink: scheme:email with an optional single path segment
  // (mailto:, xmpp:foo@bar.baz/txt, ...); a second '/' ends the link
  m = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[a-zA-Z0-9._+-][a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(\/[^\s<>\/]+)?/.exec(s.slice(i));
  if (m) {
    let url = trimAutolinkEnd(m[0]);
    const after = s[i + url.length];
    if (after === '-' || after === '_') return null;
    const at = url.indexOf('@');
    if (at > 0 && url.indexOf('.', at) === -1) return null;
    return { href: cleanUrl(url) ?? url, text: url, next: i + url.length };
  }
  m = /^[a-zA-Z0-9._+-][a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/.exec(s.slice(i));
  if (m) {
    let url = trimAutolinkEnd(m[0]);
    // a domain may not end with - or _; such a trailing char voids the link
    const after = s[i + url.length];
    if (after === '-' || after === '_') return null;
    // an email autolink needs a dot in the domain part
    const at = url.indexOf('@');
    if (at > 0 && url.indexOf('.', at) === -1) return null;
    return { href: 'mailto:' + url, text: url, next: i + url.length };
  }
  return null;
}

// Trim trailing punctuation from a GFM autolink per the spec.
function trimAutolinkEnd(url) {
  // balance parens: drop trailing ')' while there are more ) than (
  let opens = 0;
  for (let k = 0; k < url.length; k++) {
    if (url[k] === '(') opens++;
    else if (url[k] === ')') opens--;
  }
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (last === ')' && opens < 0) { url = url.slice(0, -1); opens++; continue; }
    if (last === ';') {
      // a trailing &word; (entity-like) is dropped whole, not kept
      const m = /&[A-Za-z0-9]+;$/.exec(url);
      if (m) { url = url.slice(0, url.length - m[0].length); continue; }
      url = url.slice(0, -1);
      continue;
    }
    if ('?!.,:*_~\'"'.includes(last)) { url = url.slice(0, -1); continue; }
    break;
  }
  return url;
}

// --- emphasis processing (CommonMark delimiter algorithm) ---

function processEmphasis(nodes) {
  // Repeatedly find the first closer that matches an opener, apply, restart.
  for (;;) {
    let applied = false;
    outer: for (let i = 0; i < nodes.length; i++) {
      const closer = nodes[i];
      if (closer.t !== 'delim' || !closer.canClose || closer.n <= 0) continue;
      // find nearest matching opener before i
      for (let j = i - 1; j >= 0; j--) {
        const opener = nodes[j];
        if (opener.t !== 'delim' || !opener.canOpen || opener.n <= 0) continue;
        if (opener.ch !== closer.ch) continue;
        // odd-match rule (emphasis only, not strikethrough): applies when
        // either delimiter can both open and close
        if (
          closer.ch !== '~' &&
          ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) &&
          (opener.n + closer.n) % 3 === 0 &&
          !(opener.n % 3 === 0 && closer.n % 3 === 0)
        ) continue;
        const use = closer.ch === '~' ? (opener.n >= 2 && closer.n >= 2 ? 2 : 1) : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
        const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        opener.n -= use;
        closer.n -= use;
        const children = nodes.slice(j + 1, i);
        const wrap = { t: tag, children };
        const rep = [];
        if (opener.n > 0) rep.push({ t: 'delim', ch: opener.ch, n: opener.n, canOpen: opener.canOpen, canClose: opener.canClose });
        rep.push(wrap);
        if (closer.n > 0) rep.push({ t: 'delim', ch: closer.ch, n: closer.n, canOpen: closer.canOpen, canClose: closer.canClose });
        nodes.splice(j, i - j + 1, ...rep);
        applied = true;
        break outer;
      }
    }
    if (!applied) break;
  }
  // leftover delimiters become literal text (recursive: delims can be
  // trapped inside an already-formed emphasis node's children)
  delimsToText(nodes);
  return nodes;
}

function delimsToText(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.t === 'delim') nodes[i] = { t: 'text', s: n.ch.repeat(n.n) };
    else if (n.t === 'em' || n.t === 'strong' || n.t === 'del' || n.t === 'link') delimsToText(n.children);
  }
}

// --- the inline scanner ---

const SPECIAL = new Set(['\\', '`', '[', '!', '<', '&', '*', '_', '~', '\n']);
const RE_EMAIL_DOMAIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/;
const EMAIL_LOCAL_CH = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

function parseInline(text, refs, edgePrev, edgeNext) {
  const nodes = [];
  let buf = '';
  const flush = () => {
    if (buf) { nodes.push({ t: 'text', s: buf }); buf = ''; }
  };
  const len = text.length;
  let i = 0;
  while (i < len) {
    const c = text[i];
    // GFM extended autolink attempt (www. / http(s):// / bare email).
    // A bare email local part may start with an alnum or . + - _
    if (c === 'w' || c === 'h' || isAlphaNum(c) || c === '.' || c === '+' || c === '-' || c === '_') {
      const prev = i === 0 ? edgePrev : text[i - 1];
      const ext = matchExtendedAutolink(text, i, prev);
      if (ext) {
        flush();
        nodes.push({ t: 'link', href: ext.href, title: null, children: [{ t: 'text', s: ext.text }], img: false, autolink: true });
        i = ext.next;
        continue;
      }
    }
    if (c === '\\') {
      const n = text[i + 1];
      if (n === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        // a hard break strips the next line's leading indent
        while (i < len && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (n !== undefined && isAsciiPunct(n)) { buf += esc(n); i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let j = i;
      while (j < len && text[j] === '`') j++;
      const n = j - i;
      let k = j;
      let found = -1;
      while (k < len) {
        if (text[k] === '`') {
          let m = k;
          while (m < len && text[m] === '`') m++;
          if (m - k === n) { found = m; break; }
          k = m;
        } else k++;
      }
      if (found === -1) { buf += '`'.repeat(n); i = j; continue; }
      let content = text.slice(j, k);
      content = content.replace(/\n/g, ' ');
      if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = found;
      continue;
    }
    if (c === '<') {
      const html = matchRawHtml(text, i);
      if (html) { flush(); nodes.push({ t: 'html', s: html.html }); i = html.next; continue; }
      const auto = matchAutolink(text, i);
      if (auto) {
        flush();
        nodes.push({ t: 'link', href: auto.href, title: null, children: [{ t: 'text', s: auto.text }], img: false, autolink: true });
        i = auto.next;
        continue;
      }
      buf += c; i++; continue;
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const r = tryLink(text, i, refs, edgePrev, edgeNext);
      if (r) { flush(); nodes.push(r.node); i = r.next; continue; }
      buf += c; i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < len && text[j] === c) j++;
      const n = j - i;
      // strikethrough needs 1 or 2 tildes; 3+ is literal text
      if (c === '~' && n > 2) { buf += '~'.repeat(n); i = j; continue; }
      const prev = i === 0 ? edgePrev : text[i - 1];
      const next = j >= len ? edgeNext : text[j];
      const { canOpen, canClose } = delimCanOpenClose(c, prev, next);
      flush();
      nodes.push({ t: 'delim', ch: c, n, canOpen, canClose });
      i = j;
      continue;
    }
    if (c === '&') {
      const e = matchEntity(text, i);
      if (e) { buf += e.text; i += e.len; continue; }
      buf += '&amp;'; i++; continue;
    }
    if (c === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ t: 'br' });
        i++;
        // a hard break strips the next line's leading indent
        while (i < len && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      } else {
        buf += '\n';
      }
      i++;
      continue;
    }
    // plain text run: stop at the next special char, '@', 'www.' or 'http',
    // or at a space (a word boundary lets the loop-top autolink check run
    // on the next word, so a bare email after a failed one is not missed)
    let j = i;
    while (j < len) {
      const ch = text[j];
      if (SPECIAL.has(ch) || ch === '@' || ch === ' ') break;
      if (j > i && ch === 'w' && text.startsWith('www.', j)) break;
      if (j > i && ch === 'h' && (text.startsWith('http://', j) || text.startsWith('https://', j))) break;
      j++;
    }
    if (j === i) j = i + 1; // guarantee progress (autolink start that failed)
    buf += text.slice(i, j);
    i = j;
  }
  flush();
  return processEmphasis(nodes);
}

// marked's URL cleaning (same as cleanUrl; idempotent, so applying it at
// parse time and again at render time is harmless).
function cleanHref(href) {
  return cleanUrl(href);
}

// --- inline rendering ---

function renderInline(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += escNoEncode(n.s);
    else if (n.t === 'code') out += '<code>' + esc(n.s) + '</code>';
    else if (n.t === 'html') out += n.s;
    else if (n.t === 'br') out += '<br>';
    else if (n.t === 'em') out += '<em>' + renderInline(n.children) + '</em>';
    else if (n.t === 'strong') out += '<strong>' + renderInline(n.children) + '</strong>';
    else if (n.t === 'del') out += '<del>' + renderInline(n.children) + '</del>';
    else if (n.t === 'link') {
      const href = cleanHref(n.href);
      if (href === null) {
        if (n.img) out += escNoEncode(n.alt ?? '');
        else out += renderInline(n.children);
        continue;
      }
      if (n.img) {
        out += '<img src="' + escNoEncode(href) + '" alt="' + escNoEncode(n.alt ?? '') + '"' + (n.title != null ? ' title="' + escNoEncode(n.title) + '"' : '') + '>';
      } else {
        out += '<a href="' + escNoEncode(href) + '"' + (n.title != null ? ' title="' + escNoEncode(n.title) + '"' : '') + '>' + renderInline(n.children) + '</a>';
      }
    }
  }
  return out;
}

// Render inline text of a block (already emphasis-processed by parseInline).
function inline(text, refs) {
  return renderInline(parseInline(text, refs));
}

// ---------- block parsing ----------

// A line: { raw, base, indent, rest, blank }.
// `base` is the column where `raw` starts in the original line, so tab
// expansion stays correct after container markers are stripped.
function makeLine(raw, base = 0) {
  let col = base;
  let i = 0;
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) {
    if (raw[i] === ' ') col++;
    else col = (Math.floor(col / 4) + 1) * 4;
    i++;
  }
  const rest = raw.slice(i);
  return { raw, base, indent: col - base, rest, blank: rest === '' };
}

// Slice `raw` starting at absolute column `target` (base <= target).
// A tab straddling the boundary contributes its remaining columns as spaces.
function sliceFromColumn(raw, base, target) {
  let col = base;
  let i = 0;
  let prefix = '';
  while (i < raw.length && col < target) {
    const ch = raw[i];
    if (ch === '\t') {
      const next = (Math.floor(col / 4) + 1) * 4;
      if (next <= target) { col = next; i++; }
      else { prefix = ' '.repeat(next - target); col = target; i++; break; }
    } else if (ch === ' ') { col++; i++; }
    else break;
  }
  return { raw: prefix + raw.slice(i), base: target };
}

// Remove n columns of leading whitespace (caller guarantees indent >= n).
function stripColumns(line, n) {
  const s = sliceFromColumn(line.raw, line.base, line.base + n);
  return makeLine(s.raw, s.base);
}

const RE_ATX = /^(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/;
const RE_HR = /^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$/;
const RE_SETEXT = /^([ \t]{0,3})(=+|-+)[ \t]*$/;
const RE_FENCE = /^(`{3,}|~{3,})(.*)$/;
const RE_BULLET = /^([*+-])([ \t]+(.*))?$/;
const RE_ORDERED = /^(\d{1,9})([.)])([ \t]+(.*))?$/;
const RE_HTML_BLOCK_1 = /^<(pre|script|style|textarea)(\s|>|\/>|$)/i;
const RE_HTML_BLOCK_2 = /^<!--/;
const RE_HTML_BLOCK_3 = /^<\?/;
const RE_HTML_BLOCK_4 = /^<![A-Za-z]/;
const RE_HTML_BLOCK_5 = /^<!\[CDATA\[/;
const RE_HTML_BLOCK_6 = /^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(\s|>|\/>|$)/i;
const RE_HTML_TAG_7 = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|"[^"]*"|'[^']*'))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;
const RE_TABLE_DELIM_CELL = /^:?-+:?$/;

function matchAtx(line) {
  if (line.indent > 3) return null;
  const m = RE_ATX.exec(line.rest);
  if (!m) return null;
  let text = m[2] ?? '';
  text = text.replace(/[ \t]+$/, '');
  text = text.replace(/[ \t]+#+$/, '').replace(/^#+$/, '');
  return { level: m[1].length, text };
}

function isHr(line) {
  if (line.indent > 3) return false;
  return RE_HR.test(line.rest);
}

function matchFence(line) {
  if (line.indent > 3) return null;
  const m = RE_FENCE.exec(line.rest);
  if (!m) return null;
  const ch = m[1][0];
  const info = m[2].trim();
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len: m[1].length, info };
}

function matchSetext(line) {
  if (line.indent > 3) return 0;
  const m = RE_SETEXT.exec(line.rest);
  if (!m) return 0;
  return m[2][0] === '=' ? 1 : 2;
}

function isFenceClose(line, ch, len) {
  if (line.indent > 3) return false;
  const rest = line.rest;
  let i = 0;
  while (i < rest.length && rest[i] === ch) i++;
  if (i < len) return false;
  return /^[ \t]*$/.test(rest.slice(i));
}

// List item start on a line. Returns {ordered, markerLen, num, bullet,
// contentIndent, content} or null. `content` is the line object for the
// item's first content line (or null when the item is empty).
function matchListItem(line) {
  if (line.indent > 3) return null;
  const rest = line.rest;
  let m = RE_BULLET.exec(rest);
  let ordered = false;
  let markerLen;
  let num = 0;
  let delim;
  let after;
  if (m) {
    markerLen = 1;
    delim = m[1];
    after = m[2];
  } else {
    m = RE_ORDERED.exec(rest);
    if (!m) return null;
    ordered = true;
    num = parseInt(m[1], 10);
    markerLen = m[1].length + 1;
    delim = m[2];
    after = m[3];
  }
  if (after === undefined) {
    // marker alone on the line: empty item, content indent marker+1
    return { ordered, markerLen, num, delim, contentIndent: line.indent + markerLen + 1, content: null };
  }
  // The marker starts at this character index in the raw line; scan the
  // whitespace run after it (tracking absolute columns for tabs).
  const markerIdx = line.raw.length - rest.length;
  const markerEnd = markerIdx + markerLen;
  const markerCol = line.base + line.indent + markerLen;
  let col = markerCol;
  let k = markerEnd;
  while (k < line.raw.length && (line.raw[k] === ' ' || line.raw[k] === '\t')) {
    if (line.raw[k] === ' ') col++;
    else col = (Math.floor(col / 4) + 1) * 4;
    k++;
  }
  const spacesAfter = col - markerCol;
  if (k >= line.raw.length) {
    // empty item (marker + only whitespace): content indent is marker+1,
    // not marker + the trailing whitespace run
    return { ordered, markerLen, num, delim, contentIndent: line.indent + markerLen + 1, content: null };
  }
  let contentIndent;
  let content;
  if (spacesAfter >= 5) {
    contentIndent = line.indent + markerLen + 1;
    // remove exactly one column from the start of the whitespace run; a
    // tab there leaves its remaining columns as spaces
    let contentRaw;
    if (line.raw[markerEnd] === '\t') {
      const tabEnd = (Math.floor(markerCol / 4) + 1) * 4;
      contentRaw = ' '.repeat(tabEnd - (markerCol + 1)) + line.raw.slice(markerEnd + 1);
    } else {
      contentRaw = line.raw.slice(markerEnd + 1);
    }
    content = makeLine(contentRaw, line.base + contentIndent);
  } else {
    contentIndent = line.indent + markerLen + spacesAfter;
    content = makeLine(line.raw.slice(k), line.base + contentIndent);
  }
  if (content.blank) content = null;
  return { ordered, markerLen, num, delim, contentIndent, content };
}

// Can this line start a list that interrupts a paragraph?
function listInterrupts(line) {
  const it = matchListItem(line);
  if (!it) return false;
  if (it.content === null) return false;
  if (!it.ordered) return true;
  return it.num === 1;
}

// HTML block start type (1-7) or 0.
function htmlBlockType(line) {
  if (line.indent > 3) return 0;
  const rest = line.rest;
  if (RE_HTML_BLOCK_1.test(rest)) return 1;
  if (RE_HTML_BLOCK_2.test(rest)) return 2;
  if (RE_HTML_BLOCK_3.test(rest)) return 3;
  if (RE_HTML_BLOCK_4.test(rest)) return 4;
  if (RE_HTML_BLOCK_5.test(rest)) return 5;
  if (RE_HTML_BLOCK_6.test(rest)) return 6;
  if (RE_HTML_TAG_7.test(rest)) return 7;
  return 0;
}

function isInterrupt(line) {
  if (line.indent > 3) return false;
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (isHr(line)) return true;
  if (line.rest[0] === '>') return true;
  if (listInterrupts(line)) return true;
  const t = htmlBlockType(line);
  if (t >= 1 && t <= 6) return true;
  return false;
}

// A line that could start a block (used for lazy-continuation decisions).
function isBlockStart(line) {
  return isInterrupt(line) || matchSetext(line) !== 0;
}

// Is a paragraph still open after this content line? An indented-code line
// leaves the state unchanged (it continues a paragraph if one is open, else
// it starts a code block); an interrupting block start closes it; any other
// text line is paragraph content.
function updateLastPara(line, lastPara) {
  if (line.blank) return false;
  if (line.indent >= 4) return lastPara;
  if (isBlockStart(line)) return false;
  return true;
}

// Is the innermost paragraph open after this line, looking through nested
// container markers? `prev` is the innermost paragraph state before this
// line. A '>' line recurses into the quote's content with the same state;
// a list-item line recurses into the item's content with a fresh state
// (a new item starts a fresh paragraph context); an indented-code line
// leaves the state unchanged; any other block start closes it; any other
// text line opens it. (cm-250/251/292/293: a lazy line must continue the
// innermost open paragraph, however deeply nested.)
function openParaAfter(line, prev) {
  if (line.blank) return false;
  if (line.indent <= 3 && line.rest[0] === '>') return openParaAfter(stripQuoteMarker(line), prev);
  const it = matchListItem(line);
  if (it) {
    if (it.content === null) return false;
    return openParaAfter(it.content, false);
  }
  if (line.indent >= 4) return prev;
  if (isBlockStart(line)) return false;
  return true;
}

// End pattern of an HTML block type 1-5 (null for types 6-7, which end
// at a blank line).
function htmlEndRe(ht) {
  if (ht === 1) return /<\/(pre|script|style|textarea)>/i;
  if (ht === 2) return /-->/;
  if (ht === 3) return /\?>/;
  if (ht === 4) return />/;
  if (ht === 5) return /\]\]>/;
  return null;
}

// ---------- link reference definitions ----------

// First ']' ending a link label (no bracket-depth counting: a definition
// label may not contain '['), skipping backslash escapes and code spans.
function findLabelEnd(s, openIdx) {
  let i = openIdx + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const n = j - i;
      let k = j;
      let found = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let m = k;
          while (m < s.length && s[m] === '`') m++;
          if (m - k === n) { found = m; break; }
          k = m;
        } else k++;
      }
      if (found === -1) return -1;
      i = found;
      continue;
    }
    if (c === ']') return i;
    i++;
  }
  return -1;
}

// Try to parse a link reference definition starting at lines[i].
// Returns {next} (index after the definition) or null.
function tryParseDef(lines, i, refs) {
  const n = lines.length;
  const line = lines[i];
  if (line.indent > 3 || line.rest[0] !== '[') return null;
  // join the candidate lines (up to the next blank line) so a title may
  // span lines; positions are indexes into this joined text
  let end = i + 1;
  while (end < n && end < i + 8 && !lines[end].blank) end++;
  const parts = [];
  for (let k = i; k < end; k++) parts.push(lines[k].rest);
  const text = parts.join('\n');
  const close = findLabelEnd(text, 0);
  if (close === -1) return null;
  const label = text.slice(1, close);
  if (label.length === 0 || label.length > 999) return null;
  // a definition label may not contain an unescaped (unbalanced) '['
  if (label.replace(/\\./g, '').includes('[')) return null;
  if (normalizeLabel(label) === '') return null;
  let p = close + 1;
  if (text[p] !== ':') return null;
  p++;
  // skip spaces/tabs, then at most one line break, before the destination
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
  if (text[p] === '\n') {
    p++;
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
  }
  if (p >= text.length) return null;
  // destination (an <...> destination may not span lines)
  let href;
  if (text[p] === '<') {
    let k = p + 1;
    while (k < text.length && text[k] !== '>' && text[k] !== '\n') {
      if (text[k] === '\\' && k + 1 < text.length) k++;
      k++;
    }
    if (k >= text.length || text[k] !== '>') return null;
    href = unescapeBackslash(text.slice(p + 1, k));
    p = k + 1;
  } else {
    let k = p;
    while (k < text.length && text[k] !== ' ' && text[k] !== '\t' && text[k] !== '\n') {
      if (text[k] === '\\' && k + 1 < text.length) k++;
      k++;
    }
    if (k === p) return null;
    href = unescapeBackslash(text.slice(p, k));
    p = k;
  }
  // optional title (may start on the next line and may span lines)
  let title = null;
  const afterDest = p;
  let tp = p;
  let crossedNl = false;
  while (tp < text.length && (text[tp] === ' ' || text[tp] === '\t')) tp++;
  if (text[tp] === '\n') {
    crossedNl = true;
    tp++;
    while (tp < text.length && (text[tp] === ' ' || text[tp] === '\t')) tp++;
  }
  if (tp < text.length) {
    const q = text[tp];
    if (q === '"' || q === "'" || q === '(') {
      if (tp === p) return null; // a title needs whitespace after the dest
      const closeQ = q === '(' ? ')' : q;
      let k = tp + 1;
      let ok = false;
      while (k < text.length) {
        if (text[k] === '\\' && k + 1 < text.length) { k += 2; continue; }
        if (text[k] === closeQ) { ok = true; break; }
        k++;
      }
      if (ok) {
        // only whitespace may follow the title on its line; trailing
        // garbage voids the title (and the definition ends at the dest
        // when the title was on a later line)
        let fp = k + 1;
        while (fp < text.length && (text[fp] === ' ' || text[fp] === '\t')) fp++;
        if (fp >= text.length || text[fp] === '\n') {
          title = unescapeBackslash(text.slice(tp + 1, k));
          p = k + 1;
        } else if (crossedNl) {
          p = afterDest;
        } else {
          return null;
        }
      } else if (crossedNl) {
        p = afterDest; // title on a later line failed: definition ends at dest
      } else {
        return null;
      }
    } else if (crossedNl) {
      p = afterDest; // later line is not a title: definition ends at dest
    } else {
      return null; // trailing garbage on the destination line
    }
  } else {
    p = afterDest;
  }
  // only spaces/tabs may remain up to the end of the definition's line
  let fp = p;
  while (fp < text.length && (text[fp] === ' ' || text[fp] === '\t')) fp++;
  if (fp < text.length && text[fp] !== '\n') return null;
  // lines consumed: line breaks before p, plus one
  let consumed = 1;
  for (let c = 0; c < p; c++) if (text[c] === '\n') consumed++;
  const key = normalizeLabel(label);
  if (!refs.has(key)) refs.set(key, { href, title });
  return { next: i + consumed };
}

// ---------- tables (GFM) ----------

function isTableDelim(line) {
  if (line.indent > 3) return false;
  const cells = line.rest.trim().split('|').map((s) => s.trim());
  // drop empty edge cells from leading/trailing pipes
  let cs = cells;
  if (cs.length && cs[0] === '') cs = cs.slice(1);
  if (cs.length && cs[cs.length - 1] === '') cs = cs.slice(0, -1);
  if (cs.length === 0) return false;
  return cs.every((c) => RE_TABLE_DELIM_CELL.test(c));
}

function tableAligns(line) {
  const cells = line.rest.trim().split('|').map((s) => s.trim());
  let cs = cells;
  if (cs.length && cs[0] === '') cs = cs.slice(1);
  if (cs.length && cs[cs.length - 1] === '') cs = cs.slice(0, -1);
  return cs.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

// Split a table row line into cell texts (unescaped pipes are separators).
function splitRow(line) {
  const s = line.rest;
  let cells = [];
  let cur = '';
  let i = 0;
  // skip leading pipe
  if (s.startsWith('|')) i = 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && (s[i + 1] === '|')) { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  // drop trailing empty cell from a trailing pipe
  if (s.trimEnd().endsWith('|') && cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// ---------- paragraph ----------

function parseParagraph(lines, i, refs) {
  const n = lines.length;
  const textLines = [];
  let j = i;
  while (j < n) {
    const line = lines[j];
    if (line.blank) break;
    if (textLines.length > 0 && !line.lazy) {
      const se = matchSetext(line);
      if (se) {
        // a lazy setext-looking line is paragraph text, not a heading;
        // a real setext heading drops its first line's leading indent
        // and trailing whitespace from its text
        const text = textLines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        return { nodes: [{ t: 'h', level: se, text }], next: j + 1 };
      }
      if (isInterrupt(line)) break;
    }
    // paragraph text keeps the line's leading spaces (marked keeps them);
    // a lazy setext line inside a blockquote is indented by 4 spaces
    // (a link reference definition cannot be a paragraph continuation)
    textLines.push(line.lazySetext ? '    ' + line.raw : line.raw);
    j++;
  }
  if (textLines.length === 0) return { nodes: [], next: j };
  return { nodes: [{ t: 'p', text: textLines.join('\n') }], next: j };
}

// ---------- blockquote ----------

function stripQuoteMarker(line) {
  // line.rest[0] === '>', indent <= 3
  const markerCol = line.base + line.indent;
  let raw2 = line.rest.slice(1);
  let base2 = markerCol + 1;
  if (raw2[0] === ' ') { raw2 = raw2.slice(1); base2++; }
  else if (raw2[0] === '\t') {
    const next = (Math.floor(base2 / 4) + 1) * 4;
    raw2 = ' '.repeat(next - base2 - 1) + raw2.slice(1);
    base2++;
  }
  return makeLine(raw2, base2);
}

function parseBlockquote(lines, i, refs) {
  const n = lines.length;
  const inner = [];
  let j = i;
  let lastPara = false;
  while (j < n) {
    const line = lines[j];
    if (line.indent <= 3 && line.rest[0] === '>') {
      const innerLine = stripQuoteMarker(line);
      if (innerLine.blank && innerLine.raw !== '') {
        // whitespace-only content after '>' + one space: it is a content
        // line (a single space of paragraph text) only when the quote ends
        // here; if a '>' line follows it is a blank separator
        let k = j + 1;
        while (k < n && lines[k].blank) k++;
        const quoteContinues = k < n && lines[k].indent <= 3 && lines[k].rest[0] === '>';
        if (!quoteContinues && lastPara) {
          inner.push({ ...innerLine, blank: false });
          lastPara = true;
        } else {
          inner.push(makeLine(''));
          lastPara = false;
        }
        j++;
        continue;
      }
      inner.push(innerLine);
      lastPara = openParaAfter(innerLine, lastPara);
      j++;
      continue;
    }
    if (line.blank) {
      // a truly blank line (no '>') ends the blockquote; blank lines
      // inside a quote are '>' lines, handled above
      break;
    }
    if (lastPara && !isInterrupt(line)) {
      // lazy continuation: a lazy line's leading indent is stripped by 4
      // when it is 4+ (a setext-looking lazy line is paragraph text,
      // indented by 4 spaces inside a blockquote, never a heading)
      const base = line.indent >= 4 ? stripColumns(line, 4) : line;
      const se = matchSetext(base);
      inner.push(se ? { ...base, lazy: true, lazySetext: true } : { ...base, lazy: true });
      lastPara = true;
      j++;
      continue;
    }
    break;
  }
  return { node: { t: 'quote', children: parseBlocks(inner, refs) }, next: j };
}

// ---------- lists ----------

function parseList(lines, i, refs) {
  const n = lines.length;
  const first = matchListItem(lines[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const start = first.num;
  const items = [];
  let loose = false;
  let j = i;
  while (j < n) {
    const line = lines[j];
    if (line.blank) {
      // blank line: peek for the next item of this list
      let k = j;
      while (k < n && lines[k].blank) k++;
      if (k < n) {
        const it = matchListItem(lines[k]);
        if (it && it.ordered === ordered && it.delim === delim) {
          loose = true;
          j = k;
          continue;
        }
      }
      break;
    }
    // a thematic break ends the list (it is not the next item)
    if (isHr(line)) break;
    const it = matchListItem(line);
    if (!it || it.ordered !== ordered || it.delim !== delim) break;
    // gather this item's content lines
    const content = [];
    const ci = it.contentIndent;
    if (it.content !== null) content.push(it.content);
    j++;
    let itemBlank = false;
    let lastPara = it.content !== null ? openParaAfter(it.content, false) : false;
    // Block state at item level, for looseness: a blank line separates
    // two top-level blocks of the item UNLESS it lies inside a fenced
    // code block, an HTML block (types 1-5), an indented code block, or
    // a nested list (between two items of the same nested list).
    let inFence = null;
    let inHtml = null;
    let prevCode = false;
    let prevBlock = null; // 'para' | 'list' | 'code' | 'fence' | 'html' | 'other'
    let nestedList = null; // {ordered, delim, contentIndent} of the nested list in prevBlock
    const trackFirst = (ln) => {
      const f = matchFence(ln);
      if (f) { inFence = { ch: f.ch, len: f.len }; prevBlock = 'fence'; return; }
      const ht = htmlBlockType(ln);
      if (ht >= 1 && ht <= 5) {
        const er = htmlEndRe(ht);
        if (!er.test(ln.raw)) inHtml = { endRe: er };
        prevBlock = 'html';
        return;
      }
      const li = matchListItem(ln);
      if (li) { prevBlock = 'list'; nestedList = { ordered: li.ordered, delim: li.delim, contentIndent: li.contentIndent }; return; }
      if (ln.indent >= 4) { prevBlock = 'code'; prevCode = true; return; }
      if (isBlockStart(ln)) { prevBlock = 'other'; return; }
      prevBlock = 'para';
    };
    if (it.content !== null) trackFirst(it.content);
    while (j < n) {
      const ln = lines[j];
      if (ln.blank) {
        // an empty item is ended by a blank line (indented content after
        // it is a separate block, not part of the item)
        if (content.length === 0) break;
        // tentatively include; drop later if the item ends here
        content.push(makeLine(''));
        itemBlank = true;
        lastPara = false;
        j++;
        continue;
      }
      if (ln.indent >= ci) {
        const stripped = stripColumns(ln, ci);
        // a blank line between two top-level blocks of the item makes the
        // list loose; a blank nested inside a sub-block does not: inside
        // a fence, an HTML block (types 1-5), an indented code block, or
        // a nested list (a line indented to the nested list's content, or
        // another item of the same nested list)
        if (itemBlank) {
          const li = matchListItem(stripped);
          const codeCont = prevCode && stripped.indent >= 4;
          const listCont = prevBlock === 'list' && nestedList && li &&
            li.ordered === nestedList.ordered && li.delim === nestedList.delim;
          const nestedCont = prevBlock === 'list' && nestedList &&
            stripped.indent >= nestedList.contentIndent;
          if (!inFence && !inHtml && !codeCont && !listCont && !nestedCont) loose = true;
        }
        itemBlank = false;
        // a paragraph continuation of the item's OWN paragraph that is
        // code-indented loses the extra 4 columns (a fresh block keeps
        // them: the code block strips them itself when parsed; a nested
        // list marker keeps them so deeper levels still nest, cm-294).
        // lastPara must be true: after a blank line the paragraph is
        // closed, so a code-indented line is a fresh code block, not a
        // continuation (cm-270/254/273).
        let toPush = stripped;
        if (lastPara && prevBlock === 'para' && stripped.indent >= 4) {
          toPush = stripColumns(stripped, 4);
        }
        content.push(toPush);
        const lastParaBefore = lastPara;
        const fenceBefore = inFence;
        const htmlBefore = inHtml;
        lastPara = openParaAfter(stripped, lastPara);
        // update block state from this line
        if (fenceBefore) {
          if (isFenceClose(stripped, fenceBefore.ch, fenceBefore.len)) inFence = null;
        } else {
          const f = matchFence(stripped);
          if (f) inFence = { ch: f.ch, len: f.len };
        }
        if (htmlBefore) {
          if (htmlBefore.endRe.test(stripped.raw)) inHtml = null;
        } else {
          const ht = htmlBlockType(stripped);
          if (ht >= 1 && ht <= 5) {
            const er = htmlEndRe(ht);
            if (!er.test(stripped.raw)) inHtml = { endRe: er };
          }
        }
        prevCode = !fenceBefore && !htmlBefore && stripped.indent >= 4 && !lastParaBefore;
        const li = !fenceBefore && !htmlBefore ? matchListItem(stripped) : null;
        if (li) {
          prevBlock = 'list';
          nestedList = { ordered: li.ordered, delim: li.delim, contentIndent: li.contentIndent };
        } else if (inFence || fenceBefore) {
          prevBlock = 'fence';
        } else if (inHtml || htmlBefore) {
          prevBlock = 'html';
        } else if (stripped.indent >= 4 && !lastParaBefore) {
          prevBlock = 'code';
        } else if (isBlockStart(stripped)) {
          prevBlock = 'other';
          nestedList = null;
        } else if (lastParaBefore) {
          // paragraph continuation: stays in the current block
        } else {
          prevBlock = 'para';
          nestedList = null;
        }
        j++;
        continue;
      }
      // any list item (same list or a different one) ends this item
      const nit = matchListItem(ln);
      if (nit) {
        // a blank between two items of this list makes it loose; a blank
        // before a different list is trailing whitespace, not looseness
        if (itemBlank && nit.ordered === ordered && nit.delim === delim) loose = true;
        break;
      }
      // lazy continuation of the item's paragraph? (a setext-looking
      // lazy line is paragraph text, never a heading)
      if (lastPara && !isInterrupt(ln)) {
        if (itemBlank) loose = true;
        itemBlank = false;
        const base = ln.indent >= 4 ? stripColumns(ln, 4) : ln;
        content.push({ ...base, lazy: true });
        lastPara = true;
        prevCode = false;
        j++;
        continue;
      }
      break;
    }
    // drop trailing blank lines of the item
    while (content.length && content[content.length - 1].blank) content.pop();
    const children = parseBlocks(content, refs);
    items.push({ children, task: null });
  }
  // task list markers + tight/loose rendering
  for (const item of items) {
    if (item.children.length && item.children[0].t === 'p') {
      const p = item.children[0];
      const m = /^\[([ xX])\](?:[ \t]+(.*)|[ \t]*)$/s.exec(p.text);
      if (m) {
        item.task = m[1] !== ' ';
        p.text = m[2] ?? '';
      }
    }
  }
  return { node: { t: 'list', ordered, start, tight: !loose, items }, next: j };
}

// ---------- main block loop ----------

function parseBlocks(lines, refs) {
  const nodes = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.blank) { i++; continue; }
    // indented code
    if (line.indent >= 4) {
      const buf = [];
      let j = i;
      while (j < n) {
        const ln = lines[j];
        if (ln.blank) {
          // include blank only if a later indented line follows; a blank
          // line keeps its indentation beyond the 4 code columns
          let k = j;
          while (k < n && lines[k].blank) k++;
          if (k < n && lines[k].indent >= 4) {
            while (j < k) { buf.push(' '.repeat(Math.max(0, lines[j].indent - 4))); j++; }
            continue;
          }
          break;
        }
        if (ln.indent >= 4) {
          buf.push(' '.repeat(ln.indent - 4) + ln.rest);
          j++;
          continue;
        }
        break;
      }
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      nodes.push({ t: 'code', lang: null, text: buf.length ? buf.join('\n') + '\n' : '' });
      i = j;
      continue;
    }
    // fenced code
    const fence = matchFence(line);
    if (fence) {
      const buf = [];
      let j = i + 1;
      while (j < n && !isFenceClose(lines[j], fence.ch, fence.len)) {
        // strip up to the fence's own indent from each content line
        buf.push(stripColumns(lines[j], line.indent).raw);
        j++;
      }
      const langRaw = fence.info.split(/[ \t]+/)[0] || null;
      const lang = langRaw ? unescapeBackslash(langRaw) : null;
      // the newline just before the closing fence (or the document end)
      // is a separator, not content: drop exactly one trailing blank
      // line from the fence body (cm-318)
      if (buf.length && buf[buf.length - 1] === '') buf.pop();
      nodes.push({ t: 'code', lang, text: buf.length ? buf.join('\n') + '\n' : '' });
      i = j < n ? j + 1 : j;
      continue;
    }
    // ATX heading
    const atx = matchAtx(line);
    if (atx) {
      nodes.push({ t: 'h', level: atx.level, text: atx.text });
      i++;
      continue;
    }
    // thematic break
    if (isHr(line)) {
      nodes.push({ t: 'hr' });
      i++;
      continue;
    }
    // blockquote
    if (line.indent <= 3 && line.rest[0] === '>') {
      const r = parseBlockquote(lines, i, refs);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // list
    if (matchListItem(line)) {
      const r = parseList(lines, i, refs);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // HTML block
    const ht = htmlBlockType(line);
    if (ht) {
      const buf = [line.raw];
      let j = i + 1;
      const endRe =
        ht === 1 ? /<\/(pre|script|style|textarea)>/i :
        ht === 2 ? /-->/ :
        ht === 3 ? /\?>/ :
        ht === 4 ? />/ :
        ht === 5 ? /\]\]>/ : null;
      if (endRe) {
        if (!endRe.test(line.raw)) {
          while (j < n) {
            buf.push(lines[j].raw);
            if (endRe.test(lines[j].raw)) { j++; break; }
            j++;
          }
        } else {
          j = i + 1;
        }
      } else {
        // types 6 and 7 end at a blank line
        while (j < n && !lines[j].blank) {
          buf.push(lines[j].raw);
          j++;
        }
      }
      const is15 = ht >= 1 && ht <= 5;
      // types 1-5 carry a trailing newline only when the next line is
      // real content (not a blank line); types 6-7 never do here
      const trailingNl = is15 && j < n && !lines[j].blank;
      nodes.push({ t: 'html', text: buf.join('\n') + (trailingNl ? '\n' : ''), endAtDocEnd: j === n });
      i = j;
      continue;
    }
    // table (header and delimiter must have the same cell count)
    if (i + 1 < n && line.rest.includes('|') && isTableDelim(lines[i + 1]) && splitRow(line).length === tableAligns(lines[i + 1]).length) {
      const aligns = tableAligns(lines[i + 1]);
      const header = splitRow(line);
      const rows = [];
      let j = i + 2;
      while (j < n && !lines[j].blank && !isBlockStart(lines[j])) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      nodes.push({ t: 'table', aligns, header, rows });
      i = j;
      continue;
    }
    // link reference definition at block start
    const def = tryParseDef(lines, i, refs);
    if (def) { i = def.next; continue; }
    // paragraph (may become a setext heading)
    const p = parseParagraph(lines, i, refs);
    for (const nd of p.nodes) nodes.push(nd);
    i = p.next;
  }
  return nodes;
}

// ---------- rendering ----------

function renderBlocks(nodes, refs) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, refs);
  return out;
}

function renderBlock(node, refs) {
  switch (node.t) {
    case 'p':
      return '<p>' + inline(node.text, refs) + '</p>\n';
    case 'h':
      return `<h${node.level}>` + inline(node.text, refs) + `</h${node.level}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const cls = node.lang ? ` class="language-${escNoEncode(node.lang)}"` : '';
      return `<pre><code${cls}>` + esc(node.text) + '</code></pre>\n';
    }
    case 'quote':
      return '<blockquote>\n' + renderBlocks(node.children, refs) + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      let out = `<${tag}${start}>\n`;
      for (const item of node.items) {
        const check = item.task === null ? '' :
          item.task ? '<input checked="" disabled="" type="checkbox"> ' :
          '<input disabled="" type="checkbox"> ';
        let inner = '';
        const kids = item.children;
        for (let k = 0; k < kids.length; k++) {
          const kid = kids[k];
          if (kid.t === 'p' && node.tight) {
            // tight: paragraph renders as bare inline content, no newline
            inner += inline(kid.text, refs);
          } else {
            inner += renderBlock(kid, refs);
          }
        }
        out += '<li>' + check + inner + '</li>\n';
      }
      return out + `</${tag}>\n`;
    }
    case 'html':
      return node.text;
    case 'table': {
      const alignAttr = (a) => (a ? ` align="${a}"` : '');
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        out += `<th${alignAttr(node.aligns[c])}>` + inline(node.header[c] ?? '', refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let c = 0; c < node.header.length; c++) {
            out += `<td${alignAttr(node.aligns[c])}>` + inline(row[c] ?? '', refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

// ---------- entry point ----------

export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const refs = new Map();
  const lines = src.split('\n');
  // drop the trailing empty string from a final newline (it is not a line)
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const lineObjs = lines.map((raw) => makeLine(raw));
  const nodes = parseBlocks(lineObjs, refs);
  // an HTML block's text carries a trailing newline only when its last line
  // is the document's last line and the source ends with a newline
  const last = nodes[nodes.length - 1];
  if (last && last.t === 'html' && last.endAtDocEnd && src.endsWith('\n')) last.text += '\n';
  return renderBlocks(nodes, refs);
}
