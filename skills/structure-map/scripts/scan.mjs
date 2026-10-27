#!/usr/bin/env node
// structure-map mechanical scanner.
// Dependency-free (Node >= 18, ESM). Produces deterministic fact files that an LLM
// later annotates in domains.md. Never reads files > 1 MB, reads each file at most once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
export const MAX_BYTES = 1024 * 1024;
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.dart_tool', 'build', 'dist', '.next', '.nuxt', '__pycache__',
  'venv', '.venv', 'vendor', 'Pods', '.gradle', 'coverage', 'out', '.cache', '.claude',
  '.cursor', '.idea', '.build', '.svn', '.output', '.nyc_output', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tox', '.turbo', '.svelte-kit', '.angular', '.expo',
  '.vercel', '.serverless', '.terraform', '.gemini', '.playwright-cli', '.vscode',
  'DerivedData', '.symlinks', 'ephemeral',
]);
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb',
  'bun.lock', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'Gemfile.lock', 'composer.lock',
  'pubspec.lock', 'go.sum', 'uv.lock', 'pdm.lock', 'mix.lock', 'Podfile.lock',
]);
export const WEIGHT_EXT = new Set([
  'pt', 'pth', 'onnx', 'h5', 'hdf5', 'tflite', 'pkl', 'pickle', 'npy', 'npz', 'ckpt',
  'safetensors', 'pb', 'joblib', 'parquet', 'feather', 'tfrecord', 'mlmodel', 'caffemodel',
  'weights', 'gguf',
]);
const BINARY_EXT = new Set([
  ...WEIGHT_EXT, 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp', 'tif', 'tiff', 'heic',
  'avif', 'psd', 'ai', 'sketch', 'fig', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', '7z', 'rar',
  'jar', 'war', 'aar', 'apk', 'aab', 'ipa', 'dmg', 'iso', 'exe', 'dll', 'so', 'dylib', 'a', 'o',
  'obj', 'lib', 'class', 'pyc', 'pyo', 'whl', 'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'wav',
  'ogg', 'flac', 'webm', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'db', 'sqlite', 'sqlite3', 'mdb',
  'glb', 'gltf', 'usdz', 'fbx', 'blend', 'stl', 'ply', 'hdr', 'exr', 'ktx', 'ktx2', 'riv', 'lottie',
  'keystore', 'jks', 'p12', 'mobileprovision', 'tsbuildinfo', 'xcf', 'bin', 'dat', 'wasm', 'map',
]);
const MANIFESTS = ['pubspec.yaml', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Gemfile', 'Cargo.toml'];
const VB_EXT = new Set(['frm', 'bas', 'cls', 'vbp', 'ctl']);
const CODE_EXT = new Set(['frm', 'bas', 'cls', 'ctl', 'dart', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'rb', 'go', 'swift', 'kt', 'java', 'rs', 'php', 'cs']);
const JS_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte']);
const LANG_NAMES = {
  dart: 'Dart', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript',
  tsx: 'TypeScript', py: 'Python', rb: 'Ruby', go: 'Go', swift: 'Swift', kt: 'Kotlin', java: 'Java',
  rs: 'Rust', php: 'PHP', cs: 'C#', vue: 'Vue', svelte: 'Svelte', sql: 'SQL', html: 'HTML', ipynb: 'Jupyter', frm: 'VB6', bas: 'VB6', cls: 'VB6', vbp: 'VB6', ctl: 'VB6',
};
export const GENERATED = ['screens.md', 'api-routes.md', 'db-tables.md', 'services.md', 'tests.md', 'modules.md', 'unresolved.md'];
const FACTS_MARK = '<!-- structure-map:facts hash=';
const BEGIN = '<!-- structure-map:begin -->';
const END = '<!-- structure-map:end -->';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toPosix = (p) => p.split(path.sep).join('/');
const extOf = (rel) => { const b = rel.slice(rel.lastIndexOf('/') + 1); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const dirOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
const pjoin = (...p) => { const s = path.posix.normalize(p.filter((x) => x !== '' && x != null).join('/')); return s === '.' ? '' : s.replace(/^\.\//, ''); };
const uniq = (a) => [...new Set(a)];
const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
export const tokens = (s) => Math.ceil(s.length / 4);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const isIgnoredSeg = (seg) => IGNORE_DIRS.has(seg) || seg.endsWith('.egg-info');
function humanSize(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + u[i];
}
function realish(p) {
  // realpath of the nearest existing ancestor + the rest (macOS /private symlinks)
  const abs = path.resolve(p); let cur = abs; const rest = [];
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) return abs; rest.unshift(path.basename(cur)); cur = parent; }
  return path.join(fs.realpathSync(cur), ...rest);
}

// ---------------------------------------------------------------------------
// gitignore (walk mode only)
// ---------------------------------------------------------------------------
export function compileGitignore(text, base) {
  const rules = [];
  for (let line of text.replace(/\r/g, '').split('\n')) {
    line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    let re = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '*' && line[i + 1] === '*') {
        if (line[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const prefix = base ? base.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '/' : '';
    rules.push({ re: new RegExp('^' + prefix + (anchored ? '' : '(?:.*/)?') + re + '$'), neg, dirOnly });
  }
  return rules;
}
function ignoredBy(rules, rel, isDir) {
  let ig = false;
  for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(rel)) ig = !r.neg;
  return ig;
}
function walk(root) {
  const out = [];
  const rec = (dirRel, rules) => {
    const abs = path.join(root, dirRel);
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    let here = rules;
    if (ents.some((e) => e.name === '.gitignore' && e.isFile())) {
      try { here = rules.concat(compileGitignore(fs.readFileSync(path.join(abs, '.gitignore'), 'utf8'), dirRel)); } catch { /* ignore */ }
    }
    for (const e of ents.sort((a, b) => cmp(a.name, b.name))) {
      const rel = dirRel ? dirRel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (isIgnoredSeg(e.name) || ignoredBy(here, rel, true)) continue;
        rec(rel, here);
      } else if (e.isFile()) {
        if (!ignoredBy(here, rel, false)) out.push(rel);
      }
    }
  };
  rec('', []);
  return out;
}

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------
export function inventory(root, exclude = []) {
  let rels; let mode = 'git';
  try {
    const buf = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    rels = buf.toString('utf8').split('\0').filter(Boolean);
  } catch { mode = 'walk'; rels = walk(root); }
  rels = uniq(rels.map((r) => r.replace(/\\/g, '/')))
    .filter((r) => !r.split('/').slice(0, -1).some(isIgnoredSeg))
    .filter((r) => !exclude.some((x) => r === x || r.startsWith(x + '/')))
    .sort(cmp);
  const all = []; const skipped = { lock: 0, binary: 0, large: 0 };
  for (const rel of rels) {
    let st; try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
    if (!st.isFile()) continue;
    const ext = extOf(rel); const base = baseOf(rel);
    let kind = 'text';
    if (LOCKFILES.has(base) || ext === 'lock') { kind = 'lock'; skipped.lock++; }
    else if (BINARY_EXT.has(ext) || /\.min\.(js|css)$/.test(base)) { kind = 'binary'; skipped.binary++; }
    else if (st.size > MAX_BYTES) { kind = 'large'; skipped.large++; }
    all.push({ rel, size: st.size, ext, kind });
  }
  return { mode, files: all, skipped };
}

// ---------------------------------------------------------------------------
// reader with cache, comment stripping and line lookup
// ---------------------------------------------------------------------------
function commentStyle(ext) {
  if (VB_EXT.has(ext)) return ext === 'vbp' ? 'none' : 'vb';
  if (['py', 'toml', 'yaml', 'yml', 'sh', 'rb'].includes(ext)) return ext === 'py' ? 'py' : 'hash';
  if (ext === 'sql') return 'sql';
  if (['html', 'md', 'json', 'txt', 'ipynb', 'prisma'].includes(ext)) return ext === 'prisma' ? 'c' : 'none';
  return 'c';
}
export function skipString(s, i) {
  const q = s[i]; let j = i + 1; const n = s.length;
  while (j < n) {
    const d = s[j];
    if (d === '\\') { j += 2; continue; }
    if (d === q) return j + 1;
    if (d === '\n' && q !== '`') return j;
    j++;
  }
  return n;
}
export function stripComments(s, style) {
  if (style === 'none') return s;
  let res = ''; let last = 0; let i = 0; const n = s.length;
  const blank = (a, b) => { res += s.slice(last, a) + s.slice(a, b).replace(/[^\n]/g, ' '); last = b; };
  const toEol = (k) => { const j = s.indexOf('\n', k); return j < 0 ? n : j; };
  while (i < n) {
    const c = s[i];
    if ((style === 'c' || style === 'sql') && c === '/' && s[i + 1] === '*') {
      let j = s.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue;
    }
    if (style === 'c' && c === '/' && s[i + 1] === '/' && s[i - 1] !== ':') { const j = toEol(i); blank(i, j); i = j; continue; }
    if (style === 'sql' && c === '-' && s[i + 1] === '-') { const j = toEol(i); blank(i, j); i = j; continue; }
    if (style === 'vb' && c === "'") { const j = toEol(i); blank(i, j); i = j; continue; }
    if (style === 'vb' && c === '"') { let j = i + 1; while (j < n && s[j] !== '"' && s[j] !== '\n') j++; i = j + 1; continue; }
    if ((style === 'py' || style === 'hash') && c === '#') { const j = toEol(i); blank(i, j); i = j; continue; }
    if (c === '"' || c === "'" || (c === '`' && style === 'c')) {
      if (style === 'py' && s.startsWith(c + c + c, i)) { let j = s.indexOf(c + c + c, i + 3); j = j < 0 ? n : j + 3; i = j; continue; }
      if (style === 'hash' && c === "'" && /\w/.test(s[i - 1] || '')) { i++; continue; }
      i = skipString(s, i); continue;
    }
    i++;
  }
  return res + s.slice(last);
}
export function matchClose(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(code, i) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return code.length;
}
function makeFile(rel, text) {
  const ext = extOf(rel);
  let code = null; let starts = null;
  return {
    rel, ext, text,
    get code() { if (code === null) code = stripComments(text, commentStyle(ext)); return code; },
    line(idx) {
      if (!starts) { starts = [0]; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1); }
      let lo = 0; let hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
      return lo + 1;
    },
    snippet(idx) { const a = text.lastIndexOf('\n', idx - 1) + 1; let b = text.indexOf('\n', idx); if (b < 0) b = text.length; return text.slice(a, b).trim().slice(0, 100); },
  };
}
export function makeReader(root, info) {
  const cache = new Map(); const byRel = new Map(info.files.map((f) => [f.rel, f]));
  const warnings = { nonUtf8: 0, nulBytes: 0, minified: 0, readErrors: 0, legacyDecoded: 0 };
  const legacy = (() => { try { return new TextDecoder('windows-1254'); } catch { return new TextDecoder('latin1'); } })();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const read = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const meta = byRel.get(rel); let f = null;
    if (meta && meta.kind === 'text') {
      try {
        const buf = fs.readFileSync(path.join(root, rel));
        if (buf.subarray(0, 8192).includes(0)) warnings.nulBytes++;
        else {
          let t;
          try { t = decoder.decode(buf); } catch (e) { if (!VB_EXT.has(meta.ext)) throw e; t = legacy.decode(buf); warnings.legacyDecoded++; }
          if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
          t = t.replace(/\r\n?/g, '\n');
          if (JS_EXT.has(meta.ext) && /[^\n]{5000}/.test(t)) warnings.minified++;
          else f = makeFile(rel, t);
        }
      } catch (e) { if (e instanceof TypeError) warnings.nonUtf8++; else warnings.readErrors++; }
    }
    cache.set(rel, f);
    return f;
  };
  return { read, warnings };
}

// ---------------------------------------------------------------------------
// sub-projects and stack
// ---------------------------------------------------------------------------
export function detectProjects(info) {
  const dirs = new Set();
  for (const f of info.files) if (MANIFESTS.includes(baseOf(f.rel))) dirs.add(dirOf(f.rel));
  dirs.add('');
  const sorted = [...dirs].sort((a, b) => b.length - a.length || cmp(a, b));
  const projects = new Map([...dirs].map((d) => [d, { dir: d, label: d || '.', files: [] }]));
  for (const f of info.files) {
    const d = sorted.find((p) => p === '' || f.rel.startsWith(p + '/'));
    projects.get(d).files.push(f);
  }
  return [...projects.values()].filter((p) => p.files.length).sort((a, b) => cmp(a.dir, b.dir));
}
const local = (P, rel) => (P.dir ? rel.slice(P.dir.length + 1) : rel);
function parseJsonLoose(t) {
  try { return JSON.parse(t); } catch { /* fall through */ }
  try { return JSON.parse(stripComments(t, 'c').replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}
export function detectStack(P, read) {
  const has = (b) => read(pjoin(P.dir, b));
  const fw = new Set(); const db = new Set(); const tags = new Set();
  const pub = has('pubspec.yaml');
  if (pub) {
    const t = pub.text;
    fw.add(/^\s*flutter\s*:/m.test(t) || /sdk:\s*flutter/.test(t) ? 'Flutter' : 'Dart');
    for (const [k, v] of [['go_router', 'go_router'], ['auto_route', 'auto_route'], ['flutter_riverpod', 'Riverpod'], ['hooks_riverpod', 'Riverpod'], ['flutter_bloc', 'BLoC'], ['provider', 'Provider'], ['firebase_core', 'Firebase']]) if (new RegExp('^\\s+' + k + '\\s*:', 'm').test(t)) tags.add(v);
    for (const [k, v] of [['sqflite', 'sqflite'], ['drift', 'drift'], ['cloud_firestore', 'Firestore'], ['hive', 'Hive'], ['isar', 'Isar']]) if (new RegExp('^\\s+' + k + '\\s*:', 'm').test(t)) db.add(v);
    const m = /^name:\s*([\w]+)/m.exec(t); if (m) P.dartPackage = m[1];
  }
  const pkg = has('package.json');
  if (pkg) {
    const j = parseJsonLoose(pkg.text) || {}; P.pkgJson = j;
    const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.peerDependencies || {}) };
    const map = [['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['react', 'React'], ['vue', 'Vue'], ['@angular/core', 'Angular'], ['svelte', 'Svelte'], ['react-native', 'React Native'], ['expo', 'Expo'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['hono', 'Hono'], ['@nestjs/core', 'NestJS'], ['electron', 'Electron'], ['three', 'three.js']];
    for (const [k, v] of map) if (deps[k]) fw.add(v);
    if (fw.has('Next.js')) fw.delete('React');
    if (fw.has('SvelteKit')) fw.delete('Svelte');
    const dmap = [['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['mongoose', 'MongoDB'], ['mongodb', 'MongoDB'], ['sequelize', 'Sequelize'], ['typeorm', 'TypeORM'], ['knex', 'Knex'], ['pg', 'PostgreSQL'], ['postgres', 'PostgreSQL'], ['mysql2', 'MySQL'], ['mysql', 'MySQL'], ['sqlite3', 'SQLite'], ['better-sqlite3', 'SQLite'], ['@supabase/supabase-js', 'Supabase'], ['firebase', 'Firebase'], ['firebase-admin', 'Firebase']];
    for (const [k, v] of dmap) if (deps[k]) db.add(v);
  }
  const pyText = ['pyproject.toml', 'requirements.txt', 'setup.py'].map((b) => has(b)?.text || '').join('\n').toLowerCase();
  if (pyText) {
    const pm = [['flask', 'Flask'], ['fastapi', 'FastAPI'], ['django', 'Django'], ['streamlit', 'Streamlit'], ['gradio', 'Gradio'], ['torch', 'PyTorch'], ['tensorflow', 'TensorFlow'], ['opencv', 'OpenCV'], ['ultralytics', 'Ultralytics'], ['transformers', 'Transformers'], ['scikit-learn', 'scikit-learn'], ['numpy', 'NumPy'], ['pandas', 'pandas']];
    for (const [k, v] of pm) if (new RegExp('(^|[^\\w-])' + k.replace(/[-]/g, '\\-') + '([^\\w-]|$)', 'm').test(pyText)) fw.add(v);
    for (const [k, v] of [['sqlalchemy', 'SQLAlchemy'], ['peewee', 'Peewee'], ['psycopg', 'PostgreSQL'], ['pymongo', 'MongoDB'], ['alembic', 'Alembic'], ['supabase', 'Supabase']]) if (pyText.includes(k)) db.add(v);
  }
  const gomod = has('go.mod');
  if (gomod) { fw.add('Go'); for (const [k, v] of [['gin-gonic/gin', 'Gin'], ['labstack/echo', 'Echo'], ['go-chi/chi', 'chi'], ['gorilla/mux', 'gorilla/mux'], ['gofiber/fiber', 'Fiber']]) if (gomod.text.includes(k)) fw.add(v); }
  const gem = has('Gemfile');
  if (gem) { if (/gem\s+['"]rails['"]/.test(gem.text)) fw.add('Rails'); else if (/gem\s+['"]sinatra['"]/.test(gem.text)) fw.add('Sinatra'); else fw.add('Ruby'); }
  const cargo = has('Cargo.toml');
  if (cargo) { fw.add('Rust'); for (const k of ['actix-web', 'axum', 'rocket']) if (cargo.text.includes(k)) fw.add(k); }
  if (P.files.some((f) => /(^|\/)manage\.py$/.test(local(P, f.rel)))) fw.add('Django');
  if (P.files.some((f) => f.ext === 'vbp' || f.ext === 'frm')) fw.add('VB6');
  if (P.files.some((f) => f.ext === 'swift' && !/^(ios|macos)\//.test(local(P, f.rel))) && !fw.has('Flutter')) { const sw = P.files.find((f) => f.ext === 'swift' && /\bimport\s+SwiftUI\b/.test(read(f.rel)?.code || '')); if (sw) fw.add('SwiftUI'); }
  if (P.pkgJson) { const dd = { ...(P.pkgJson.dependencies || {}), ...(P.pkgJson.devDependencies || {}) }; if (dd['socket.io'] || dd['@nestjs/websockets']) tags.add('socket.io'); }
  if (P.files.some((f) => /^next\.config\./.test(local(P, f.rel)))) fw.add('Next.js');
  if (!fw.has('Flutter') && P.files.some((f) => /^Package\.swift$|\.xcodeproj\//.test(local(P, f.rel)))) fw.add('Swift/Xcode');
  // import based python detection (files read anyway later)
  const langs = new Map();
  for (const f of P.files) { const n = LANG_NAMES[f.ext]; if (n) langs.set(n, (langs.get(n) || 0) + 1); }
  P.langs = [...langs.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 4).map(([k, v]) => `${k} (${v})`);
  P.fw = fw; P.db = db; P.tags = tags;
}
function addPyImportStack(P, read) {
  const m = [['flask', 'Flask'], ['fastapi', 'FastAPI'], ['django', 'Django'], ['torch', 'PyTorch'], ['cv2', 'OpenCV'], ['tensorflow', 'TensorFlow'], ['ultralytics', 'Ultralytics'], ['streamlit', 'Streamlit'], ['gradio', 'Gradio'], ['sqlalchemy', 'SQLAlchemy']];
  for (const f of P.files) {
    if (f.ext !== 'py') continue; const F = read(f.rel); if (!F) continue;
    for (const [k, v] of m) if (new RegExp('^\\s*(?:from|import)\\s+' + k + '\\b', 'm').test(F.code)) (v === 'SQLAlchemy' ? P.db : P.fw).add(v);
  }
}

// ---------------------------------------------------------------------------
// fact containers
// ---------------------------------------------------------------------------
function newFacts() {
  return { events: [], components: [], screens: [], nav: [], routes: [], tables: [], services: [], tests: [], unresolved: [], entries: [], notebooks: [], dirs: [], data: [], topModules: [], cycles: [] };
}
const loc = (F, idx) => `${F.rel}:${F.line(idx)}`;
function unresolved(X, F, idx, kind, detail) {
  X.unresolved.push({ file: F.rel, line: F.line(idx), kind, snippet: detail || F.snippet(idx) });
}
function strLit(expr) {
  const m = /^\s*r?(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1\s*$/.exec(expr || '');
  return m ? m[2] : null;
}
const isDynamicStr = (s, quoteTemplate) => /\$\{/.test(s) || (quoteTemplate && /\$\w/.test(s));
function joinUrl(a, b) {
  if (b == null) return a;
  const s = ('/' + [a, b].filter((x) => x != null && x !== '').join('/')).replace(/\/{2,}/g, '/');
  return s.length > 1 ? s.replace(/\/$/, '') : s;
}
// ownText: span text with nested child spans blanked (indices preserved)
function ownText(code, a, b, kids) {
  let s = code.slice(a, b + 1);
  for (const k of kids) if (k.a > a && k.b <= b) s = s.slice(0, k.a - a) + ' '.repeat(k.b - k.a + 1) + s.slice(k.b - a + 1);
  return s;
}
function spansFor(code, re) {
  const spans = []; re.lastIndex = 0; let m;
  while ((m = re.exec(code))) { const a = m.index + m[0].length - 1; spans.push({ start: m.index, a, b: matchClose(code, a), m }); }
  for (const s of spans) { let p = null; for (const o of spans) if (o !== s && o.a < s.a && o.b >= s.b && (!p || o.a > p.a)) p = o; s.parent = p; }
  for (const s of spans) s.kids = spans.filter((o) => o.parent === s);
  return spans;
}
// expression value of `key:` at the top level of txt (stops at a top-level comma or closer)
function keyExpr(txt, key) {
  const m = new RegExp('\\b' + key + '\\s*:\\s*').exec(txt); if (!m) return null;
  let depth = 0; let i = m.index + m[0].length; const st = i;
  for (; i < txt.length; i++) {
    const c = txt[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(txt, i) - 1; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if ((c === ',' || c === '\n') && depth === 0) break;
  }
  return txt.slice(st, i).trim();
}
function splitTopArgs(code, a, b) {
  const args = []; let depth = 0; let st = a + 1;
  for (let i = a + 1; i < b; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(code, i) - 1; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { args.push(code.slice(st, i)); st = i + 1; }
  }
  args.push(code.slice(st, b));
  return args.map((x) => x.trim()).filter((x) => x !== '');
}

// ---------------------------------------------------------------------------
// Flutter / Dart
// ---------------------------------------------------------------------------
const WIDGET_BASE = 'StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|StatefulHookConsumerWidget|StatefulHookWidget';
const SCREEN_NAME = /(Screen|Page|View|Sayfasi|Sayfası|Ekrani|Ekranı|Paneli)$/;
const SCREEN_DIR = /(^|\/)(screens?|pages?|views?|sayfalar|ekranlar|presentation)(\/|$)/;
const NON_SCREEN_DIR = /(^|\/)(widgets?|components?|dialogs?|sheets?|parts?|tiles?|cards?)(\/|$)/;
function snake(s) { return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(); }
function extractDart(P, files, X) {
  const consts = new Map(); const widgets = new Map(); const classPos = new Map();
  for (const F of files) {
    const code = F.code; const classes = []; let m;
    const cre = /\b(?:abstract\s+|final\s+|sealed\s+|base\s+)*class\s+(\w+)/g;
    while ((m = cre.exec(code))) classes.push({ name: m[1], idx: m.index });
    classPos.set(F.rel, classes);
    const kre = /\b(static\s+)?const\s+(?:String\s+)?(\w+)\s*=\s*(['"])([^'"\n]*)\3\s*;/g;
    while ((m = kre.exec(code))) {
      const owner = classes.filter((c) => c.idx < m.index).pop();
      const key = m[1] && owner ? owner.name + '.' + m[2] : m[2];
      if (!consts.has(key)) consts.set(key, m[4]);
    }
    const wre = new RegExp('\\bclass\\s+(\\w+)(?:<[^>{]{0,80}>)?\\s+extends\\s+(' + WIDGET_BASE + ')\\b', 'g');
    while ((m = wre.exec(code))) if (!m[1].startsWith('_') && !widgets.has(m[1])) widgets.set(m[1], { file: F.rel, line: F.line(m.index), F });
  }
  const resolve = (expr) => {
    expr = (expr || '').trim(); const lit = strLit(expr);
    if (lit != null) return { value: lit, conf: 'literal' };
    if (/^[\w.]+$/.test(expr) && consts.has(expr)) return { value: consts.get(expr), conf: 'resolved' };
    return null;
  };
  const firstWidget = (txt) => { const re = /(?:\bconst\s+|\bnew\s+)?\b([A-Z]\w*)\s*(?:<[^>()]{0,80}>)?\s*\(/g; let m; while ((m = re.exec(txt))) if (widgets.has(m[1])) return m[1]; return null; };
  const routed = new Map(); // class -> [{path, conf}]
  const addRouted = (cls, p, conf) => { if (!cls) return; if (!routed.has(cls)) routed.set(cls, []); routed.get(cls).push({ path: p, conf }); };
  const enclosing = (F, idx) => { const n = (classPos.get(F.rel) || []).filter((c) => c.idx < idx).pop()?.name; if (!n) return '(top-level)'; const w = /^_(\w+)State$/.exec(n); return w && widgets.has(w[1]) ? w[1] : n; };
  for (const F of files) {
    const code = F.code; let m;
    // GoRoute tree
    if (code.includes('GoRoute')) {
      const spans = spansFor(code, /\bGoRoute\s*\(/g);
      const full = new Map();
      for (const s of spans.sort((x, y) => x.a - y.a)) {
        const own = ownText(code, s.a, s.b, s.kids);
        const pe = keyExpr(own.slice(1), 'path'); const ne = keyExpr(own.slice(1), 'name');
        const pm = pe != null ? [null, pe] : null;
        const r = pm ? resolve(pm[1]) : null; const nmr = ne != null ? resolve(ne) : null;
        const parent = s.parent ? full.get(s.parent) : { value: '', conf: 'literal' };
        let value; let conf;
        if (!r || !parent) { value = pm ? pm[1].trim() : '?'; conf = 'unresolved'; unresolved(X, F, s.start, 'GoRoute path', `path: ${value}`); }
        else { value = r.value.startsWith('/') ? r.value : joinUrl(parent.value, r.value); conf = r.conf === 'resolved' || parent.conf === 'resolved' ? 'resolved' : 'literal'; }
        full.set(s, conf === 'unresolved' ? null : { value, conf });
        const target = firstWidget(own);
        addRouted(target, value, conf);
        X.routes.push({ method: 'PAGE', path: value, handler: target || '', name: nmr ? nmr.value : '', file: F.rel, line: F.line(s.start), conf, kind: 'go_router' });
      }
    }
    // MaterialApp routes map
    const rre = /\broutes\s*:\s*(?:<[^>]{0,80}>\s*)?\{/g;
    while ((m = rre.exec(code))) {
      const a = m.index + m[0].length - 1; const b = matchClose(code, a); const body = code.slice(a, b);
      const ere = /(['"][^'"\n]*['"]|[A-Za-z_][\w.]*)\s*:\s*\(\s*\w*\s*\)\s*(?:=>|\{)/g; let e;
      while ((e = ere.exec(body))) {
        const r = resolve(e[1]); const tail = body.slice(e.index, e.index + 400); const target = firstWidget(tail.slice(e[0].length));
        if (!r) { unresolved(X, F, a + e.index, 'MaterialApp route key', e[1]); continue; }
        addRouted(target, r.value, r.conf);
        X.routes.push({ method: 'PAGE', path: r.value, handler: target || '', name: '', file: F.rel, line: F.line(a + e.index), conf: r.conf, kind: 'MaterialApp.routes' });
      }
    }
    const ogre = /\bonGenerateRoute\s*:/g;
    while ((m = ogre.exec(code))) unresolved(X, F, m.index, 'onGenerateRoute (dynamic routing)');
    // auto_route
    const are = /@RoutePage\s*(?:<[^>]*>)?\s*\([^)]{0,200}\)\s*class\s+(\w+)/g;
    while ((m = are.exec(code))) addRouted(m[1], '(auto_route)', 'literal');
    const aure = /\bAutoRoute\s*\(/g;
    while ((m = aure.exec(code))) {
      const a = m.index + m[0].length - 1; const b = matchClose(code, a); const t = code.slice(a, b);
      const pg = /\bpage\s*:\s*(\w+)Route\.page/.exec(t); const pa = /\bpath\s*:\s*([^,)\n]+)/.exec(t);
      const r = pa ? resolve(pa[1]) : null;
      const cls = pg ? [pg[1] + 'Page', pg[1] + 'Screen', pg[1]].find((c) => widgets.has(c)) || pg[1] : '';
      if (pa && !r) unresolved(X, F, m.index, 'AutoRoute path', pa[1].trim());
      if (r) addRouted(cls, r.value, r.conf);
      X.routes.push({ method: 'PAGE', path: r ? r.value : '(default)', handler: cls, name: '', file: F.rel, line: F.line(m.index), conf: r ? r.conf : 'literal', kind: 'auto_route' });
    }
    // navigation edges
    const nre = /\bNavigator\s*\.\s*(?:(of\s*\([^)]*\)\s*\.\s*)?)(pushNamed|pushReplacementNamed|pushNamedAndRemoveUntil|popAndPushNamed|restorablePushNamed)\s*(?:<[^>]*>)?\s*\(/g;
    while ((m = nre.exec(code))) {
      const a = m.index + m[0].length - 1; const args = splitTopArgs(code, a, matchClose(code, a));
      const expr = m[1] ? args[0] : args[1]; const r = resolve(expr);
      if (!r) unresolved(X, F, m.index, 'Navigator.' + m[2], expr);
      X.nav.push({ from: enclosing(F, m.index), to: r ? r.value : (expr || '?'), file: F.rel, line: F.line(m.index), conf: r ? r.conf : 'unresolved' });
    }
    const gre = /\b(?:context|GoRouter\s*\.\s*of\s*\(\s*context\s*\)|router)\s*\.\s*(go|push|pushReplacement|replace|goNamed|pushNamed|pushReplacementNamed)\s*(?:<[^>]*>)?\s*\(/g;
    while ((m = gre.exec(code))) {
      const a = m.index + m[0].length - 1; const args = splitTopArgs(code, a, matchClose(code, a)); const r = resolve(args[0]);
      if (!r) unresolved(X, F, m.index, 'go_router ' + m[1], args[0]);
      X.nav.push({ from: enclosing(F, m.index), to: r ? r.value : (args[0] || '?'), file: F.rel, line: F.line(m.index), conf: r ? r.conf : 'unresolved' });
    }
    const mre = /\b(?:MaterialPageRoute|CupertinoPageRoute|PageRouteBuilder|MaterialWithModalsPageRoute)\s*(?:<[^>]*>)?\s*\(/g;
    while ((m = mre.exec(code))) {
      const a = m.index + m[0].length - 1; const t = code.slice(a, matchClose(code, a)); const w = firstWidget(t);
      if (!w) {
        const g = /=>\s*(?:const\s+|new\s+)?([A-Z]\w*)\s*(?:<[^>()]{0,80}>)?\s*\(/.exec(t);
        if (g) X.nav.push({ from: enclosing(F, m.index), to: g[1], file: F.rel, line: F.line(m.index), conf: 'literal' });
        else unresolved(X, F, m.index, 'push(PageRoute) target');
        continue;
      }
      X.nav.push({ from: enclosing(F, m.index), to: w, file: F.rel, line: F.line(m.index), conf: 'resolved' });
      addRouted(w, '(push)', 'resolved');
    }
  }
  // screens
  const perFile = new Map();
  for (const [name, w] of widgets) {
    const lp = local(P, w.file);
    if (!lp.startsWith('lib/')) continue;
    const r = routed.get(name);
    const routes = r ? (r.some((x) => x.path !== '(push)') ? uniq(r.map((x) => x.path).filter((p) => p !== '(push)')).sort(cmp) : ['(push)']) : [];
    const isRouted = !!r;
    const byName = SCREEN_NAME.test(name) && !NON_SCREEN_DIR.test(lp);
    const byPath = SCREEN_DIR.test(lp) && !NON_SCREEN_DIR.test(lp) && snake(name) === baseOf(lp).replace(/\.dart$/, '');
    if (!isRouted && !byName && !byPath) continue;
    const conf = r ? (r.some((x) => x.conf === 'resolved') ? 'resolved' : r[0].conf) : 'literal';
    const e = { name, file: w.file, line: w.line, routes, conf, score: isRouted ? 3 : byName ? 2 : 1 };
    if (!perFile.has(w.file)) perFile.set(w.file, []);
    perFile.get(w.file).push(e);
  }
  for (const list of perFile.values()) {
    const routedOnes = list.filter((e) => e.score === 3);
    if (routedOnes.length) X.screens.push(...routedOnes);
    else X.screens.push(list.sort((a, b) => b.score - a.score || cmp(a.name, b.name))[0]);
  }
  // drift tables / sqflite handled in DB extractors
}

// ---------------------------------------------------------------------------
// Web front (path-based + router configs)
// ---------------------------------------------------------------------------
function appRouterUrl(segs) {
  const out = []; let modal = false; let slot = null;
  for (const s of segs) {
    if (/^\(\.{1,3}\)|^\(\.\.\)\(\.\.\)/.test(s)) { modal = true; out.push(s.replace(/^(\((\.{1,3})\))+/, '')); continue; }
    if (/^\(.*\)$/.test(s)) continue;
    if (s.startsWith('@')) { slot = s; continue; }
    out.push(s);
  }
  return { url: '/' + out.filter(Boolean).join('/'), modal, slot };
}
function extractWebPaths(P, X, read) {
  const isNext = P.fw.has('Next.js'); const isSK = P.fw.has('SvelteKit'); const isNuxt = P.fw.has('Nuxt');
  for (const f of P.files) {
    const lp = local(P, f.rel); let m;
    if (isNext && (m = /^(?:src\/)?app\/(.*?)(?:^|\/)?(page|route)\.(tsx|ts|jsx|js|mdx)$/.exec(lp))) {
      const segs = m[1].split('/').filter(Boolean); const u = appRouterUrl(segs);
      const flag = [u.modal ? 'intercepting (modal)' : '', u.slot ? 'parallel slot ' + u.slot : ''].filter(Boolean).join(', ');
      if (m[2] === 'page') X.screens.push({ name: u.url + (flag ? ` [${flag}]` : ''), file: f.rel, line: 1, routes: [u.url], conf: 'resolved', score: 3, kind: 'next-app' });
      else {
        const F = read(f.rel); const methods = [];
        if (F) { const re = /export\s+(?:async\s+)?(?:function|const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g; let e; while ((e = re.exec(F.code))) methods.push(e[1]); const re2 = /export\s*\{([^}]*)\}/g; while ((e = re2.exec(F.code))) for (const n of e[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k)) methods.push(k); } }
        X.routes.push({ method: uniq(methods).sort(cmp).join(',') || '*', path: u.url, handler: 'route handler', file: f.rel, line: 1, conf: 'resolved', kind: 'next-app' });
      }
      continue;
    }
    if ((isNext || isNuxt) && (m = /^(?:src\/)?pages\/(.+)\.(tsx|ts|jsx|js|vue)$/.exec(lp))) {
      if (/(^|\/)_(app|document|error)$|(^|\/)middleware$/.test(m[1])) continue;
      const url = '/' + m[1].replace(/(^|\/)index$/, '').replace(/\/$/, '');
      if (/^api(\/|$)/.test(m[1])) X.routes.push({ method: '*', path: url, handler: 'api handler', file: f.rel, line: 1, conf: 'resolved', kind: 'next-pages' });
      else X.screens.push({ name: url, file: f.rel, line: 1, routes: [url], conf: 'resolved', score: 3, kind: 'pages' });
      continue;
    }
    if (isSK && (m = /^src\/routes\/(.*?)\/?\+(page|server)(?:@\w+)?\.(svelte|ts|js)$/.exec(lp))) {
      const u = appRouterUrl(m[1].split('/').filter(Boolean));
      if (m[2] === 'page') X.screens.push({ name: u.url, file: f.rel, line: 1, routes: [u.url], conf: 'resolved', score: 3, kind: 'sveltekit' });
      else {
        const F = read(f.rel); const methods = []; if (F) { const re = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/g; let e; while ((e = re.exec(F.code))) methods.push(e[1]); }
        X.routes.push({ method: uniq(methods).sort(cmp).join(',') || '*', path: u.url, handler: '+server', file: f.rel, line: 1, conf: 'resolved', kind: 'sveltekit' });
      }
      continue;
    }
    if (f.ext === 'html' && (!lp.includes('/') || /^(public|static)\//.test(lp)) && !/^(coverage|docs?)\//.test(lp)) {
      const F = read(f.rel); const t = F ? /<title[^>]*>([^<]{0,120})<\/title>/i.exec(F.text) : null;
      X.screens.push({ name: (t ? t[1].trim() : '') || baseOf(lp), file: f.rel, line: 1, routes: ['/' + lp.replace(/^(public|static)\//, '')], conf: 'literal', score: 2, kind: 'html' });
    }
  }
}
function extractJsRouterConfigs(F, X) {
  const code = F.code; if (!/react-router|vue-router|@angular\/router|@tanstack\/react-router|createBrowserRouter|<Route\b/.test(code)) return;
  let m;
  const jre = /<Route\b([^>]{0,500}?)\/?>/g;
  while ((m = jre.exec(code))) {
    const attrs = m[1]; const p = /\bpath\s*=\s*(?:\{\s*)?(['"`])([^'"`]*)\1/.exec(attrs);
    const el = /\b(?:element|component|Component)\s*=\s*\{\s*<?\s*([A-Z][\w.]*)/.exec(attrs);
    if (!p && !/\bindex\b/.test(attrs)) { if (/\bpath\s*=/.test(attrs)) unresolved(X, F, m.index, '<Route path>'); continue; }
    X.routes.push({ method: 'PAGE', path: p ? p[2] : '(index)', handler: el ? el[1] : '', file: F.rel, line: F.line(m.index), conf: 'literal', kind: 'react-router' });
  }
  const seen = [];
  const are = /(?:\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|RouterModule\s*\.\s*forRoot|RouterModule\s*\.\s*forChild|provideRouter)\s*\(\s*|\broutes\s*:\s*|\b\w*[Rr]outes\s*(?::\s*[\w.<>[\]]+\s*)?=\s*)\[/g;
  const walkArr = (a, b, prefix) => {
    let i = a + 1;
    while (i < b) {
      const c = code[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(code, i); continue; }
      if (c === '{') {
        const ob = matchClose(code, i); let own = code.slice(i, ob + 1); let k; const kids = [];
        const nre = /[[{(]/g; nre.lastIndex = 1;
        while ((k = nre.exec(own))) { const e2 = matchClose(own, k.index); kids.push([k.index, e2]); nre.lastIndex = e2 + 1; }
        let flat = own; for (const [x, y] of kids) if (own[x] !== '(') flat = flat.slice(0, x) + ' '.repeat(y - x + 1) + flat.slice(y + 1);
        const pm = /\bpath\s*:\s*([^,}\n]+)/.exec(flat);
        let here = prefix;
        if (pm) {
          const lit = strLit(pm[1]);
          const comp = /\b(?:component|element|Component|loadComponent|loadChildren|redirectTo)\s*:\s*(?:\(\s*\)\s*=>\s*import\s*\(\s*['"]([^'"]+)['"]|<\s*([A-Z][\w.]*)|['"]([^'"]*)['"]|([A-Z][\w.]*))/.exec(own);
          if (lit == null || isDynamicStr(lit)) { unresolved(X, F, i, 'route config path', pm[1].trim()); }
          else {
            here = lit.startsWith('/') ? lit : joinUrl(prefix, lit);
            X.routes.push({ method: 'PAGE', path: here || '/', handler: comp ? (comp[1] || comp[2] || (comp[3] != null ? '→ ' + comp[3] : '') || comp[4]) : '', file: F.rel, line: F.line(i), conf: 'literal', kind: 'router-config' });
          }
        }
        const ch = /\bchildren\s*:/.exec(flat);
        if (ch) { let q = ch.index + ch[0].length; while (/\s/.test(own[q] || '')) q++; if (own[q] === '[') { const ca = i + q; walkArr(ca, matchClose(code, ca), here); } }
        i = ob + 1; continue;
      }
      i++;
    }
  };
  while ((m = are.exec(code))) {
    const a = m.index + m[0].length - 1; if (seen.some(([x, y]) => a > x && a < y)) continue;
    const b = matchClose(code, a); seen.push([a, b]); walkArr(a, b, '');
  }
}

// ---------------------------------------------------------------------------
// JS/TS back-end (Express, Fastify, Koa, Hono, NestJS)
// ---------------------------------------------------------------------------
const RECV = /^(app|router|server|fastify|api|r|e|g|routes?|instance|v\d+|admin|\w*[Rr]outer|\w*[Aa]pp|\w*[Ss]erver|\w*[Rr]outes)$/;
const STRICT_RECV = /^(app|router|server|fastify|\w*Router|\w*App)$/;
function jsImports(F) {
  const map = new Map(); const code = F.code; let m;
  const re1 = /\bimport\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+(\w+)\s*)?from\s*(['"])([^'"]+)\4/g;
  while ((m = re1.exec(code))) {
    if (m[1]) map.set(m[1], m[5]); if (m[3]) map.set(m[3], m[5]);
    if (m[2]) for (const n of m[2].split(',')) { const p = n.trim().split(/\s+as\s+/); if (p[0]) map.set((p[1] || p[0]).trim(), m[5]); }
  }
  const re2 = /\b(?:const|let|var)\s+(?:(\w+)|\{([^}]*)\})\s*=\s*require\s*\(\s*(['"])([^'"]+)\3/g;
  while ((m = re2.exec(code))) { if (m[1]) map.set(m[1], m[4]); if (m[2]) for (const n of m[2].split(',')) { const p = n.trim().split(/\s*:\s*/); if (p[0]) map.set((p[1] || p[0]).trim(), m[4]); } }
  return map;
}
function extractJsBackend(F, X, ctx) {
  const code = F.code; let m;
  const re = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|del|options|head|all)\s*\(\s*(?:(['"])((?:(?!\3)[^\\\n]|\\.)*)\3|`([^`]*)`|([^,)\s'"`][^,)]{0,80}))\s*,/g;
  while ((m = re.exec(code))) {
    const recv = m[1]; if (!RECV.test(recv)) continue;
    const pa = code.indexOf('(', m.index + m[1].length); const args = splitTopArgs(code, pa, matchClose(code, pa));
    if (args.length < 2 || (/^[{[]/.test(args[1]) && args.length < 3)) continue; // http client call (url, options), not a route
    const method = m[2] === 'del' ? 'DELETE' : m[2].toUpperCase();
    let p = m[4] != null ? m[4] : m[5]; let conf = 'literal';
    if (m[6] != null || (m[5] != null && isDynamicStr(m[5]))) {
      if ((m[5] != null && m[5].startsWith('/')) || (m[6] != null && STRICT_RECV.test(recv))) unresolved(X, F, m.index, `${recv}.${m[2]} dynamic path`);
      continue;
    }
    if (!(p.startsWith('/') || p === '' || p === '*')) continue;
    ctx.jsRoutes.push({ method, path: p, handler: '', file: F.rel, line: F.line(m.index), conf, kind: 'http', recv });
  }
  const rre = /\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*\{/g;
  while ((m = rre.exec(code))) {
    if (!RECV.test(m[1])) continue;
    const a = m.index + m[0].length - 1; const t = code.slice(a, matchClose(code, a));
    const meth = /\bmethod\s*:\s*(?:(['"])(\w+)\1|\[([^\]]*)\])/.exec(t); const url = /\b(?:url|path)\s*:\s*(['"])([^'"]*)\1/.exec(t);
    if (!url) { unresolved(X, F, m.index, 'route({}) without literal url'); continue; }
    const ms = meth ? (meth[2] || meth[3].replace(/['"\s]/g, '')).toUpperCase() : '*';
    ctx.jsRoutes.push({ method: ms, path: url[2], handler: '', file: F.rel, line: F.line(m.index), conf: 'literal', kind: 'http', recv: m[1] });
  }
  const chre = /\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*(['"])([^'"]*)\2\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete|all)\s*\([^)]{0,200}\))+)/g;
  while ((m = chre.exec(code))) {
    if (!RECV.test(m[1])) continue;
    const ms = [...m[4].matchAll(/(get|post|put|patch|delete|all)/g)].map((x) => x[1].toUpperCase());
    ctx.jsRoutes.push({ method: uniq(ms).join(','), path: m[3], handler: '', file: F.rel, line: F.line(m.index), conf: 'literal', kind: 'http', recv: m[1] });
  }
  // mounts
  const imports = jsImports(F);
  const mre = /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*(?:(['"])([^'"]*)\2|`([^`]*)`|([A-Za-z_$][\w$.]*))\s*,\s*(?:[\w$.]+\s*\([^)]*\)\s*,\s*)*([A-Za-z_$][\w$]*)\s*[,)]/g;
  while ((m = mre.exec(code))) {
    if (!RECV.test(m[1])) continue;
    const prefix = m[3] != null ? m[3] : (m[4] != null && !isDynamicStr(m[4]) ? m[4] : null);
    if (prefix == null) { unresolved(X, F, m.index, 'router mount with dynamic prefix'); continue; }
    ctx.mounts.push({ file: F.rel, prefix, name: m[6], spec: imports.get(m[6]), idx: m.index, F });
  }
  const fre = /\b([A-Za-z_$][\w$]*)\s*\.\s*register\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{([^}]{0,300})\}/g;
  while ((m = fre.exec(code))) {
    const pm = /\bprefix\s*:\s*(?:(['"])([^'"]*)\1|([^,}]+))/.exec(m[3]); if (!pm) continue;
    if (pm[2] == null) { unresolved(X, F, m.index, 'register prefix not literal', pm[3].trim()); continue; }
    ctx.mounts.push({ file: F.rel, prefix: pm[2], name: m[2], spec: imports.get(m[2]), idx: m.index, F });
  }
  // NestJS
  const cm = /@Controller\s*\(\s*(?:(['"])([^'"]*)\1|\{[^}]*path\s*:\s*(['"])([^'"]*)\3[^}]*\})?\s*\)/.exec(code);
  if (cm) {
    const base = cm[2] ?? cm[4] ?? '';
    const dre = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\s*\(\s*(?:(['"])([^'"]*)\2)?\s*\)\s*(?:@[\w.]+\([^)]*\)\s*)*(?:async\s+)?(\w+)/g;
    while ((m = dre.exec(code))) X.routes.push({ method: m[1].toUpperCase(), path: joinUrl(base, m[3] || ''), handler: m[4], file: F.rel, line: F.line(m.index), conf: 'literal', kind: 'nestjs' });
  }
}
function finishJsBackend(X, ctx, resolveSpec) {
  const fileMount = new Map();
  for (const mt of ctx.mounts) {
    const target = mt.spec ? resolveSpec(mt.file, mt.spec) : null;
    if (!target) { if (mt.spec && mt.spec.startsWith('.')) unresolved(X, mt.F, mt.idx, 'router mount target not found', mt.spec); continue; }
    if (!fileMount.has(target)) fileMount.set(target, []);
    fileMount.get(target).push(mt);
  }
  const prefixOf = (file, depth = 0) => {
    const ms = fileMount.get(file); if (!ms || depth > 6) return [''];
    return uniq(ms.flatMap((mt) => prefixOf(mt.file, depth + 1).map((p) => joinUrl(p, mt.prefix)))).sort(cmp);
  };
  for (const r of ctx.jsRoutes) {
    const ps = r.recv && /^app$|^server$|^fastify$/.test(r.recv) && !fileMount.has(r.file) ? [''] : prefixOf(r.file);
    for (const p of ps) X.routes.push({ ...r, path: p ? joinUrl(p, r.path) : r.path, conf: p ? 'resolved' : r.conf });
  }
}

// ---------------------------------------------------------------------------
// Python (Flask, FastAPI, Django)
// ---------------------------------------------------------------------------
function pyModuleIndex(P) {
  const idx = new Map();
  const roots = uniq([P.dir, pjoin(P.dir, 'src')]);
  for (const f of P.files) {
    if (f.ext !== 'py') continue;
    for (const r of roots) {
      if (r && !f.rel.startsWith(r + '/')) continue;
      const lp = r ? f.rel.slice(r.length + 1) : f.rel;
      const mod = lp.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
      if (!idx.has(mod)) idx.set(mod, f.rel);
    }
  }
  return idx;
}
function pyResolve(idx, fromFile, mod) {
  // returns file for module string (relative or absolute)
  const dots = /^\.*/.exec(mod)[0].length;
  if (dots) {
    let base = dirOf(fromFile).split('/').filter(Boolean);
    base = base.slice(0, base.length - (dots - 1));
    const rest = mod.slice(dots);
    const cand = pjoin(base.join('/'), rest.split('.').join('/'));
    for (const c of [cand + '.py', cand + '/__init__.py']) if (idx.byFile.has(c)) return c;
    return null;
  }
  return idx.get(mod) || null;
}
function pyImports(F) {
  const out = []; const code = F.code; let m;
  const re = /^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm;
  while ((m = re.exec(code))) for (const n of m[2].replace(/[()\\]/g, ' ').split(',')) { const p = n.trim().split(/\s+as\s+/); if (p[0] && p[0] !== '*') out.push({ mod: m[1], name: p[0].trim(), alias: (p[1] || p[0]).trim(), idx: m.index }); else if (p[0] === '*') out.push({ mod: m[1], name: '*', alias: '*', idx: m.index }); }
  const re2 = /^[ \t]*import\s+([\w., \t]+)$/gm;
  while ((m = re2.exec(code))) for (const n of m[1].split(',')) { const p = n.trim().split(/\s+as\s+/); if (p[0]) out.push({ mod: p[0].trim(), name: null, alias: (p[1] || p[0].split('.')[0]).trim(), idx: m.index }); }
  return out;
}
function extractPython(P, files, X, idx) {
  for (const F of files) extractHttpServer(F, X);
  const routers = new Map(); // file -> Map(var -> {kind, prefix, conf})
  const routes = []; const regs = [];
  for (const F of files) {
    const code = F.code; let m;
    const isFastapi = /^\s*(?:from|import)\s+fastapi\b/m.test(code); const isFlask = /^\s*(?:from|import)\s+flask\b/m.test(code);
    const vars = new Map(); routers.set(F.rel, vars);
    const bre = /^[ \t]*(\w+)\s*(?::\s*[\w.]+\s*)?=\s*(?:[\w.]*\.)?(Blueprint|APIRouter|FastAPI|Flask|Quart|Sanic)\s*\(/gm;
    while ((m = bre.exec(code))) {
      const a = m.index + m[0].length - 1; const t = code.slice(a, matchClose(code, a));
      const pm = /\b(?:url_prefix|prefix|root_path)\s*=\s*([^,)\n]+)/.exec(t); let prefix = ''; let conf = 'literal';
      if (pm && m[2] !== 'FastAPI') { const l = strLit(pm[1]); if (l == null || isDynamicStr(l)) { conf = 'unresolved'; unresolved(X, F, m.index, m[2] + ' prefix not literal', pm[1].trim()); } else prefix = l; }
      vars.set(m[1], { kind: m[2], prefix, conf, app: /FastAPI|Flask|Quart|Sanic/.test(m[2]) });
    }
    const dre = /@(\w+)\.(route|get|post|put|patch|delete|head|options|api_route|websocket)\s*\(/g;
    while ((m = dre.exec(code))) {
      const a = m.index + m[0].length - 1; const b = matchClose(code, a); const args = splitTopArgs(code, a, b);
      const lit = strLit(args[0] || '');
      const fn = /\b(?:async\s+)?def\s+(\w+)/.exec(code.slice(b, b + 400));
      if (lit == null || isDynamicStr(lit)) { if (args[0] && !/^\w+\s*=/.test(args[0])) unresolved(X, F, m.index, `@${m[1]}.${m[2]} dynamic path`, args[0]); continue; }
      let method = m[2].toUpperCase();
      if (m[2] === 'route' || m[2] === 'api_route') { const mm = /\bmethods\s*=\s*[[(]([^\])]*)[\])]/.exec(code.slice(a, b)); method = mm ? mm[1].replace(/['"\s]/g, '').toUpperCase() : (m[2] === 'route' ? 'GET' : '*'); }
      if (m[2] === 'websocket') method = 'WS';
      routes.push({ F, idx: m.index, var: m[1], path: lit, method, handler: fn ? fn[1] : '', fw: isFastapi ? 'fastapi' : isFlask ? 'flask' : 'python' });
    }
    const rre = /\b(\w+)\s*\.\s*(register_blueprint|include_router)\s*\(/g;
    while ((m = rre.exec(code))) {
      const a = m.index + m[0].length - 1; const args = splitTopArgs(code, a, matchClose(code, a)); if (!args.length) continue;
      const pa = args.find((x) => /^(url_prefix|prefix)\s*=/.test(x)); let prefix = null; let conf = 'literal';
      if (pa) { const l = strLit(pa.replace(/^\w+\s*=\s*/, '')); if (l == null || isDynamicStr(l)) { conf = 'unresolved'; unresolved(X, F, m.index, m[2] + ' prefix not literal', pa); } else prefix = l; }
      regs.push({ F, idx: m.index, parent: m[1], child: args[0], prefix, conf, kind: m[2] });
    }
  }
  // resolve registrations: child expr -> (file, var)
  const imps = new Map();
  const getImps = (F) => { if (!imps.has(F.rel)) imps.set(F.rel, pyImports(F)); return imps.get(F.rel); };
  const resolveName = (F, expr) => {
    expr = expr.trim();
    if (/^\w+$/.test(expr)) {
      if (routers.get(F.rel)?.has(expr)) return { file: F.rel, v: expr };
      const im = getImps(F).find((x) => x.alias === expr && x.name);
      if (im) { const f = pyResolve(idx, F.rel, im.mod); if (f) return { file: f, v: im.name }; const f2 = pyResolve(idx, F.rel, im.mod + (im.mod.endsWith('.') ? '' : '.') + im.name); if (f2) return { file: f2, v: 'router' }; }
      return null;
    }
    const mm = /^(\w+)\.(\w+)$/.exec(expr); if (!mm) return null;
    const im = getImps(F).find((x) => x.alias === mm[1]);
    if (!im) return null;
    const mod = im.name ? im.mod + (im.mod.endsWith('.') ? '' : '.') + im.name : im.mod;
    const f = pyResolve(idx, F.rel, mod); return f ? { file: f, v: mm[2] } : null;
  };
  const mountOf = new Map();
  for (const r of regs) {
    const t = resolveName(r.F, r.child);
    if (!t) { unresolved(X, r.F, r.idx, r.kind + ' target not resolved', r.child); continue; }
    const parent = resolveName(r.F, r.parent) || { file: r.F.rel, v: r.parent };
    mountOf.set(t.file + '#' + t.v, { ...r, parentKey: parent.file + '#' + parent.v });
  }
  const prefixFor = (key, depth = 0) => {
    const [file, v] = key.split('#'); const info = routers.get(file)?.get(v);
    if (depth > 6) return { p: '', conf: 'unresolved' };
    const mt = mountOf.get(key);
    const own = info ? info.prefix : '';
    if (!mt) return { p: own, conf: info?.conf === 'unresolved' ? 'unresolved' : 'literal', mounted: !!(info && info.app) };
    if (mt.conf === 'unresolved') return { p: own, conf: 'unresolved' };
    const up = prefixFor(mt.parentKey, depth + 1);
    const flask = mt.kind === 'register_blueprint';
    const mid = flask ? (mt.prefix != null ? mt.prefix : own) : joinUrl(mt.prefix || '', own);
    return { p: joinUrl(up.p, mid), conf: up.conf === 'unresolved' ? 'unresolved' : 'resolved', mounted: true };
  };
  for (const r of routes) {
    const pf = prefixFor(r.F.rel + '#' + r.var);
    X.routes.push({ method: r.method, path: joinUrl(pf.p, r.path), handler: r.handler, file: r.F.rel, line: r.F.line(r.idx), conf: pf.conf === 'unresolved' ? 'unresolved' : pf.p && pf.conf === 'resolved' ? 'resolved' : 'literal', kind: r.fw });
  }
  // Django
  const urlFiles = files.filter((F) => /\burlpatterns\s*\+?=/.test(F.code));
  if (urlFiles.length) {
    const parsed = new Map(); const included = new Set();
    for (const F of urlFiles) {
      const list = []; const code = F.code; let m;
      const re = /\b(path|re_path|url)\s*\(/g;
      while ((m = re.exec(code))) {
        const a = m.index + m[0].length - 1; const args = splitTopArgs(code, a, matchClose(code, a)); if (args.length < 2) continue;
        let p = strLit(args[0]); if (p == null) { unresolved(X, F, m.index, 'django ' + m[1] + ' non-literal'); continue; }
        if (m[1] !== 'path') p = p.replace(/^\^/, '').replace(/\$$/, '');
        const inc = /^include\s*\(\s*(?:\(\s*)?(['"])([\w.]+)\1/.exec(args[1]);
        if (inc) { const t = pyResolve(idx, F.rel, inc[2]); if (t) { included.add(t); list.push({ p, include: t, idx: m.index }); } else unresolved(X, F, m.index, 'django include not found', inc[2]); continue; }
        if (/^include\s*\(/.test(args[1])) { unresolved(X, F, m.index, 'django include (dynamic)', args[1].slice(0, 80)); continue; }
        const nm = args.find((x) => /^name\s*=/.test(x));
        list.push({ p, view: args[1].replace(/\s+/g, '').slice(0, 60), name: nm ? strLit(nm.replace(/^name\s*=\s*/, '')) || '' : '', idx: m.index });
      }
      parsed.set(F.rel, { F, list });
    }
    const emit = (file, prefix, depth, conf) => {
      const e = parsed.get(file); if (!e || depth > 8) return;
      for (const it of e.list) {
        if (it.include) emit(it.include, prefix + it.p, depth + 1, 'resolved');
        else X.routes.push({ method: '*', path: '/' + (prefix + it.p), handler: it.view, name: it.name, file, line: e.F.line(it.idx), conf, kind: 'django' });
      }
    };
    for (const f of [...parsed.keys()].sort(cmp)) if (!included.has(f)) emit(f, '', 0, 'literal');
  }
}

// ---------------------------------------------------------------------------
// Ruby (Rails) and Go
// ---------------------------------------------------------------------------
function extractRails(F, X) {
  const stack = []; const lines = F.code.split('\n');
  lines.forEach((ln, i) => {
    const s = ln.trim(); let m;
    const pre = () => stack.filter(Boolean).join('/');
    if ((m = /^(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"](.*)$/.exec(s))) {
      const to = /(?:to:\s*|=>\s*)['"]([^'"]+)['"]/.exec(m[3]);
      X.routes.push({ method: m[1] === 'match' ? '*' : m[1].toUpperCase(), path: joinUrl(pre(), m[2]), handler: to ? to[1] : '', file: F.rel, line: i + 1, conf: 'literal', kind: 'rails' });
    } else if ((m = /^root\s+(?:to:\s*)?['"]([^'"]+)['"]/.exec(s))) {
      X.routes.push({ method: 'GET', path: joinUrl(pre(), ''), handler: m[1], file: F.rel, line: i + 1, conf: 'literal', kind: 'rails' });
    } else if ((m = /^(resources?)\s+:(\w+)/.exec(s))) {
      X.routes.push({ method: 'REST', path: joinUrl(pre(), m[2]), handler: m[1] + ' :' + m[2], file: F.rel, line: i + 1, conf: 'literal', kind: 'rails' });
    }
    if (/\bdo(\s*\|[^|]*\|)?\s*$/.test(s)) {
      let seg = '';
      if ((m = /^namespace\s+:(\w+)/.exec(s))) seg = m[1];
      else if ((m = /^scope\s+(?:path:\s*)?['"]\/?([^'"]*)['"]/.exec(s))) seg = m[1];
      else if ((m = /^resources?\s+:(\w+)/.exec(s))) seg = /^resources\s/.test(s) ? `${m[1]}/:${m[1].replace(/s$/, '')}_id` : m[1];
      stack.push(seg);
    } else if (/^end\b/.test(s)) stack.pop();
  });
}
const GO_VERBS = 'HandleFunc|Handle|MethodFunc|Method|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options|Connect|Trace';
const GO_WITH = '(?:With\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.\\s*)?';
function extractGo(F, X) {
  const code = F.code; let m; const groups = new Map();
  const gre = /\b(\w+)\s*:?=\s*(\w+)\.Group\s*\(\s*"([^"]*)"/g;
  while ((m = gre.exec(code))) groups.set(m[1], { parent: m[2], p: m[3] });
  const gpref = (v, d = 0) => { const g = groups.get(v); return g && d < 6 ? joinUrl(gpref(g.parent, d + 1), g.p) : ''; };
  // chi scopes: Route("/p", func(r chi.Router) {...}) and Group(func(r chi.Router) {...}); inner r shadows outer r
  const scopes = []; const fnBodies = []; const mountPrefix = new Map();
  const fre = /\bfunc\s+(\w+)\s*\([^)]*\)[^{\n]*\{/g;
  while ((m = fre.exec(code))) { const a = m.index + m[0].length - 1; fnBodies.push({ name: m[1], a, b: matchClose(code, a) }); }
  const prefixAt = (recv, pos) => {
    let best = null; for (const sc of scopes) if (sc.v === recv && sc.a < pos && sc.b > pos && (!best || sc.a > best.a)) best = sc;
    if (best) return { p: best.full, conf: best.conf };
    if (groups.has(recv)) return { p: gpref(recv), conf: 'resolved' };
    const fn = fnBodies.filter((f) => f.a < pos && f.b > pos && mountPrefix.has(f.name)).pop();
    if (fn) return { p: mountPrefix.get(fn.name), conf: 'resolved' };
    return { p: '', conf: 'literal' };
  };
  const sre = new RegExp('\\b(\\w+)\\s*\\.\\s*' + GO_WITH + '(Route|Group)\\s*\\(\\s*(?:(?:"([^"]*)"|([^,()]+?))\\s*,\\s*)?func\\s*\\(\\s*(\\w+)\\s+[\\w.*]*Router\\s*\\)\\s*\\{', 'g');
  while ((m = sre.exec(code))) {
    if (m[2] === 'Route' && m[3] == null && m[4] == null) continue;
    const a = m.index + m[0].length - 1; const up = prefixAt(m[1], m.index);
    let full = up.p; let conf = up.conf === 'literal' && m[2] === 'Route' ? 'resolved' : up.conf;
    if (m[2] === 'Route') { if (m[3] != null) full = joinUrl(up.p, m[3]); else { unresolved(X, F, m.index, 'chi Route dynamic prefix', m[4].trim()); full = joinUrl(up.p, '{?}'); conf = 'unresolved'; } }
    scopes.push({ v: m[5], a, b: matchClose(code, a), full, conf });
  }
  const mre = new RegExp('\\b(\\w+)\\s*\\.\\s*' + GO_WITH + 'Mount\\s*\\(\\s*(?:"([^"]*)"|([^,]+?))\\s*,\\s*([^\\n]*?)\\)\\s*$', 'gm');
  while ((m = mre.exec(code))) {
    const up = prefixAt(m[1], m.index);
    if (m[2] == null) { unresolved(X, F, m.index, 'chi Mount dynamic prefix', m[3].trim()); continue; }
    const full = joinUrl(up.p, m[2]); const target = m[4].trim(); const fn = /^(\w+)\s*\(\s*\)$/.exec(target);
    if (fn && fnBodies.some((f) => f.name === fn[1])) mountPrefix.set(fn[1], full);
    else unresolved(X, F, m.index, 'chi Mount target not resolved in file', target);
    X.routes.push({ method: 'MOUNT', path: full, handler: target, file: F.rel, line: F.line(m.index), conf: up.conf === 'unresolved' ? 'unresolved' : 'literal', kind: 'go' });
  }
  const re = new RegExp('\\b(\\w+)\\s*\\.\\s*' + GO_WITH + '(' + GO_VERBS + ')\\s*\\(', 'g');
  while ((m = re.exec(code))) {
    const a = m.index + m[0].length - 1; const args = splitTopArgs(code, a, matchClose(code, a));
    let method = /^Handle/.test(m[2]) ? '*' : m[2].toUpperCase(); let pArg = args[0];
    if (/^Method/.test(m[2])) { const mm = strLit(args[0] || ''); method = mm ? mm.toUpperCase() : '?'; pArg = args[1]; }
    if (args.length < 2 || pArg == null) continue;
    let p = strLit(pArg);
    if (p == null) { if (/^(http|mux|r|router|e|g|app|api)$/.test(m[1]) || groups.has(m[1]) || scopes.some((sc) => sc.v === m[1])) unresolved(X, F, m.index, `${m[1]}.${m[2]} dynamic path`, pArg); continue; }
    const mm = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/.exec(p); if (mm) { method = mm[1]; p = mm[2]; }
    if (!p.startsWith('/')) continue;
    const up = prefixAt(m[1], m.index);
    X.routes.push({ method, path: up.p ? joinUrl(up.p, p) + (p.endsWith('/') && p !== '/' ? '/' : '') : p, handler: '', file: F.rel, line: F.line(m.index), conf: up.p ? up.conf : 'literal', kind: 'go' });
  }
}

// ---------------------------------------------------------------------------
// SwiftUI
// ---------------------------------------------------------------------------
function depth0Views(txt, views) {
  const out = []; let depth = 0;
  for (let i = 1; i < txt.length - 1; i++) {
    const c = txt[i];
    if (c === '"') { i = skipString(txt, i) - 1; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && /[A-Z]/.test(c) && !/\w/.test(txt[i - 1])) { const m = /^([A-Z]\w*)\s*\(/.exec(txt.slice(i, i + 80)); if (m && views.has(m[1])) out.push(m[1]); }
  }
  return uniq(out);
}
function extractSwift(P, files, X) {
  const views = new Map(); const structsBy = new Map();
  for (const F of files) {
    const re = /\bstruct\s+(\w+)\s*(?:<[^>{]*>)?\s*:\s*([^{]+)\{/g; let m; const list = [];
    while ((m = re.exec(F.code))) { list.push({ name: m[1], idx: m.index }); if (m[2].split(',').map((x) => x.trim()).some((c) => c === 'View' || c === 'SwiftUI.View')) views.set(m[1], { F, idx: m.index }); }
    structsBy.set(F.rel, list);
  }
  if (!views.size) return;
  const refs = new Map(); const navRoots = new Set();
  const encl = (F, idx) => (structsBy.get(F.rel) || []).filter((c) => c.idx < idx).pop()?.name || '(top-level)';
  const ref = (name, how, F, idx) => { if (!views.has(name)) return; if (!refs.has(name)) refs.set(name, new Set()); refs.get(name).add(how); X.nav.push({ from: encl(F, idx), to: `${name} (${how})`, file: F.rel, line: F.line(idx), conf: 'literal' }); };
  const firstView = (txt) => { const re = /\b([A-Z]\w*)\s*\(/g; let m; while ((m = re.exec(txt))) if (views.has(m[1])) return m[1]; return null; };
  for (const F of files) {
    const code = F.code; let m;
    const am = /@main\s+struct\s+(\w+)\s*:\s*[^{]*\bApp\b/.exec(code);
    if (am) X.entries.push({ entry: am[1], kind: 'SwiftUI @main App', src: F.rel });
    const blocks = [
      [/\b(WindowGroup|Window|Settings|MenuBarExtra|DocumentGroup)\b[^{}\n]{0,160}\{/g, (m) => m[1], true],
      [/\bTabView\b[^{}\n]{0,120}\{/g, () => 'tab', true],
      [/\bNavigationLink\s*\{/g, () => 'NavigationLink', false],
      [/\.navigationDestination\s*\(\s*(?:for\s*:\s*([\w.]+)\.self|isPresented|item)[^{}\n]{0,160}\{/g, (m) => m[1] ? `navigationDestination for ${m[1]}` : 'navigationDestination', false],
      [/\.(sheet|fullScreenCover|popover)\s*\([^{}\n]{0,200}\)\s*\{/g, (m) => m[1], false],
    ];
    for (const [re, how, all] of blocks) {
      while ((m = re.exec(code))) {
        const a = m.index + m[0].length - 1; const txt = code.slice(a, matchClose(code, a) + 1);
        if (all) { for (const v of depth0Views(txt, views)) ref(v, how(m), F, m.index); }
        else { const v = firstView(txt); if (v) ref(v, how(m), F, m.index); else if (/NavigationLink/.test(m[0]) && /value\s*:/.test(m[0])) { /* value link: destination resolved by navigationDestination */ } }
      }
    }
    const dre = /\bNavigationLink\s*\(\s*destination\s*:\s*/g;
    while ((m = dre.exec(code))) { const v = firstView(code.slice(m.index, m.index + 240)); if (v) ref(v, 'NavigationLink', F, m.index); else unresolved(X, F, m.index, 'NavigationLink destination not a known View'); }
    const nre = /\b(NavigationStack|NavigationView|NavigationSplitView)\b/g;
    while ((m = nre.exec(code))) { const owner = encl(F, m.index); if (views.has(owner)) navRoots.add(owner); }
  }
  for (const [name, v] of [...views.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const hows = refs.get(name);
    const isScreen = !!hows || (navRoots.has(name) && /(View|Screen|Page|Scene)$/.test(name));
    if (isScreen) X.screens.push({ name, file: v.F.rel, line: v.F.line(v.idx), routes: hows ? [...hows].sort(cmp) : ['(navigation root)'], conf: 'literal', score: 3, kind: 'swiftui' });
    else X.components.push({ name, file: v.F.rel, line: v.F.line(v.idx) });
  }
}

// ---------------------------------------------------------------------------
// VB6
// ---------------------------------------------------------------------------
const VBID = '[\\p{L}\\p{N}_]+';
function extractVB6(P, files, X) {
  const forms = new Map(); const modName = new Map();
  for (const F of files) {
    if (F.ext === 'frm') {
      const m = new RegExp('^\\s*Begin\\s+VB\\.(Form|MDIForm)\\s+(' + VBID + ')', 'mu').exec(F.text); if (!m) continue;
      forms.set(m[2].toLowerCase(), m[2]); modName.set(F.rel, m[2]);
    } else { const a = /^Attribute\s+VB_Name\s*=\s*"([^"]+)"/m.exec(F.text); if (a) modName.set(F.rel, a[1]); }
  }
  for (const F of files) {
    const name = modName.get(F.rel) || baseOf(F.rel); let m;
    if (F.ext === 'frm') {
      const fm = new RegExp('^\\s*Begin\\s+VB\\.(Form|MDIForm)\\s+(' + VBID + ')', 'mu').exec(F.text); if (!fm) { unresolved(X, F, 0, 'VB6 form header not found'); continue; }
      const after = F.text.slice(fm.index + fm[0].length); const nested = after.search(/^\s*Begin\s+/m); const head = nested >= 0 ? after.slice(0, nested) : after;
      const cap = /^\s*Caption\s*=\s*"([^"]*)"/m.exec(head);
      const total = (F.text.match(/^\s*Begin\s+\S+/gm) || []).length - 1; const menus = (F.text.match(/^\s*Begin\s+VB\.Menu\b/gm) || []).length;
      X.screens.push({ name: fm[2] + (cap ? ` "${cap[1]}"` : ''), file: F.rel, line: F.line(fm.index), routes: [`${fm[1]}, controls ${total - menus}${menus ? `, menus ${menus}` : ''}`], conf: 'literal', score: 3, kind: 'vb6' });
      const hre = new RegExp('^[ \\t]*(?:Private\\s+|Public\\s+)?Sub\\s+(' + VBID + ')_(' + VBID + ')\\s*\\(', 'gmu'); const hs = [];
      while ((m = hre.exec(F.code))) hs.push(`${m[1]}_${m[2]}`);
      if (hs.length) X.entries.push({ entry: `${fm[2]}: ${hs.length} event handlers (${hs.slice(0, 8).join(', ')}${hs.length > 8 ? ', …' : ''})`, kind: 'vb6 event handlers', src: F.rel });
    } else if (F.ext === 'bas' || F.ext === 'cls' || F.ext === 'ctl') {
      const pre = new RegExp('^[ \\t]*(Private\\s+|Public\\s+|Friend\\s+)?(?:Static\\s+)?(Sub|Function|Property\\s+Get)\\s+(' + VBID + ')', 'gmu'); const pub = [];
      while ((m = pre.exec(F.code))) { if (!/Private/.test(m[1] || '')) pub.push(m[3]); if (m[3] === 'Main' && m[2] === 'Sub') X.entries.push({ entry: `${name}.Main`, kind: 'vb6 Sub Main', src: F.rel }); }
      X.services.push({ file: F.rel, kind: F.ext === 'bas' ? 'vb6 module' : 'vb6 class', exports: uniq(pub).slice(0, 4).join(', ') + (uniq(pub).length > 4 ? `, +${uniq(pub).length - 4}` : ''), indeg: 0 });
    } else if (F.ext === 'vbp') {
      const g = (k) => (F.text.match(new RegExp('^' + k + '=(.*)$', 'gm')) || []).map((x) => x.slice(k.length + 1).replace(/^"|"$/g, '').trim());
      X.entries.push({ entry: `${g('Name')[0] || baseOf(F.rel)}: startup ${g('Startup')[0] || '?'}; forms ${g('Form').length}, modules ${g('Module').length}, classes ${g('Class').length}`, kind: 'vb6 project', src: F.rel });
    }
    if (F.ext !== 'vbp') {
      const sre = new RegExp('(?:\\b(' + VBID + ')\\.Show\\b|\\bLoad\\s+(' + VBID + '))', 'gu');
      while ((m = sre.exec(F.code))) { const t = forms.get((m[1] || m[2]).toLowerCase()); if (t && t !== name) X.nav.push({ from: name, to: t, file: F.rel, line: F.line(m.index), conf: 'literal' }); }
    }
  }
}

// ---------------------------------------------------------------------------
// socket events, Electron IPC and windows
// ---------------------------------------------------------------------------
function extractEvents(F, X) {
  const code = F.code; let m;
  const ev = (kind, name, handler, idx, conf = 'literal') => X.events.push({ kind, name, handler, file: F.rel, line: F.line(idx), conf });
  const lit = (q, a, b) => (a != null ? a : b != null && !isDynamicStr(b) ? b : null);
  if (code.includes('@SubscribeMessage')) {
    const g = /@WebSocketGateway\s*\(([^)]*)\)/.exec(code); const ns = g && /namespace\s*:\s*(['"])([^'"]*)\1/.exec(g[1]);
    const re = /@SubscribeMessage\s*\(\s*(?:(['"])([^'"]*)\1|([^)]*))\)\s*(?:@\w+\([^)]*\)\s*)*(?:async\s+)?(\w+)/g;
    while ((m = re.exec(code))) { if (m[2] == null) { unresolved(X, F, m.index, '@SubscribeMessage dynamic event', m[3]); continue; } ev('ws gateway' + (ns ? ' ' + ns[2] : ''), m[2], m[4], m.index); }
  }
  const sre = /\b(io|socket|client|nsp|namespace|\w*[Ss]ocket)\s*\.\s*(on|once)\s*\(\s*(?:(['"])([^'"\n]+)\3|`([^`]*)`|([A-Za-z_$][\w$.]*))\s*,/g;
  while ((m = sre.exec(code))) { const n = lit(null, m[4], m[5]); if (n == null) { unresolved(X, F, m.index, `${m[1]}.${m[2]} dynamic event`); continue; } ev('socket.' + m[2], n, '', m.index); }
  const ire = /\bipc(Main|Renderer)\s*\.\s*(handle|handleOnce|on|once|invoke|send|sendSync|removeHandler)\s*\(\s*(?:(['"])([^'"\n]+)\3|`([^`]*)`|([^,)]+))/g;
  while ((m = ire.exec(code))) {
    if (m[2] === 'removeHandler') continue;
    const n = lit(null, m[4], m[5]); if (n == null) { unresolved(X, F, m.index, `ipc${m[1]}.${m[2]} dynamic channel`, (m[6] || m[5] || '').trim()); continue; }
    ev(`ipc${m[1]}.${m[2]}${m[1] === 'Renderer' ? ' (caller)' : ''}`, n, '', m.index);
  }
  const cre = /\bcontextBridge\s*\.\s*exposeInMainWorld\s*\(\s*(['"])([^'"]+)\1/g;
  while ((m = cre.exec(code))) X.entries.push({ entry: `window.${m[2]}`, kind: 'electron preload API', src: F.rel });
  if (code.includes('BrowserWindow')) {
    const loads = new Map(); const lre = /\b((?:this\.)?\w+)\s*\.\s*(?:webContents\s*\.\s*)?(loadURL|loadFile)\s*\(\s*([^)]{0,200})\)/g;
    while ((m = lre.exec(code))) {
      const v = m[1].replace(/^this\./, ''); const l = strLit(m[3].split(',')[0]);
      if (l == null || isDynamicStr(l)) unresolved(X, F, m.index, `BrowserWindow ${m[2]} target`, m[3].trim().slice(0, 80));
      if (!loads.has(v)) loads.set(v, []); loads.get(v).push(l != null && !isDynamicStr(l) ? l : `(dynamic ${m[2]})`);
    }
    const wre = /(?:\b(?:const|let|var)\s+(\w+)\s*(?::\s*[\w.<>]+\s*)?=\s*|\b(?:this\.)?(\w+)\s*=\s*)?new\s+BrowserWindow\s*\(/g;
    while ((m = wre.exec(code))) { const v = m[1] || m[2] || ''; const ls = loads.get(v) || (loads.size === 1 && !v ? [...loads.values()][0] : []); X.screens.push({ name: `BrowserWindow ${v || '(anonymous)'}`, file: F.rel, line: F.line(m.index), routes: uniq(ls).sort(cmp), conf: ls.length && !ls.some((x) => x.startsWith('(dynamic')) ? 'literal' : 'unresolved', score: 3, kind: 'electron' }); }
  }
}

// ---------------------------------------------------------------------------
// Python http.server handlers
// ---------------------------------------------------------------------------
function extractHttpServer(F, X) {
  const code = F.code; if (!/RequestHandler/.test(code)) return;
  const consts = new Map(); let m;
  const kre = /^(\w+)\s*=\s*re\.compile\(\s*r?(['"])([^'"\n]*)\2\s*[,)]/gm; while ((m = kre.exec(code))) consts.set(m[1], m[3]);
  const cre = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
  while ((m = cre.exec(code))) {
    if (!/\b(BaseHTTPRequestHandler|SimpleHTTPRequestHandler|CGIHTTPRequestHandler)\b|http\.server\./.test(m[2])) continue;
    const start = m.index + m[0].length; const rest = code.slice(start); const endRel = rest.search(/\n(?=\S)/); const body = endRel < 0 ? rest : rest.slice(0, endRel);
    const defs = []; const dre = /^([ \t]+)def\s+(\w+)\s*\(\s*self/gm; let d;
    while ((d = dre.exec(body))) defs.push({ name: d[2], a: d.index });
    let any = false;
    defs.forEach((df, i) => {
      const txt = body.slice(df.a, i + 1 < defs.length ? defs[i + 1].a : body.length);
      const verb = /^do_([A-Z]+)$/.exec(df.name); const method = verb ? verb[1] : '*';
      if (!verb && !/\bpath\b/.test(txt)) return;
      const found = [];
      const add = (p, idx, conf = 'literal') => found.push({ p: p.split('?')[0], idx, conf });
      let k;
      const eq = /(?:==|!=)\s*(['"])(\/[^'"]*)\1|(['"])(\/[^'"]*)\3\s*(?:==|!=)/g; while ((k = eq.exec(txt))) add(k[2] ?? k[4], k.index);
      const sw = /\.startswith\(\s*(['"])(\/[^'"]*)\1/g; while ((k = sw.exec(txt))) add(k[2] + '*', k.index);
      const inn = /\bin\s*[([{]([^)\]}]*)[)\]}]/g; while ((k = inn.exec(txt))) for (const q of k[1].matchAll(/(['"])(\/[^'"]*)\1/g)) add(q[2], k.index);
      const rx = /\bre\.(?:match|fullmatch|search)\(\s*r?(['"])(\^?\/[^'"]*)\1/g; while ((k = rx.exec(txt))) add('re:' + k[2], k.index);
      const rc = /\b(\w+)\.(?:match|fullmatch|search)\(\s*[\w.()]*path/g; while ((k = rc.exec(txt))) if (consts.has(k[1])) add('re:' + consts.get(k[1]), k.index, 'resolved'); else if (/^[A-Z_][A-Z0-9_]*$/.test(k[1])) unresolved(X, F, start + df.a + k.index, 'http.server path regex not literal', k[1]);
      const line = (idx) => F.line(start + df.a + idx);
      for (const f of found) { any = true; X.routes.push({ method, path: f.p, handler: `${m[1]}.${df.name}`, file: F.rel, line: line(f.idx), conf: f.conf, kind: 'http.server' }); }
      if (verb && !found.length) { any = true; unresolved(X, F, start + df.a, `http.server ${df.name} without literal paths`); X.routes.push({ method, path: '*', handler: `${m[1]}.${df.name}`, file: F.rel, line: line(0), conf: 'unresolved', kind: 'http.server' }); }
    });
    if (!any && /SimpleHTTPRequestHandler/.test(m[2])) X.routes.push({ method: 'GET', path: '/* (static files)', handler: m[1], file: F.rel, line: F.line(m.index), conf: 'literal', kind: 'http.server' });
  }
}

// ---------------------------------------------------------------------------
// Database tables
// ---------------------------------------------------------------------------
function keyCols(cols) {
  const pk = cols.filter((c) => c.pk); const fk = cols.filter((c) => c.fk && !c.pk);
  const rest = cols.filter((c) => !c.pk && !c.fk);
  const show = [...pk, ...fk, ...rest].slice(0, Math.max(6, pk.length + fk.length));
  const more = cols.length - show.length;
  return show.map((c) => c.name + (c.pk ? ' PK' : '') + (c.fk ? ' FK→' + c.fk : '')).join(', ') + (more > 0 ? `, +${more}` : '');
}
function extractTables(F, X, P) {
  const code = F.code; let m; const add = (name, kind, idx, cols, conf = 'literal') => X.tables.push({ name, kind, file: F.rel, line: F.line(idx), cols: keyCols(cols), ncols: cols.length, conf });
  if (/CREATE\s+(?:VIRTUAL\s+)?TABLE/i.test(code)) {
    const re = /CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+|VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"\[]?[\w$]+[`"\]]?\.)?[`"\[]?([\w$]+)[`"\]]?)\s*(\(|USING)/gi;
    while ((m = re.exec(code))) {
      if (m[3].toUpperCase() === 'USING') { add(m[2], 'sql-virtual', m.index, []); continue; }
      const a = m.index + m[0].length - 1; const b = matchClose(code, a); const parts = splitTopArgs(code, a, b);
      const cols = []; const pks = new Set(); const fks = new Map();
      for (const part of parts) {
        const p = part.replace(/\s+/g, ' ').trim(); let k;
        if ((k = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(p))) { k[1].split(',').forEach((c) => pks.add(c.trim().replace(/[`"[\]]/g, ''))); continue; }
        if ((k = /^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([\w."`$]+)/i.exec(p))) { k[1].split(',').forEach((c) => fks.set(c.trim().replace(/[`"[\]]/g, ''), k[2].replace(/[`"]/g, ''))); continue; }
        if (/^(CONSTRAINT|UNIQUE|CHECK|INDEX|KEY|EXCLUDE)\b/i.test(p)) continue;
        if ((k = /^[`"[]?([\w$]+)[`"\]]?\s+(.*)$/.exec(p))) {
          const ref = /REFERENCES\s+([\w."`$]+)/i.exec(k[2]);
          cols.push({ name: k[1], pk: /PRIMARY\s+KEY/i.test(k[2]), fk: ref ? ref[1].replace(/[`"]/g, '') : null });
        }
      }
      for (const c of cols) { if (pks.has(c.name)) c.pk = true; if (fks.has(c.name)) c.fk = fks.get(c.name); }
      const inStr = F.ext !== 'sql';
      add(m[2], F.ext === 'sql' ? 'sql' : F.ext === 'dart' ? 'sqflite/sql' : 'sql-in-code', m.index, cols, inStr && /\$\{|\$\w/.test(code.slice(m.index, m.index + 200)) ? 'unresolved' : 'literal');
    }
  }
  if (F.ext === 'prisma') {
    const re = /^\s*model\s+(\w+)\s*\{/gm;
    while ((m = re.exec(code))) {
      const a = m.index + m[0].length - 1; const body = code.slice(a + 1, matchClose(code, a)); const cols = [];
      for (const ln of body.split('\n')) {
        const k = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(ln); if (!k || ln.trim().startsWith('@@')) continue;
        if (/@relation/.test(k[5]) || k[3]) continue;
        cols.push({ name: k[1], pk: /@id\b/.test(k[5]), fk: null });
      }
      const rel = /(\w+)\s+(\w+)\??\s+@relation\([^)]*fields\s*:\s*\[([^\]]*)\]/g; let r;
      while ((r = rel.exec(body))) for (const fld of r[3].split(',')) { const c = cols.find((x) => x.name === fld.trim()); if (c) c.fk = r[2]; }
      const mp = /@@map\(\s*"([^"]+)"/.exec(body);
      add(mp ? mp[1] : m[1], 'prisma', m.index, cols);
    }
  }
  if (JS_EXT.has(F.ext)) {
    const dre = /\b(pgTable|mysqlTable|sqliteTable)\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*(?:\(\s*\w*\s*\)\s*=>\s*\(?\s*)?\{/g;
    while ((m = dre.exec(code))) {
      const a = m.index + m[0].length - 1; const body = code.slice(a, matchClose(code, a)); const cols = []; let c;
      const cre = /(?:^|[,{]\s*)(\w+)\s*:\s*\w+\s*\(/gm;
      while ((c = cre.exec(body))) { const tail = body.slice(c.index, c.index + 300).split(/\n\s*\w+\s*:/)[0]; const ref = /references\s*\(\s*\(\)\s*=>\s*(\w+)/.exec(tail); cols.push({ name: c[1], pk: /primaryKey\(/.test(tail), fk: ref ? ref[1] : null }); }
      add(m[3], 'drizzle', m.index, cols);
    }
    const kre = /\.createTable\s*\(\s*(['"`])(\w+)\1/g;
    while ((m = kre.exec(code))) {
      const tail = code.slice(m.index, m.index + 3000); const cols = []; let c; const cre = /\b\w+\.(\w+)\s*\(\s*['"`](\w+)['"`]/g;
      while ((c = cre.exec(tail))) { if (/^(createTable|alterTable|dropTable|raw)$/.test(c[1])) { if (c.index > 0) break; continue; } cols.push({ name: c[2], pk: /increments|primary/.test(c[1]), fk: /references\(['"`]([\w.]+)/.exec(tail.slice(c.index, c.index + 200))?.[1] || null }); }
      add(m[2], 'knex-migration', m.index, cols);
    }
    const tre = /@Entity\s*\(\s*(?:(['"])([^'"]+)\1|\{[^}]*name\s*:\s*(['"])([^'"]+)\3[^}]*\})?\s*\)\s*(?:@\w+\([^)]*\)\s*)*export\s+(?:default\s+)?class\s+(\w+)/g;
    while ((m = tre.exec(code))) {
      const a = code.indexOf('{', m.index + m[0].length); if (a < 0) continue; const body = code.slice(a, matchClose(code, a)); const cols = []; let c;
      const cre = /@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|ManyToOne|OneToOne|JoinColumn)\s*\([^)]*\)\s*(?:@\w+\([^)]*\)\s*)*(\w+)\s*[!?]?\s*:\s*(\w+)/g;
      while ((c = cre.exec(body))) cols.push({ name: c[2], pk: /^Primary/.test(c[1]), fk: /ManyToOne|OneToOne/.test(c[1]) ? c[3] : null });
      add(m[2] || m[4] || m[5], 'typeorm', m.index, cols);
    }
    const mre = /\b(?:mongoose\.)?model\s*(?:<[^>]*>)?\s*\(\s*(['"])(\w+)\1\s*,\s*(\w+)/g; const schemas = new Map();
    const sre = /\b(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*(?:<[^>]*>)?\s*\(\s*\{/g;
    while ((m = sre.exec(code))) { const a = m.index + m[0].length - 1; const body = code.slice(a, matchClose(code, a)); const cols = []; const kids = []; let i = 1; let depth = 0; let st = 1; for (; i < body.length; i++) { const ch = body[i]; if (ch === '"' || ch === "'" || ch === '`') { i = skipString(body, i) - 1; continue; } if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; else if (ch === ',' && depth === 0) { kids.push(body.slice(st, i)); st = i + 1; } } kids.push(body.slice(st)); for (const k of kids) { const n = /^\s*['"]?(\w+)['"]?\s*:/.exec(k); if (n) cols.push({ name: n[1], pk: false, fk: /\bref\s*:\s*['"](\w+)/.exec(k)?.[1] || null }); } schemas.set(m[1], { cols, idx: m.index }); }
    while ((m = mre.exec(code))) { const s = schemas.get(m[3]); add(m[2], 'mongoose', m.index, s ? s.cols : []); }
    const qre = /\b(?:sequelize|db)\s*\.\s*define\s*\(\s*(['"])(\w+)\1\s*,\s*\{/g;
    while ((m = qre.exec(code))) { const a = m.index + m[0].length - 1; const body = code.slice(a, matchClose(code, a)); const cols = []; let c; const cre = /(?:^|[,{]\s*)(\w+)\s*:\s*(?:\{|DataTypes|Sequelize)/gm; while ((c = cre.exec(body))) cols.push({ name: c[1], pk: /primaryKey\s*:\s*true/.test(body.slice(c.index, c.index + 200).split(/\n\s*\w+\s*:\s*\{/)[0]), fk: null }); add(m[2], 'sequelize', m.index, cols); }
  }
  if (F.ext === 'py') {
    const cre = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
    while ((m = cre.exec(code))) {
      const bases = m[2]; if (!/Model|Base\b|DeclarativeBase|SQLModel|Document/.test(bases) || /\b(BaseModel|pydantic)\b/.test(bases) && !/table\s*=\s*True/.test(bases)) continue;
      const start = m.index + m[0].length; const nx = /^\S/m; const restc = code.slice(start); const end = nx.exec(restc.replace(/^[^\n]*\n/, '\n'))?.index; const body = end != null ? restc.slice(0, end + (restc.indexOf('\n') + 1)) : restc;
      const tn = /__tablename__\s*=\s*['"](\w+)['"]/.exec(body); const cols = []; let c;
      const fre = /^[ \t]+(\w+)\s*(?::\s*[^=\n]+)?=\s*(?:\w+\.)?(Column|mapped_column|Field|\w+Field|ForeignKey|OneToOneField|ManyToManyField)\s*\(([^\n]{0,300})/gm;
      while ((c = fre.exec(body))) {
        if (c[2] === 'ManyToManyField') continue;
        const fk = /^(ForeignKey|OneToOneField)$/.test(c[2]) ? (/^\s*['"]?([\w.]+)/.exec(c[3])?.[1] || '?') : (/ForeignKey\(\s*['"]([\w.]+)['"]/.exec(c[3])?.[1] || null);
        cols.push({ name: c[1], pk: /primary_key\s*=\s*True/.test(c[3]), fk });
      }
      if (!cols.length && !tn) continue;
      const kind = /models\.Model/.test(bases) ? 'django' : /SQLModel/.test(bases) ? 'sqlmodel' : /db\.Model|Base|DeclarativeBase/.test(bases) && /Column|mapped_column/.test(body) ? 'sqlalchemy' : /Document/.test(bases) ? 'odm' : 'peewee/orm';
      add(tn ? tn[1] : m[1], kind, m.index, cols);
    }
    const are = /\bop\.create_table\s*\(\s*['"](\w+)['"]/g;
    while ((m = are.exec(code))) { const a = code.indexOf('(', m.index); const t = code.slice(a, matchClose(code, a)); const cols = []; let c; const re2 = /sa\.Column\s*\(\s*['"](\w+)['"]([^\n]*)/g; while ((c = re2.exec(t))) cols.push({ name: c[1], pk: /primary_key\s*=\s*True/.test(c[2]), fk: /ForeignKey\(\s*['"]([\w.]+)/.exec(c[2])?.[1] || null }); add(m[1], 'alembic', m.index, cols); }
  }
  if (F.ext === 'dart') {
    const re = /\bclass\s+(\w+)\s+extends\s+Table\s*\{/g;
    while ((m = re.exec(code))) { const a = m.index + m[0].length - 1; const body = code.slice(a, matchClose(code, a)); const cols = []; let c; const re2 = /(\w+)Column\s+get\s+(\w+)\s*=>([^;]*)/g; while ((c = re2.exec(body))) cols.push({ name: c[2], pk: /autoIncrement\(\)/.test(c[3]), fk: /references\(\s*(\w+)/.exec(c[3])?.[1] || null }); add(m[1], 'drift', m.index, cols); }
  }
}

// ---------------------------------------------------------------------------
// imports graph
// ---------------------------------------------------------------------------
function loadTsPaths(P, read) {
  for (const n of ['tsconfig.json', 'jsconfig.json']) {
    const F = read(pjoin(P.dir, n)); if (!F) continue; const j = parseJsonLoose(F.text); const co = j && j.compilerOptions; if (!co) continue;
    const base = pjoin(P.dir, co.baseUrl || '.'); const paths = [];
    for (const [k, v] of Object.entries(co.paths || {})) if (Array.isArray(v) && v.length && typeof v[0] === 'string') paths.push({ k, v: v.map((x) => pjoin(base, x)) });
    return { base: co.baseUrl ? base : null, paths };
  }
  return { base: null, paths: [] };
}
function buildGraph(P, files, idx, fileSet, read) {
  const edges = new Map(); const ts = loadTsPaths(P, read);
  const jsCand = (p) => { const c = [p]; for (const e of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'd.ts']) c.push(p + '.' + e); for (const e of ['ts', 'tsx', 'js', 'jsx']) c.push(p + '/index.' + e); if (/\.(m|c)?js$/.test(p)) { const s = p.replace(/\.(m|c)?js$/, ''); c.push(s + '.ts', s + '.tsx', s + '.mts'); } return c.find((x) => fileSet.has(x)) || null; };
  const resolveSpec = (from, spec) => {
    if (spec.startsWith('.')) return jsCand(pjoin(dirOf(from), spec));
    for (const { k, v } of ts.paths) {
      if (k.endsWith('*') ? spec.startsWith(k.slice(0, -1)) : spec === k) { const rest = k.endsWith('*') ? spec.slice(k.length - 1) : ''; for (const t of v) { const r = jsCand(t.replace('*', rest)); if (r) return r; } }
    }
    if (ts.base) return jsCand(pjoin(ts.base, spec));
    return null;
  };
  for (const F of files) {
    const out = new Set(); const code = F.code; let m;
    if (JS_EXT.has(F.ext)) {
      const re = /(?:\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?|\bexport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+)?from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\1/g;
      while ((m = re.exec(code))) { const t = resolveSpec(F.rel, m[2]); if (t) out.add(t); }
    } else if (F.ext === 'dart') {
      const re = /^\s*(?:import|export|part)\s+(['"])([^'"]+)\1/gm;
      while ((m = re.exec(code))) {
        let t = null; const s = m[2];
        if (s.startsWith('package:')) { const mm = /^package:([\w]+)\/(.*)$/.exec(s); if (mm && mm[1] === P.dartPackage) t = pjoin(P.dir, 'lib', mm[2]); }
        else if (!/^dart:/.test(s)) t = pjoin(dirOf(F.rel), s);
        if (t && fileSet.has(t)) out.add(t);
      }
    } else if (F.ext === 'py') {
      for (const im of pyImports(F)) {
        let t = null;
        if (im.name && im.name !== '*') t = pyResolve(idx, F.rel, im.mod + (im.mod.endsWith('.') ? '' : '.') + im.name);
        if (!t) t = pyResolve(idx, F.rel, im.mod);
        if (t && t !== F.rel) out.add(t);
      }
    }
    out.delete(F.rel); edges.set(F.rel, [...out].sort(cmp));
  }
  return { edges, resolveSpec };
}
function graphFacts(edges, X) {
  const indeg = new Map();
  for (const [, outs] of edges) for (const t of outs) indeg.set(t, (indeg.get(t) || 0) + 1);
  const top = [...indeg.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 15);
  for (const [file, n] of top) X.topModules.push({ file, n });
  const nodes = [...edges.keys()].sort(cmp); const cycles = []; let budget = 200000;
  for (const s of nodes) {
    if (cycles.length >= 20 || budget <= 0) break;
    const dfs = (u, pathA) => {
      if (cycles.length >= 20 || --budget <= 0) return;
      for (const v of edges.get(u) || []) {
        if (v === s && pathA.length >= 2) cycles.push([...pathA]);
        else if (v > s && pathA.length < 4 && !pathA.includes(v)) dfs(v, [...pathA, v]);
        if (cycles.length >= 20) return;
      }
    };
    dfs(s, [s]);
  }
  for (const c of cycles) X.cycles.push(c);
  return indeg;
}

// ---------------------------------------------------------------------------
// services, tests, generic
// ---------------------------------------------------------------------------
const SERVICE_DIRS = new Set(['services', 'service', 'utils', 'util', 'helpers', 'helper', 'lib', 'libs', 'middleware', 'middlewares', 'repositories', 'repository', 'repos', 'providers', 'provider', 'blocs', 'bloc', 'cubits', 'cubit', 'controllers', 'managers', 'clients', 'api']);
const SERVICE_FILE = /(?:_service|Service|_repository|Repository|_repo|_bloc|Bloc|_cubit|Cubit|_provider|Provider|_helper|Helper|_utils?|Utils?|_middleware|Middleware|_client|Client|_manager|Manager)\.\w+$/;
const TEST_SEG = /(^|\/)(test|tests|__tests__|spec|specs|integration_test|e2e|cypress|playwright)\//;
const TEST_FILE = /(_test|\.test|\.spec|_spec|Tests?)\.\w+$|^test_[^/]*\.py$/;
function isTestPath(lp) { return TEST_SEG.test(lp) || TEST_FILE.test(baseOf(lp)); }
function exportsOf(F) {
  const names = []; const code = F.code; let m; let re;
  if (F.ext === 'dart') re = /^(?:abstract\s+|final\s+|sealed\s+)*(?:class|mixin|enum|extension)\s+([A-Z]\w*)/gm;
  else if (JS_EXT.has(F.ext)) re = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  else if (F.ext === 'py') re = /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm;
  else if (F.ext === 'go') re = /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm;
  else if (F.ext === 'rb') re = /^\s*(?:class|module)\s+([A-Z][\w:]*)/gm;
  else if (['swift', 'kt', 'java', 'cs'].includes(F.ext)) re = /\b(?:class|struct|protocol|interface|enum|object|actor)\s+([A-Z]\w*)/g;
  else return names;
  while ((m = re.exec(code)) && names.length < 50) names.push(m[1]);
  return uniq(names);
}
function extractServicesTests(P, X, read, indeg) {
  const isDart = P.fw.has('Flutter') || P.fw.has('Dart');
  const tests = new Map();
  for (const f of P.files) {
    if (!CODE_EXT.has(f.ext)) continue;
    const lp = local(P, f.rel);
    if (isTestPath(lp)) {
      const segs = lp.split('/'); const top = segs.length > 1 ? segs[0] + '/' : '(root)';
      const sub = segs.length > 2 ? segs[1] : '';
      if (!tests.has(top)) tests.set(top, { n: 0, subs: new Map() });
      const t = tests.get(top); t.n++; if (sub) t.subs.set(sub, (t.subs.get(sub) || 0) + 1);
      continue;
    }
    const segs = lp.split('/').slice(0, -1);
    const kindDir = segs.find((s, i) => SERVICE_DIRS.has(s) && !(s === 'lib' && i === 0 && (isDart || f.ext === 'rb')) && !(s === 'api' && /^(app|pages)$/.test(segs[i - 1] || '')));
    const fm = SERVICE_FILE.exec(baseOf(lp));
    if (!kindDir && !fm) continue;
    if (/\.(d\.ts)$/.test(lp) || baseOf(lp) === '__init__.py') continue;
    const F = read(f.rel); const ex = F ? exportsOf(F) : [];
    const kind = kindDir || fm[0].replace(/^[_.]/, '').replace(/\.\w+$/, '').toLowerCase();
    X.services.push({ file: f.rel, kind, exports: ex.slice(0, 4).join(', ') + (ex.length > 4 ? `, +${ex.length - 4}` : ''), indeg: indeg.get(f.rel) || 0 });
  }
  for (const [top, t] of tests) X.tests.push({ dir: P.dir ? P.dir + '/' + (top === '(root)' ? '' : top) : top, n: t.n, subs: [...t.subs.entries()].sort((a, b) => cmp(a[0], b[0])).map(([k, v]) => `${k} (${v})`).join(', ') });
}
function extractGeneric(P, X, read, root) {
  const pf = (b) => read(pjoin(P.dir, b));
  for (const f of P.files) {
    const lp = local(P, f.rel); const b = baseOf(lp);
    if (isTestPath(lp)) continue;
    if (f.ext === 'py') {
      const F = read(f.rel);
      if (F && /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.test(F.code)) X.entries.push({ entry: f.rel, kind: '__main__', src: f.rel });
      else if (/^(main|app|cli|manage|wsgi|asgi|server|run|__main__)\.py$/.test(b)) X.entries.push({ entry: f.rel, kind: 'entry file', src: f.rel });
    } else if (b === 'main.go') X.entries.push({ entry: f.rel, kind: 'go main', src: f.rel });
    else if (b === 'main.dart' && /^lib\//.test(lp) && dirOf(lp) === 'lib') X.entries.push({ entry: f.rel, kind: 'dart main', src: f.rel });
    else if (/^Dockerfile(\..+)?$/.test(b)) {
      const F = read(f.rel); if (F) { const re = /^\s*(CMD|ENTRYPOINT)\s+(.+)$/gm; let m; while ((m = re.exec(F.code))) X.entries.push({ entry: m[2].trim().slice(0, 90), kind: 'docker ' + m[1], src: f.rel }); }
    } else if (b === 'Makefile' || b === 'makefile' || b === 'justfile') {
      const F = read(f.rel); if (F) { const re = /^([A-Za-z][\w.-]*)\s*:(?!=)/gm; let m; const ts = []; while ((m = re.exec(F.code))) ts.push(m[1]); if (ts.length) X.entries.push({ entry: uniq(ts).slice(0, 15).join(', ') + (uniq(ts).length > 15 ? ', …' : ''), kind: b + ' targets', src: f.rel }); }
    } else if (/^(sh|ps1|bash|bat|cmd)$/.test(f.ext) && /^(scripts?|bin|tools)\//.test(lp)) X.entries.push({ entry: f.rel, kind: 'script', src: f.rel });
    else if (f.ext === 'ipynb') {
      let title = '';
      if (f.kind === 'text') { const F = read(f.rel); const j = F ? parseJsonLoose(F.text) : null; const cell0 = j && Array.isArray(j.cells) ? j.cells.find((c) => c.cell_type === 'markdown') : null; if (cell0) { const src = Array.isArray(cell0.source) ? cell0.source.join('') : String(cell0.source || ''); const h = /^\s*#+\s+(.+)$/m.exec(src); if (h) title = h[1].trim().slice(0, 100); } }
      else title = '(not read: > 1 MB)';
      X.notebooks.push({ file: f.rel, title });
    }
  }
  const j = P.pkgJson;
  if (j) {
    const src = pjoin(P.dir, 'package.json');
    if (typeof j.bin === 'string') X.entries.push({ entry: j.bin, kind: 'npm bin', src });
    else if (j.bin && typeof j.bin === 'object') for (const k of Object.keys(j.bin).sort(cmp)) X.entries.push({ entry: `${k} → ${j.bin[k]}`, kind: 'npm bin', src });
    if (j.scripts && typeof j.scripts === 'object') for (const k of Object.keys(j.scripts).sort(cmp)) X.entries.push({ entry: `${k}: ${String(j.scripts[k]).slice(0, 80)}`, kind: 'npm script', src });
  }
  const pp = pf('pyproject.toml');
  if (pp) { const re = /^\[(project\.scripts|tool\.poetry\.scripts)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm; let m; while ((m = re.exec(pp.text))) for (const ln of m[2].split('\n')) { const k = /^\s*([\w.-]+)\s*=\s*['"]([^'"]+)['"]/.exec(ln); if (k) X.entries.push({ entry: `${k[1]} → ${k[2]}`, kind: 'pyproject script', src: pp.rel }); } }
  // directory summary
  const dirs = new Map();
  for (const f of P.files) { const lp = local(P, f.rel); const top = lp.includes('/') ? lp.split('/')[0] + '/' : '(files)'; if (!dirs.has(top)) dirs.set(top, { n: 0, ext: new Map() }); const d = dirs.get(top); d.n++; const e = f.ext || '(none)'; d.ext.set(e, (d.ext.get(e) || 0) + 1); }
  for (const [d, v] of [...dirs.entries()].sort((a, b) => cmp(a[0], b[0]))) X.dirs.push({ dir: d === '(files)' ? (P.dir ? P.dir + '/ (files)' : '(root files)') : pjoin(P.dir, d.slice(0, -1)) + '/', n: v.n, mix: [...v.ext.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ') });
  // data/model dirs: inventory weight files + well-known dirs (gitignored ones are walked for size only)
  const dataDirs = new Map();
  for (const f of P.files) if (WEIGHT_EXT.has(f.ext)) { const d = dirOf(f.rel) || '.'; if (!dataDirs.has(d)) dataDirs.set(d, { n: 0, size: 0, ext: new Set(), src: 'tracked' }); const x = dataDirs.get(d); x.n++; x.size += f.size; x.ext.add(f.ext); }
  const WELL = /^(data|datasets?|models?|weights|checkpoints?|ckpt|artifacts|runs)$/;
  const absP = path.join(root, P.dir);
  let tops = []; try { tops = fs.readdirSync(absP, { withFileTypes: true }).filter((e) => e.isDirectory() && WELL.test(e.name)).map((e) => e.name).sort(cmp); } catch { /* none */ }
  for (const name of tops) {
    const rel = pjoin(P.dir, name); if ([...dataDirs.keys()].some((d) => d === rel || d.startsWith(rel + '/'))) { for (const k of [...dataDirs.keys()]) if (k === rel || k.startsWith(rel + '/')) dataDirs.delete(k); }
    let n = 0; let size = 0; const ext = new Set(); let entries = 0;
    const rec = (abs) => { let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (++entries > 20000) return; const p = path.join(abs, e.name); if (e.isDirectory() && !isIgnoredSeg(e.name)) rec(p); else if (e.isFile()) { n++; try { size += fs.statSync(p).size; } catch { /* skip */ } const x = extOf(e.name); if (x) ext.add(x); } } };
    rec(path.join(absP, name));
    if (n) dataDirs.set(rel, { n, size, ext, src: entries > 20000 ? 'walked (capped)' : 'walked' });
  }
  for (const [d, v] of [...dataDirs.entries()].sort((a, b) => cmp(a[0], b[0]))) X.data.push({ dir: d + '/', n: v.n, size: humanSize(v.size), types: [...v.ext].sort(cmp).slice(0, 8).join(', ') });
}

// ---------------------------------------------------------------------------
// scan orchestration
// ---------------------------------------------------------------------------
export function scan(root, opts = {}) {
  const info = inventory(root, opts.exclude || []);
  const { read, warnings } = makeReader(root, info);
  const projects = detectProjects(info);
  const fileSet = new Set(info.files.map((f) => f.rel));
  const results = []; const pyAll = [];
  for (const P of projects) {
    detectStack(P, read); addPyImportStack(P, read);
    const X = newFacts();
    const textFiles = (exts) => P.files.filter((f) => exts.includes(f.ext)).map((f) => read(f.rel)).filter(Boolean);
    const dart = textFiles(['dart']); const js = textFiles([...JS_EXT]); const py = textFiles(['py']);
    const idx = pyModuleIndex(P); idx.byFile = new Set(P.files.filter((f) => f.ext === 'py').map((f) => f.rel));
    if (dart.length) extractDart(P, dart, X);
    extractWebPaths(P, X, read);
    const { edges, resolveSpec } = buildGraph(P, [...dart, ...js, ...py], idx, fileSet, read);
    const jctx = { jsRoutes: [], mounts: [] };
    for (const F of js) { if (isTestPath(local(P, F.rel))) continue; extractJsRouterConfigs(F, X); extractJsBackend(F, X, jctx); extractEvents(F, X); }
    finishJsBackend(X, jctx, resolveSpec);
    pyAll.push(...py.filter((F) => !isTestPath(local(P, F.rel))));
    const swift = textFiles(['swift']); if (swift.length) extractSwift(P, swift, X);
    const vb = textFiles([...VB_EXT]); if (vb.length) extractVB6(P, vb, X);
    for (const f of P.files) {
      const lp = local(P, f.rel);
      if (f.ext === 'rb' && /(^|\/)config\/routes\.rb$|(^|\/)config\/routes\/.*\.rb$/.test(lp)) { const F = read(f.rel); if (F) extractRails(F, X); }
      if (f.ext === 'go' && !/_test\.go$/.test(lp)) { const F = read(f.rel); if (F) extractGo(F, X); }
      if (['sql', 'prisma', 'py', 'dart', ...JS_EXT].includes(f.ext) && !isTestPath(lp)) { const F = read(f.rel); if (F) extractTables(F, X, P); }
    }
    const indeg = graphFacts(edges, X);
    extractServicesTests(P, X, read, indeg);
    extractGeneric(P, X, read, root);
    results.push({ P, X });
  }
  // Python routes are resolved repo-wide: blueprints/routers are often registered from a sibling sub-project
  if (pyAll.length) {
    const byDepth = [...results].sort((a, b) => b.P.dir.length - a.P.dir.length || cmp(a.P.dir, b.P.dir));
    const own = (file) => byDepth.find((r) => r.P.dir === '' || file.startsWith(r.P.dir + '/')).X;
    const proxy = { routes: { push: (...rs) => rs.forEach((r) => own(r.file).routes.push(r)) }, unresolved: { push: (...us) => us.forEach((u) => own(u.file).unresolved.push(u)) } };
    const gidx = new Map(); const py = info.files.filter((f) => f.ext === 'py');
    const roots = uniq(projects.flatMap((P) => [P.dir, pjoin(P.dir, 'src')])).sort((a, b) => b.length - a.length || cmp(a, b));
    for (const r of roots) for (const f of py) { if (r && !f.rel.startsWith(r + '/')) continue; const mod = (r ? f.rel.slice(r.length + 1) : f.rel).replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.'); if (!gidx.has(mod)) gidx.set(mod, f.rel); }
    gidx.byFile = new Set(py.map((f) => f.rel));
    extractPython(null, pyAll.sort((a, b) => cmp(a.rel, b.rel)), proxy, gidx);
  }
  return { info, warnings, results, fileSet };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
const codeSpan = (s) => { s = String(s); return s.includes('`') ? '`` ' + s + ' ``' : '`' + s + '`'; };
const dedupe = (rows) => { const seen = new Set(); return rows.filter((r) => { const k = JSON.stringify(r.cells); if (seen.has(k)) return false; seen.add(k); return true; }); };
function sortRows(rows) { return dedupe(rows.sort((a, b) => { for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) { const c = typeof a.key[i] === 'number' ? a.key[i] - b.key[i] : cmp(String(a.key[i] ?? ''), String(b.key[i] ?? '')); if (c) return c; } return 0; })); }
function stackLine(P) {
  const parts = [];
  if (P.fw.size) parts.push([...P.fw].sort(cmp).join(', '));
  if (P.tags.size) parts.push('libs: ' + [...P.tags].sort(cmp).join(', '));
  if (P.db.size) parts.push('db: ' + [...P.db].sort(cmp).join(', '));
  if (P.langs.length) parts.push('langs: ' + P.langs.join(', '));
  return parts.join('; ') || 'unknown';
}
const fileSegs = (s) => String(s).replace(/:\d+$/, '').split('/').filter(Boolean);
const urlSegs = (p) => (String(p).startsWith('/') ? String(p).split('/').filter(Boolean) : ['_other']);
const GROUP_COL = { Screens: 1, 'Navigation edges': 2, 'Entry points': 2, 'Socket events and IPC': 3, 'SwiftUI components (views not reached by navigation)': 1 };
// split key: URL segments for routes, source file path for everything else (tables also by table-name prefix)
function groupKey(tableTitle, cells) {
  if (tableTitle === 'Routes') return urlSegs(cells[1]);
  if (tableTitle === 'Tables') return [...fileSegs(cells[3]), String(cells[0]).split('_')[0]];
  const col = GROUP_COL[tableTitle] ?? cells.findIndex((c) => String(c).includes('/'));
  return col >= 0 ? fileSegs(String(cells[col]).split(' ')[0]) : [];
}
export function buildDocs(results) {
  // doc = {name, title, sections:[{label, tables:[{title, headers, rows:[{cells, score, key, paths}]}]}]}
  const docs = new Map();
  const add = (name, title, label, tableTitle, headers, rows) => {
    if (!rows.length) return;
    if (!docs.has(name)) docs.set(name, { name, title, sections: [] });
    const d = docs.get(name); let s = d.sections.find((x) => x.label === label);
    if (!s) { s = { label, tables: [] }; d.sections.push(s); }
    for (const r of rows) r.g = groupKey(tableTitle, r.cells);
    s.tables.push({ title: tableTitle, headers, rows: sortRows(rows) });
  };
  for (const { P, X } of results) {
    const label = `\`${P.label}\` (${[...P.fw].sort(cmp).join(', ') || 'generic'})`;
    add('screens.md', 'Screens and pages', label, 'Screens', ['Screen', 'File', 'Route', 'Confidence'],
      X.screens.map((s) => ({ key: [s.file, s.name], cells: [s.name, `${s.file}:${s.line}`, s.routes.join(', '), s.conf], score: s.score, paths: [s.file] })));
    add('screens.md', 'Screens and pages', label, 'Navigation edges', ['From', 'To', 'At', 'Confidence'],
      X.nav.map((n) => ({ key: [n.file, n.line, n.to], cells: [n.from, n.to, `${n.file}:${n.line}`, n.conf], score: 0.5, paths: [] })));
    add('api-routes.md', 'API and page routes', label, 'Routes', ['Method', 'Path', 'Handler', 'Source', 'Kind', 'Confidence'],
      X.routes.map((r) => ({ key: [r.path, r.method, r.file, r.line], cells: [r.method, r.path, [r.handler, r.name ? `name=${r.name}` : ''].filter(Boolean).join(' '), `${r.file}:${r.line}`, r.kind, r.conf], score: r.conf === 'unresolved' ? 1 : 2, paths: [r.file] })));
    add('api-routes.md', 'API and page routes', label, 'Socket events and IPC', ['Kind', 'Event / channel', 'Handler', 'Source', 'Confidence'],
      X.events.map((e) => ({ key: [e.kind, e.name, e.file, e.line], cells: [e.kind, e.name, e.handler, `${e.file}:${e.line}`, e.conf], score: 2, paths: [e.file] })));
    add('screens.md', 'Screens and pages', label, 'SwiftUI components (views not reached by navigation)', ['View', 'File'],
      X.components.map((c) => ({ key: [c.file, c.name], cells: [c.name, `${c.file}:${c.line}`], score: 1, paths: [] })));
    add('db-tables.md', 'Database tables and models', label, 'Tables', ['Table', 'Kind', 'Key columns', 'Source', 'Confidence'],
      X.tables.map((t) => ({ key: [t.name, t.file, t.line], cells: [t.name, t.kind, t.cols, `${t.file}:${t.line}`, t.conf], score: 3, paths: [t.file] })));
    add('services.md', 'Services and utilities', label, 'Services', ['File', 'Kind', 'Exports', 'Imported by'],
      X.services.map((s) => ({ key: [s.file], cells: [s.file, s.kind, s.exports, String(s.indeg)], score: 1 + s.indeg, paths: [s.file] })));
    add('tests.md', 'Tests', label, 'Tests by top-level folder', ['Folder', 'Files', 'Sub-folders'],
      X.tests.map((t) => ({ key: [t.dir], cells: [t.dir, String(t.n), t.subs], score: 2 + t.n / 100, paths: [] })));
    add('modules.md', 'Modules, entry points and data', label, 'Entry points', ['Entry', 'Kind', 'Source'],
      X.entries.map((e) => ({ key: [e.src, e.kind, e.entry], cells: [e.entry, e.kind, e.src], score: e.kind === 'npm script' ? 1.5 : 5, paths: [] })));
    add('modules.md', 'Modules, entry points and data', label, 'Most imported files', ['File', 'Imported by'],
      X.topModules.map((t) => ({ key: [-t.n, t.file], cells: [t.file, String(t.n)], score: 3 + t.n / 100, paths: [] })));
    add('modules.md', 'Modules, entry points and data', label, 'Import cycles (length <= 4, capped at 20)', ['Cycle'],
      X.cycles.map((c) => ({ key: [c.join(' ')], cells: [c.concat(c[0]).join(' → ')], score: 3, paths: [] })));
    add('modules.md', 'Modules, entry points and data', label, 'Notebooks', ['Notebook', 'Title'],
      X.notebooks.map((n) => ({ key: [n.file], cells: [n.file, n.title], score: 2, paths: [] })));
    add('modules.md', 'Modules, entry points and data', label, 'Top-level directories', ['Directory', 'Files', 'Extensions'],
      X.dirs.map((d) => ({ key: [d.dir], cells: [d.dir, String(d.n), d.mix], score: 4, paths: [] })));
    add('modules.md', 'Modules, entry points and data', label, 'Model / data / weights (count and size only)', ['Directory', 'Files', 'Size', 'Types'],
      X.data.map((d) => ({ key: [d.dir], cells: [d.dir, String(d.n), d.size, d.types], score: 4, paths: [] })));
    add('unresolved.md', 'Unresolved (dynamic, needs a human or LLM look)', label, 'Unresolved', ['At', 'Kind', 'Snippet'],
      X.unresolved.map((u) => ({ key: [u.file, u.line, u.kind], cells: [`${u.file}:${u.line}`, u.kind, codeSpan(u.snippet)], score: 2, paths: [] })));
  }
  for (const d of docs.values()) d.sections.sort((a, b) => cmp(a.label, b.label));
  return docs;
}
const withHeader = (body) => `${FACTS_MARK}${sha12(body)} -->\n> Generated by structure-map scan.mjs, do not edit; notes go in domains.md.\n\n${body}`;
export function renderDoc(d, preface) {
  const lines = [`# ${d.title}`, ''];
  if (preface) lines.push(preface, '');
  for (const s of d.sections) {
    lines.push(`## ${s.label}`, '');
    for (const t of s.tables) {
      if (s.tables.length > 1 || t.title) lines.push(`### ${t.title} (${t.rows.length})`, '');
      lines.push('| ' + t.headers.join(' | ') + ' |', '|' + t.headers.map(() => '---').join('|') + '|');
      for (const r of t.rows) lines.push('| ' + r.cells.map(cell).join(' | ') + ' |');
      lines.push('');
    }
  }
  return withHeader(lines.join('\n').replace(/\n+$/, '\n'));
}
const MIN_PART_ROWS = 8;
const partSafe = (x) => String(x).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+(?=.)/, '') || '_';
function subsetDoc(d, set, title) {
  return { name: d.name, title, sections: d.sections.map((s) => ({ label: s.label, tables: s.tables.map((t) => ({ ...t, rows: t.rows.filter((r) => set.has(r)) })).filter((t) => t.rows.length) })).filter((s) => s.tables.length) };
}
// Deterministic split by path prefix. Groups too small to stand alone are packed in sorted order.
function partition(rows, depth, prefix, th, measure) {
  if (measure(rows) <= th) return [{ segs: prefix, rows }];
  const groups = new Map();
  for (const r of rows) { const k = r.g[depth] == null ? null : String(r.g[depth]); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const keys = [...groups.keys()].filter((k) => k !== null).sort(cmp);
  if (!keys.length) return [{ segs: prefix, rows, oversized: true }];
  if (keys.length === 1 && !groups.has(null)) return partition(rows, depth + 1, [...prefix, keys[0]], th, measure);
  const out = []; const small = groups.has(null) ? [['', groups.get(null)]] : [];
  for (const k of keys) { const rs = groups.get(k); if (rs.length >= MIN_PART_ROWS || measure(rs) > th) out.push(...partition(rs, depth + 1, [...prefix, k], th, measure)); else small.push([k, rs]); }
  let cur = null;
  const flush = () => { if (!cur) return; const name = cur.keys.length > 1 ? `${cur.keys[0]}..${cur.keys[cur.keys.length - 1]}` : cur.keys[0]; out.push({ segs: [...prefix, name], rows: cur.rows, oversized: measure(cur.rows) > th }); };
  for (const [k, rs] of small) {
    const label = k === '' ? '_root' : k;
    if (cur && measure([...cur.rows, ...rs]) <= th) { cur.rows.push(...rs); cur.keys.push(label); continue; }
    flush(); cur = { keys: [label], rows: [...rs] };
  }
  flush();
  return out;
}
export function splitDocs(docs, threshold) {
  const texts = new Map(); const meta = new Map();
  for (const d of [...docs.values()].sort((a, b) => cmp(a.name, b.name))) {
    const full = renderDoc(d);
    if (tokens(full) <= threshold) { texts.set(d.name, full); meta.set(d.name, { parts: 0, tokens: tokens(full), total: tokens(full), oversized: [] }); continue; }
    const rows = d.sections.flatMap((s) => s.tables.flatMap((t) => t.rows));
    const measure = (rs) => tokens(renderDoc(subsetDoc(d, new Set(rs), d.title)));
    const parts = partition(rows, 0, [], threshold, measure);
    const base = d.name.replace(/\.md$/, ''); const used = new Set(); const index = []; const oversized = [];
    for (const pt of parts.map((x) => ({ ...x, name: x.segs.map(partSafe).join('-') || '_all' })).sort((a, b) => cmp(a.name, b.name))) {
      let name = pt.name; let i = 2; while (used.has(name.toLowerCase())) name = `${pt.name}-${i++}`; used.add(name.toLowerCase());
      const txt = renderDoc(subsetDoc(d, new Set(pt.rows), `${d.title}: ${name}`), `Part of [${d.name}](../${d.name}) (split by path prefix).`);
      texts.set(`${base}/${name}.md`, txt);
      if (pt.oversized) oversized.push(`${base}/${name}.md`);
      index.push(`| [${name}](${base}/${name}.md) | ${pt.rows.length} | ${tokens(txt)} | ${pt.oversized ? 'over threshold, cannot split further' : ''} |`);
    }
    const body = [`# ${d.title} (index)`, '', `${rows.length} entries split into ${parts.length} parts by path prefix (threshold ~${threshold} tokens per file). Every entry is listed exactly once.`, '', '| Part | Entries | ~Tokens | Note |', '|---|---|---|---|', ...index, ''].join('\n');
    const idx = withHeader(body); texts.set(d.name, idx);
    let total = tokens(idx); for (const [k, v] of texts) if (k.startsWith(base + '/')) total += tokens(v);
    meta.set(d.name, { parts: parts.length, tokens: tokens(idx), total, oversized });
  }
  return { texts, meta };
}

// ---------------------------------------------------------------------------
// hub, domains, coverage
// ---------------------------------------------------------------------------
function renderHubBlock(results, texts, linkBase, counts, meta) {
  const L = [BEGIN, '<!-- owned by structure-map scan.mjs: regenerated on every run; edit outside the markers -->', '', '## Project map (generated)', ''];
  L.push(`| Screens | Routes | Tables | Services | Test files | Unresolved |`, '|---|---|---|---|---|---|');
  L.push(`| ${counts.screens} | ${counts.routes} | ${counts.tables} | ${counts.services} | ${counts.tests} | ${counts.unresolved} |`, '');
  L.push('### Sub-projects', '');
  for (const { P, X } of results) {
    L.push(`- \`${P.label}\` (${P.files.length} files): ${stackLine(P)}`);
    const c = [`screens ${X.screens.length}`, `routes ${X.routes.length}`, `events/ipc ${X.events.length}`, `tables ${X.tables.length}`, `services ${X.services.length}`, `tests ${X.tests.reduce((s, t) => s + t.n, 0)}`, `entry points ${X.entries.length}`, `unresolved ${X.unresolved.length}`];
    L.push(`  - ${c.join(', ')}`);
  }
  L.push('', '### Detail files', '', 'Split files are an index that links to parts; read only the parts you need.', '', '| File | ~Tokens (this file) | Parts | ~Tokens (with parts) |', '|---|---|---|---|');
  for (const name of GENERATED) if (texts.has(name)) { const m = meta.get(name); L.push(`| [${name}](${linkBase}${name}) | ${m.tokens} | ${m.parts || '-'} | ${m.total} |`); }
  L.push(`| [domains.md](${linkBase}domains.md) | (hand-written) | - | - |`, '', END);
  return L.join('\n');
}
const DOMAINS_TEMPLATE = `# Domains and notes

<!-- Hand-written (by a person or an LLM). structure-map scan.mjs creates this file once and never rewrites it. -->

Group the facts from the generated files (screens.md, api-routes.md, db-tables.md, services.md) into feature domains.
For each domain add a \`## <Domain>\` heading, a one-line purpose, and the repo-relative paths that belong to it
(a directory path ending in a slash covers everything below it). The scanner reports facts paths not mentioned here
as "uncovered" and paths mentioned here that no longer exist as "gone".
`;
export function coverage(results, domainsText, fileSet, root) {
  const facts = new Set();
  for (const { X } of results) for (const arr of [X.screens, X.routes, X.tables, X.services, X.events]) for (const e of arr) facts.add(e.file);
  const text = domainsText || '';
  const covered = (p) => { if (text.includes(p)) return true; const segs = p.split('/'); for (let i = segs.length - 1; i > 0; i--) if (text.includes(segs.slice(0, i).join('/') + '/')) return true; return false; };
  const uncovered = [...facts].filter((p) => !covered(p)).sort(cmp);
  const gone = new Set(); const re = /(?:^|[\s`'"(\[|])((?:[\w@.()[\]+-]+\/)+[\w@.()[\]+-]*)/g; let m;
  const dirSet = new Set(); for (const f of fileSet) { const s = f.split('/'); for (let i = 1; i < s.length; i++) dirSet.add(s.slice(0, i).join('/')); }
  while ((m = re.exec(text))) {
    let p = m[1].replace(/[.,:;)\]]+$/, ''); if (!p || p.startsWith('/') || /:\/\//.test(text.slice(Math.max(0, m.index - 10), m.index + 3)) || !/[\w]/.test(p)) continue;
    p = p.replace(/:\d+$/, ''); const q = p.replace(/\/$/, '');
    if (fileSet.has(q) || dirSet.has(q) || fs.existsSync(path.join(root, q))) continue;
    // prose like read/write or client/server is not a path: require code/link context or a known first segment
    const before = text[m.index + m[0].length - m[1].length - 1] || '';
    const first = q.split('/')[0];
    if (before !== '`' && before !== '(' && !dirSet.has(first) && !fileSet.has(first)) continue;
    gone.add(p);
  }
  return { uncovered, gone: [...gone].sort(cmp) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const o = { root: '.', out: 'docs/structure', hub: 'STRUCTURE.md', check: false, budget: 3500, quiet: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const [k, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const val = () => (inline != null ? inline : argv[++i]);
    if (k === '--root') o.root = val(); else if (k === '--out') o.out = val(); else if (k === '--hub') o.hub = val();
    else if (k === '--budget' || k === '--split') o.budget = Number(val()); else if (k === '--check') o.check = true;
    else if (k === '--quiet') o.quiet = true; else if (k === '--json') o.json = true;
    else if (k === '--help' || k === '-h') o.help = true;
    else if (k === '--hook') o.hook = true; else if (k === '--detect') o.detect = true; else if (k === '--migrate') o.migrate = true;
    else throw new Error('unknown argument: ' + a);
  }
  if (!Number.isFinite(o.budget) || o.budget <= 0) throw new Error('--budget must be a positive number');
  return o;
}
export function run(opts) {
  const t0 = Date.now();
  const root = fs.realpathSync(path.resolve(opts.root));
  const outDir = realish(path.resolve(root, opts.out));
  const hubPath = realish(path.resolve(root, opts.hub));
  const relIn = (p) => { const r = toPosix(path.relative(root, p)); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : null; };
  const exclude = [relIn(outDir), relIn(hubPath)].filter(Boolean);
  const res = scan(root, { exclude });
  const docs = buildDocs(res.results);
  const { texts, meta } = splitDocs(docs, opts.budget);
  const counts = { screens: 0, routes: 0, tables: 0, services: 0, tests: 0, unresolved: 0, entries: 0 };
  for (const { X } of res.results) { counts.screens += X.screens.length; counts.routes += X.routes.length; counts.tables += X.tables.length; counts.services += X.services.length; counts.tests += X.tests.reduce((s, t) => s + t.n, 0); counts.unresolved += X.unresolved.length; counts.entries += X.entries.length; }
  let linkBase = toPosix(path.relative(path.dirname(hubPath), outDir)); linkBase = linkBase ? linkBase + '/' : '';
  const block = renderHubBlock(res.results, texts, linkBase, counts, meta);
  // planned writes
  const plan = []; // {path, content|null(delete), label}
  const isGen = (p) => { try { return fs.readFileSync(p, 'utf8').startsWith(FACTS_MARK); } catch { return false; } };
  for (const [name, content] of texts) plan.push({ path: path.join(outDir, ...name.split('/')), content, label: name });
  const partDirs = [];
  for (const name of GENERATED) {
    const p = path.join(outDir, name);
    if (!texts.has(name) && fs.existsSync(p) && isGen(p)) plan.push({ path: p, content: null, label: name + ' (now empty, remove)' });
    const base = name.replace(/\.md$/, ''); const dir = path.join(outDir, base);
    let ents = []; try { ents = fs.readdirSync(dir).sort(cmp); } catch { continue; }
    partDirs.push(dir);
    for (const f of ents) if (f.endsWith('.md') && !texts.has(`${base}/${f}`) && isGen(path.join(dir, f))) plan.push({ path: path.join(dir, f), content: null, label: `${base}/${f} (stale part, remove)` });
  }
  let hubOld = null; try { hubOld = fs.readFileSync(hubPath, 'utf8'); } catch { /* missing */ }
  let hubNew;
  if (hubOld == null) hubNew = `# Project structure\n\n${block}\n\n## Domains and notes\n\nSee [domains.md](${linkBase}domains.md) for feature domains and notes (hand-written).\n`;
  else {
    const a = hubOld.indexOf(BEGIN); const b = hubOld.indexOf(END, a + 1);
    if (a >= 0 && b > a) hubNew = hubOld.slice(0, a) + block + hubOld.slice(b + END.length);
    else hubNew = hubOld + (hubOld.endsWith('\n') || !hubOld ? '' : '\n') + '\n' + block + '\n';
  }
  plan.push({ path: hubPath, content: hubNew, label: toPosix(relIn(hubPath) || path.basename(hubPath)) });
  const domainsPath = path.join(outDir, 'domains.md');
  const domainsExists = fs.existsSync(domainsPath);
  if (!domainsExists) plan.push({ path: domainsPath, content: DOMAINS_TEMPLATE, label: 'domains.md (create once)' });
  const stale = []; const written = []; const unchanged = [];
  for (const w of plan) {
    let cur = null; try { cur = fs.readFileSync(w.path, 'utf8'); } catch { /* missing */ }
    if (w.content === null ? cur !== null : cur !== w.content) stale.push(w);
    else unchanged.push(w);
  }
  if (!opts.check) {
    for (const w of stale) {
      if (w.content === null) fs.unlinkSync(w.path);
      else { fs.mkdirSync(path.dirname(w.path), { recursive: true }); fs.writeFileSync(w.path, w.content); }
      written.push(w.label);
    }
    for (const dir of partDirs) { try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* keep */ } }
  }
  const domainsText = domainsExists ? fs.readFileSync(domainsPath, 'utf8') : (opts.check ? '' : DOMAINS_TEMPLATE);
  const cov = coverage(res.results, domainsText, res.fileSet, root);
  const totalTokens = [...texts.values()].reduce((s, t) => s + tokens(t), 0);
  const summary = {
    root: '.', mode: res.info.mode, files: res.info.files.length, skipped: { ...res.info.skipped, ...res.warnings },
    projects: res.results.map(({ P, X }) => ({ dir: P.label, stack: stackLine(P), screens: X.screens.length, routes: X.routes.length, tables: X.tables.length, services: X.services.length, tests: X.tests.reduce((s, t) => s + t.n, 0), events: X.events.length, components: X.components.length, entries: X.entries.length, unresolved: X.unresolved.length })),
    counts, tokens: { total: totalTokens, splitThreshold: opts.budget, split: Object.fromEntries([...meta.entries()].filter(([, m]) => m.parts).map(([k, m]) => [k, m.parts])), oversizedParts: [...meta.values()].flatMap((m) => m.oversized), perFile: Object.fromEntries([...meta.entries()].map(([k, m]) => [k, m.total])) },
    check: opts.check, stale: stale.map((w) => w.label), written, unchanged: unchanged.map((w) => w.label),
    uncovered: cov.uncovered, gone: cov.gone, elapsedMs: Date.now() - t0,
  };
  summary.exitCode = opts.check && stale.length ? 1 : 0;
  return summary;
}
// ---------------------------------------------------------------------------
// legacy detection, migration, hook mode
// ---------------------------------------------------------------------------
export function detectLegacy(root, out = 'docs/structure', hub = 'STRUCTURE.md') {
  const files = []; const hubP = path.resolve(root, hub); const outDir = path.resolve(root, out);
  try { if (fs.existsSync(hubP) && !fs.readFileSync(hubP, 'utf8').includes(BEGIN)) files.push(toPosix(path.relative(root, hubP))); } catch { /* unreadable */ }
  for (const n of ['screens.md', 'api-routes.md', 'db-tables.md']) {
    const p = path.join(outDir, n);
    try { if (fs.existsSync(p) && !fs.readFileSync(p, 'utf8').startsWith(FACTS_MARK)) files.push(toPosix(path.relative(root, p))); } catch { /* unreadable */ }
  }
  return { legacy: files.length > 0, files };
}
// Backs up every legacy file into <out>/.legacy/ (verified byte-equal) before anything is overwritten.
export function migrate(opts) {
  const root = fs.realpathSync(path.resolve(opts.root));
  const det = detectLegacy(root, opts.out, opts.hub);
  if (!det.legacy) return { ...run(opts), migrated: false, legacyFiles: [], backups: [] };
  const bdir = path.join(path.resolve(root, opts.out), '.legacy'); fs.mkdirSync(bdir, { recursive: true });
  const backups = [];
  for (const rel of det.files) {
    const src = path.join(root, rel); const data = fs.readFileSync(src);
    let dst = path.join(bdir, rel.replace(/\//g, '__')); let i = 2;
    while (fs.existsSync(dst) && !fs.readFileSync(dst).equals(data)) dst = path.join(bdir, rel.replace(/\//g, '__') + '.' + i++);
    if (!fs.existsSync(dst)) fs.writeFileSync(dst, data);
    if (!fs.readFileSync(dst).equals(data)) throw new Error('backup verification failed for ' + rel);
    backups.push(toPosix(path.relative(root, dst)));
  }
  const hubRel = toPosix(path.relative(root, path.resolve(root, opts.hub)));
  if (det.files.includes(hubRel)) fs.unlinkSync(path.join(root, hubRel)); // old hub content is in the backup; a fresh hub is written
  return { ...run(opts), migrated: true, legacyFiles: det.files, backups: backups.sort(cmp) };
}
function findHookRoot(start) {
  let d = path.resolve(start);
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(path.join(d, 'STRUCTURE.md'))) return d;
    if (fs.existsSync(path.join(d, '.git'))) return null;
    const p = path.dirname(d); if (p === d) return null; d = p;
  }
  return null;
}
// Hook mode: never creates a map, never blocks, prints at most one line (SessionStart only).
export function hook(stdinText, now = Date.now()) {
  let j = {}; try { j = JSON.parse(stdinText || '{}'); } catch { /* ignore */ }
  const ev = j.hook_event_name || ''; const root = findHookRoot(j.cwd || process.cwd());
  if (!root) return '';
  const det = detectLegacy(root);
  if (det.legacy) return ev === 'SessionStart' ? 'structure-map: old-style STRUCTURE.md found; run /structure-map:structure-map migrate to convert it' : '';
  if (ev === 'Stop') {
    const st = path.join(os.tmpdir(), `structure-map-${sha12(fs.realpathSync(root))}.json`);
    try { if (now - JSON.parse(fs.readFileSync(st, 'utf8')).t < 30000) return ''; } catch { /* no state yet */ }
    try { fs.writeFileSync(st, JSON.stringify({ t: now })); } catch { /* ignore */ }
  }
  const s = run({ root, out: 'docs/structure', hub: 'STRUCTURE.md', check: false, budget: 3500, quiet: true, json: false });
  const n = s.uncovered.length + s.gone.length;
  return ev === 'SessionStart' && n > 0 ? `structure-map: ${n} files are not described in docs/structure/domains.md (run /structure-map:structure-map)` : '';
}
function printSummary(s) {
  const L = [];
  L.push(`structure-map: ${s.files} files (${s.mode}), ${s.projects.length} sub-project(s)`);
  for (const p of s.projects) L.push(`  ${p.dir}: ${p.stack}\n    screens ${p.screens}, routes ${p.routes}, events/ipc ${p.events}, tables ${p.tables}, services ${p.services}, tests ${p.tests}, entry points ${p.entries}, unresolved ${p.unresolved}`);
  const sk = s.skipped; L.push(`  skipped: lock ${sk.lock}, binary ${sk.binary}, >1MB ${sk.large}, non-utf8 ${sk.nonUtf8}, nul-bytes ${sk.nulBytes}, legacy-encoding decoded ${sk.legacyDecoded}, minified ${sk.minified}, read errors ${sk.readErrors}`);
  L.push(`  tokens: ~${s.tokens.total} total, split threshold ${s.tokens.splitThreshold}/file: ` + Object.entries(s.tokens.perFile).map(([k, v]) => `${k} ${v}${s.tokens.split[k] ? ` (${s.tokens.split[k]} parts)` : ''}`).join(', '));
  if (s.tokens.oversizedParts.length) L.push(`  parts over threshold (cannot split further): ${s.tokens.oversizedParts.join(', ')}`);
  if (s.check) L.push(s.stale.length ? `  STALE (${s.stale.length}): ${s.stale.join(', ')}` : '  fresh: nothing to update');
  else L.push(`  written ${s.written.length}${s.written.length ? ' (' + s.written.join(', ') + ')' : ''}, unchanged ${s.unchanged.length}`);
  L.push(`  domains.md: uncovered ${s.uncovered.length}, gone ${s.gone.length}`);
  for (const u of s.uncovered.slice(0, 40)) L.push(`    uncovered: ${u}`);
  if (s.uncovered.length > 40) L.push(`    ... ${s.uncovered.length - 40} more uncovered (use --json for all)`);
  for (const g of s.gone) L.push(`    gone: ${g}`);
  L.push(`  unresolved ${s.counts.unresolved}, elapsed ${s.elapsedMs} ms`);
  return L.join('\n');
}
const HELP = `usage: node scan.mjs [--root DIR=.] [--out DIR=docs/structure] [--hub FILE=STRUCTURE.md] [--check] [--budget TOKENS=3500] [--quiet] [--json]
  --budget (alias --split): per-file token threshold; larger detail files become an index plus parts in <name>/.
  --out and --hub are resolved relative to --root unless absolute.
  --check   write nothing; exit 1 and list stale files if generated output differs from disk.
  --detect  print JSON {legacy, files} for an old-style (pre-1.0) STRUCTURE.md / detail files.
  --migrate back up legacy files to <out>/.legacy/, then write the new format.
  --hook    Claude Code hook mode (reads hook JSON on stdin; prints at most one line; always exits 0).`;
export function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { process.stderr.write(e.message + '\n' + HELP + '\n'); return 2; }
  if (opts.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (opts.hook) {
    try { let t = ''; try { t = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ } const line = hook(t); if (line) process.stdout.write(line + '\n'); } catch { /* never fail a session */ }
    return 0;
  }
  if (opts.detect) { process.stdout.write(JSON.stringify(detectLegacy(fs.realpathSync(path.resolve(opts.root)), opts.out, opts.hub), null, 2) + '\n'); return 0; }
  if (opts.migrate) { const m = migrate(opts); process.stdout.write((opts.json ? JSON.stringify(m, null, 2) : `migrated: ${m.migrated}; backups: ${m.backups.join(', ') || 'none'}\n` + printSummary(m)) + '\n'); return 0; }
  const det = detectLegacy(fs.realpathSync(path.resolve(opts.root)), opts.out, opts.hub);
  if (det.legacy && !opts.check) { // never overwrite old hand-written files without a backup
    const msg = { legacy: true, files: det.files, error: 'old-style structure files found; run with --migrate (backs them up to <out>/.legacy/ first)' };
    process.stdout.write((opts.json ? JSON.stringify(msg, null, 2) : `structure-map: ${msg.error}: ${det.files.join(', ')}`) + '\n');
    return 3;
  }
  const s = run(opts); s.legacy = det.legacy;
  if (opts.json) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
  else if (!opts.quiet) process.stdout.write(printSummary(s) + '\n');
  else if (s.exitCode) process.stdout.write('stale: ' + s.stale.join(', ') + '\n');
  return s.exitCode;
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); } catch { return false; }
}
if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write('structure-map: ' + (e && e.stack || e) + '\n'); process.exitCode = 2; }
}
