// Video Studio panel: Brainstorm -> Script & B-roll -> Gameplay finder.
//
// This page is only the UI. The work (DeepSeek calls, YouTube search, yt-dlp downloads,
// project folders) runs in the kikis-shorts-tool server on the editor's own PC at
// http://127.0.0.1:8000/api/studio/* - the DeepSeek/YouTube keys stay in that tool's .env
// and files land on that machine. On any other device the panel still shows and edits
// everything stored in Firestore; engine actions just report "PC engine offline".
//
// Storage (no new collection, no rule change):
//   pipeline/<Idea row>.studio = { root, scriptJson, brollJson, docId, docUrl, updatedAt }
//     scriptJson/brollJson are JSON *strings* because Firestore rejects nested arrays,
//     which the script's citations ([[sourceKey, note], ...]) use.
//   config/brainstorm = { ideas: [{ id, idea, notes, pitchJson, at }] }
// index.html exposes window.pipelineApp (db, auth, Firestore helpers, rows) for this file.

const ENGINE_KEY = 'studio_engine_url_v1';
let ENGINE = (() => { try { return localStorage.getItem(ENGINE_KEY) || 'http://127.0.0.1:8000'; } catch (e) { return 'http://127.0.0.1:8000'; } })();
const DEFAULT_STYLE = 'https://www.youtube.com/watch?v=HfFkmE_t4SA';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const S = {
  open: false, tab: 'script', engine: null, engineErr: '', transcripts: null,
  projectId: null, busy: {}, msg: {}, collapsed: {}, showSources: {}, picks: {}, previews: {},
  bs: { current: null, footage: null, ideas: [], loaded: false },
  finder: { results: null, picks: {} },
  downloads: [], dlTimer: null, drive: null,
};

const P = () => window.pipelineApp;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDur = (s) => { s = +s || 0; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };

// ------------------------------------------------------------------ engine API
async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(ENGINE + path, opts); }
  catch (e) { S.engine = null; renderHead(); throw new Error('PC engine offline - start the shorts tool on this PC (port 8000).'); }
  if (!r.ok) {
    let d = ''; try { d = (await r.json()).detail; } catch (e) {}
    throw new Error(d || ('HTTP ' + r.status));
  }
  return r.json();
}

async function runJob(path, body, key) {
  let j = await api(path, body);
  while (j.status === 'running') {
    if (key) { S.msg[key] = (j.message || 'Working...') + (j.progress ? ` (${j.progress}%)` : ''); renderBody(); }
    await sleep(1200);
    j = await api('/api/studio/jobs/' + j.id);
  }
  if (j.status === 'error') throw new Error(j.error);
  return j.result;
}

async function checkEngine() {
  try { S.engine = await api('/api/studio/health'); S.engineErr = ''; }
  catch (e) { S.engine = null; S.engineErr = e.message; }
  renderHead();
}

// Wraps a button action: busy flag, message line, error shown inline (never a silent fail).
async function act(key, fn) {
  if (S.busy[key]) return;
  S.busy[key] = true; S.msg[key] = 'Working...'; renderBody();
  try { const out = await fn(); S.msg[key] = typeof out === 'string' ? out : ''; }
  catch (e) { S.msg[key] = '⚠ ' + e.message; console.error('[studio]', key, e); }
  finally { S.busy[key] = false; renderBody(); }
}

// ------------------------------------------------------------------ Firestore helpers
const rows = () => (P() ? P().getRows() : []);
const ideaRows = () => rows().filter((r) => r.status === 'Idea' && !r.pendingDelete);
const project = () => ideaRows().find((r) => r.id === S.projectId) || null;
const studioOf = (row) => (row && row.studio) || {};
function scriptOf(row) { try { return JSON.parse(studioOf(row).scriptJson || 'null'); } catch (e) { return null; } }
function brollOf(row) { try { return JSON.parse(studioOf(row).brollJson || '{}') || {}; } catch (e) { return {}; } }

function saveStudio(row, patch) {
  const { db, doc, updateDoc } = P();
  const data = { 'studio.updatedAt': Date.now() };
  Object.keys(patch).forEach((k) => { data['studio.' + k] = patch[k]; });
  return updateDoc(doc(db, 'pipeline', row.id), data);
}
const saveScript = (row, script) => saveStudio(row, { scriptJson: JSON.stringify(script) });

// ------------------------------------------------------------------ Google Docs (final product)
async function driveToken() {
  if (S.drive && S.drive.exp > Date.now()) return S.drive.token;
  const { auth, GoogleAuthProvider, reauthenticateWithPopup } = P();
  const provider = new GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  const res = await reauthenticateWithPopup(auth.currentUser, provider);
  const cred = GoogleAuthProvider.credentialFromResult(res);
  if (!cred || !cred.accessToken) throw new Error('Google did not return Drive access.');
  S.drive = { token: cred.accessToken, exp: Date.now() + 50 * 60 * 1000 };
  return S.drive.token;
}

function scriptToDocHtml(sc) {
  const m = sc.meta || {};
  const total = (sc.sections || []).reduce((a, s) => a + (+s.minutes || 0), 0);
  let h = `<h1>${esc(m.title || 'Script')}</h1>`;
  const meta = [m.tiers && m.tiers.length ? 'Tiers: ' + m.tiers.join(' / ') : '', total ? `~${Math.round(total)} min guided` : ''].filter(Boolean).join('   ·   ');
  if (meta) h += `<p style="color:#777777">${esc(meta)}</p>`;
  (sc.sections || []).forEach((s, i) => {
    h += `<h2>${i + 1}. ${esc(s.title)}</h2>`;
    if (s.subtitle) h += `<p style="color:#777777"><i>${esc(s.subtitle)}</i></p>`;
    if ((s.points || []).length) h += '<ul>' + s.points.map((p) => `<li>${esc(p.text)}</li>`).join('') + '</ul>';
    if ((s.prompts || []).length) h += '<p><b>Your take</b></p><ul>' + s.prompts.map((q) => `<li>${esc(q)}</li>`).join('') + '</ul>';
    if ((s.deeper || []).length) h += '<p style="color:#777777"><b>If you want more</b></p><ul>' + s.deeper.map((d) => `<li>${esc(d.text)}</li>`).join('') + '</ul>';
  });
  return `<html><body>${h}</body></html>`;
}

async function createGoogleDoc(row, sc) {
  const token = await driveToken();
  const boundary = 'studio' + Math.random().toString(36).slice(2);
  const meta = { name: (sc.meta && sc.meta.title) || row.title, mimeType: 'application/vnd.google-apps.document' };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${scriptToDocHtml(sc)}\r\n--${boundary}--`;
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
  });
  if (!r.ok) {
    const t = await r.text();
    if (/has not been used|is disabled/i.test(t)) throw new Error('Google Drive API is not enabled for this Firebase project - see the note in CLAUDE.md (one-time setup).');
    throw new Error('Drive upload failed: ' + t.slice(0, 200));
  }
  const f = await r.json();
  await saveStudio(row, { docId: f.id, docUrl: f.webViewLink || `https://docs.google.com/document/d/${f.id}/edit` });
  window.open(f.webViewLink, '_blank');
  return 'Google Doc created and linked.';
}

function docIdFrom(s) { const m = String(s || '').match(/\/d\/([A-Za-z0-9_-]{20,})/); return m ? m[1] : (/^[A-Za-z0-9_-]{20,}$/.test(String(s || '').trim()) ? String(s).trim() : null); }

async function docMarkdown(row) {
  const st = studioOf(row);
  if (!st.docId) throw new Error('No Google Doc linked yet.');
  // Docs this page created are readable with the drive.file token; any other linked Doc
  // falls back to the engine reading its "anyone with the link" export.
  try {
    const token = await driveToken();
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${st.docId}/export?mimeType=text/markdown`, { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) return r.text();
  } catch (e) { /* fall through */ }
  return (await api('/api/studio/doc/export?doc=' + encodeURIComponent(st.docId))).markdown;
}

// Pull Ghazzy-facing edits from the Doc back into the structured copy the tool reads.
// Bullets whose text didn't change keep their citations; edited/new bullets lose them
// (marked "edited in Doc"). Section ids, b-roll needs and windows are kept by position.
function mergeDocMarkdown(sc, md) {
  const clean = (t) => t.replace(/\\([.\-*_#()[\]!+])/g, '$1').replace(/\*\*/g, '').replace(/^_+|_+$/g, '').trim();
  const sections = []; let cur = null, bucket = 'points';
  md.split(/\r?\n/).forEach((line) => {
    const h2 = line.match(/^##\s+(?:\d+\\?\.\s*)?(.*)$/);
    if (h2 && !/^###/.test(line)) { cur = { title: clean(h2[1]), points: [], prompts: [], deeper: [] }; sections.push(cur); bucket = 'points'; return; }
    if (!cur) return;
    const t = clean(line.replace(/^\s*[*-]\s+/, ''));
    if (/^\s*$/.test(line)) return;
    if (/^your take$/i.test(t)) { bucket = 'prompts'; return; }
    if (/^if you want more$/i.test(t)) { bucket = 'deeper'; return; }
    if (/^\s*[*-]\s+/.test(line)) cur[bucket].push(t);
    else if (!cur.points.length && !cur.subtitle) cur.subtitle = t.replace(/^_|_$/g, '');
  });
  if (!sections.length) throw new Error("Couldn't find any '## ' sections in the Doc.");
  const old = sc.sections || [];
  const keep = (oldItems, texts) => texts.map((t) => {
    const o = (oldItems || []).find((x) => x.text === t);
    return o ? o : { text: t, src: [], edited: true };
  });
  sc.sections = sections.map((ns, i) => {
    const os = old.find((o) => o.title === ns.title) || old[i] || {};
    return Object.assign({}, os, {
      id: os.id || 's' + (i + 1), title: ns.title, subtitle: ns.subtitle || null,
      points: keep(os.points, ns.points), prompts: ns.prompts, deeper: keep(os.deeper, ns.deeper),
      broll: os.broll || [], broll_window: os.broll_window || null, minutes: os.minutes,
    });
  });
  return sc;
}

// ------------------------------------------------------------------ downloads polling
async function pollDownloads() {
  const row = project(); const root = studioOf(row).root;
  if (!root || !S.engine) return;
  try { S.downloads = await api('/api/studio/downloads?root=' + encodeURIComponent(root)); } catch (e) { return; }
  renderBody();
  const active = S.downloads.some((d) => d.status === 'queued' || d.status === 'downloading');
  clearTimeout(S.dlTimer);
  if (active && S.open) S.dlTimer = setTimeout(pollDownloads, 2000);
}

async function queueDownloads(root, items) {
  if (!root) throw new Error('Set the project folder first.');
  if (!items.length) throw new Error('Nothing selected.');
  const clip = Math.round((+($('#stClipMin') || {}).value || 4) * 60);
  const full = !!($('#stFull') || {}).checked;
  await api('/api/studio/download', { root, items, clip_seconds: clip, full });
  pollDownloads();
  return `Queued ${items.length} download${items.length > 1 ? 's' : ''}.`;
}

function folderFor(sc, sectionId) {
  const i = (sc.sections || []).findIndex((s) => s.id === sectionId);
  if (i < 0) return 'Extra';
  const t = sc.sections[i].title || sectionId;
  return String(i + 1).padStart(2, '0') + '_' + t.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 48);
}

// ------------------------------------------------------------------ rendering
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

function renderHead() {
  const h = $('#stHead'); if (!h) return;
  const tab = (id, label) => `<button class="st-tab ${S.tab === id ? 'on' : ''}" data-act="tab" data-v="${id}">${label}</button>`;
  const eng = S.engine
    ? `<span class="st-pill ok" title="DeepSeek: ${S.engine.llm_ready ? 'ready' : 'NO KEY'} · YouTube API: ${S.engine.youtube_api ? 'yes' : 'no (yt-dlp search)'} · yt-dlp: ${S.engine.ytdlp ? 'yes' : 'MISSING'}">● PC engine: ${esc(S.engine.machine)}</span>`
    : `<span class="st-pill off" title="${esc(S.engineErr)}">● PC engine offline</span> <button class="secondary st-sm" data-act="engine-help">?</button>`;
  h.innerHTML = `${tab('brainstorm', '🧠 Brainstorm')}${tab('script', '📝 Script & B-roll')}${tab('finder', '🎮 Gameplay finder')}
    <span class="spacer"></span>${eng}
    <button class="secondary st-sm" data-act="engine-retry" title="Re-check">↻</button>
    <button class="secondary st-sm" data-act="engine-url" title="Engine address: ${esc(ENGINE)}">⚙</button>
    <button class="secondary st-sm" data-act="close">✕</button>`;
}

function renderBody() {
  const b = $('#stBody'); if (!b) return;
  const keepScroll = window.scrollY;
  const focused = document.activeElement && document.activeElement.id;
  const sel = focused && document.activeElement.selectionStart;
  // Re-renders happen while you type (download progress, Firestore updates, a button's
  // busy state) - carry typed values across unless we just switched project/idea.
  const saved = {}, checkedT = new Set();
  if (!S.resetInputs) {
    b.querySelectorAll('input[id],textarea[id]').forEach((x) => { saved[x.id] = x.type === 'checkbox' ? x.checked : x.value; });
    b.querySelectorAll('.stT:checked').forEach((x) => checkedT.add(x.value));
  }
  S.resetInputs = false;
  if (S.tab === 'brainstorm') b.innerHTML = viewBrainstorm();
  else if (S.tab === 'finder') b.innerHTML = viewFinder();
  else b.innerHTML = viewScript();
  Object.keys(saved).forEach((id) => { const x = document.getElementById(id); if (!x) return; if (x.type === 'checkbox') x.checked = saved[id]; else x.value = saved[id]; });
  b.querySelectorAll('.stT').forEach((x) => { if (checkedT.has(x.value)) x.checked = true; });
  if (focused && $('#' + focused)) { const f = $('#' + focused); f.focus(); try { if (sel != null) f.setSelectionRange(sel, sel); } catch (e) {} }
  window.scrollTo(0, keepScroll);
}

const msgLine = (key) => S.msg[key] ? `<div class="st-msg ${S.msg[key].startsWith('⚠') ? 'err' : ''}">${esc(S.msg[key])}</div>` : '';
const btn = (act, label, cls = '', extra = '') => `<button class="${cls}" data-act="${act}" ${extra} ${S.busy[act] ? 'disabled' : ''}>${S.busy[act] ? '…' : label}</button>`;

// ---- Brainstorm
function viewBrainstorm() {
  const c = S.bs.current;
  const ideas = S.bs.ideas.map((it) => `<div class="st-idea"><a href="#" data-act="bs-load" data-v="${it.id}">${esc(it.idea)}</a>
     <span class="st-dim">${new Date(it.at).toLocaleDateString()}</span><button class="secondary st-sm" data-act="bs-del" data-v="${it.id}">✕</button></div>`).join('') || '<div class="st-dim">No saved ideas yet.</div>';
  let res = '';
  if (c) {
    const f = c.feasibility || {};
    const already = (c.already_said || []).filter((a) => a.url).map((a) => `<li><a href="${esc(a.url)}" target="_blank">${esc(a.source)} @ ${esc(a.ts)}</a> - ${esc(a.note)}</li>`).join('');
    const foot = S.bs.footage ? '<ul>' + S.bs.footage.map((x) => `<li><b>${esc(x.title)}</b>: ${x.count == null ? '⚠ ' + esc(x.error) : x.count + ' YouTube results'}${x.examples && x.examples.length ? ' <span class="st-dim">(' + esc(x.examples.join(' · ')) + ')</span>' : ''}</li>`).join('') + '</ul>' : '';
    res = `<div class="st-card">
      <div class="st-score"><b>${esc(f.score || '?')}/10</b> <span class="st-bar"><i style="width:${(+f.score || 0) * 10}%"></i></span>
        <span>~${esc(f.minutes || '?')} min · ${f.opinion_driven ? 'opinion-driven ✓' : 'fact-list ✗'}</span></div>
      <p>${esc(f.verdict || '')}</p>
      <h4>Titles</h4><ul>${(c.titles || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <h4>Hook</h4><p>${esc(c.hook || '')}</p>
      <h4>Sample talking points</h4>${(c.outline || []).map((s, i) => `<div class="st-sec"><b>${i + 1}. ${esc(s.title)}</b><ul>${(s.points || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${s.broll ? `<div class="st-dim">🎮 ${esc(s.broll)}</div>` : ''}</div>`).join('')}
      ${(c.risks || []).length ? `<h4>Risks / gaps</h4><ul>${c.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${already ? `<h4>Already said on stream</h4><ul>${already}</ul>` : ''}
      <div class="st-row">${btn('bs-footage', '🎮 Check footage exists', 'secondary')}</div>${msgLine('bs-footage')}${foot}
      <div class="st-row">
        ${['Shorter', 'More controversial angle', 'Different structure', 'More opinion, fewer facts'].map((q) => `<button class="secondary st-sm" data-act="bs-rework" data-v="${esc(q)}">${esc(q)}</button>`).join('')}
        <input id="stBsFollow" placeholder="Or tell it what to change...">${btn('bs-rework', 'Rework', 'secondary')}
      </div>
      <div class="st-row">${btn('bs-save', '💾 Save idea', 'secondary')} ${btn('bs-promote', '➜ Promote to To-Do project')}</div>${msgLine('bs-save')}${msgLine('bs-promote')}
    </div>`;
  }
  return `<div class="st-cols"><div class="st-main">
      <textarea id="stBsIdea" rows="3" placeholder="Rough idea - e.g. ranking every PoE2 league before 1.0">${esc(c ? c.idea : '')}</textarea>
      <input id="stBsNotes" placeholder="Angle / notes (optional)" value="${esc(c ? c.notes : '')}">
      <div class="st-row">${btn('bs-pitch', '🧠 Pitch it')}</div>${msgLine('bs-pitch')}${msgLine('bs-rework')}${res}
    </div><div class="st-side"><h4>Saved ideas</h4>${ideas}</div></div>`;
}

// ---- Script & B-roll
function viewScript() {
  const list = ideaRows();
  if (!S.projectId && list.length) S.projectId = list[0].id;
  const row = project();
  const opts = list.map((r) => `<option value="${r.id}" ${r.id === S.projectId ? 'selected' : ''}>${esc(r.title)}${r.studio && r.studio.scriptJson ? ' ✎' : ''}</option>`).join('');
  if (!row) return `<div class="st-dim">No To-Do videos yet - add one in To-Do Videos (or promote a brainstorm).</div>`;
  const st = studioOf(row), sc = scriptOf(row);
  const head = `<div class="st-row"><label>Project</label><select id="stProject" data-act="project">${opts}</select></div>
    <div class="st-row"><label>Folder</label><input id="stRoot" placeholder="C:\\-- WORK --\\GHAZZY\\...\\video folder" value="${esc(st.root || '')}">
      ${btn('root-save', 'Save', 'secondary')} ${btn('root-init', '📁 Set up folders', 'secondary')} ${btn('root-open', 'Open', 'secondary')} ${btn('script-load', '⤓ Load script.json', 'secondary')}</div>
    ${msgLine('root-save')}${msgLine('root-init')}${msgLine('root-open')}${msgLine('script-load')}`;
  return head + (sc ? viewScriptLoaded(row, st, sc) : viewGenerate(row));
}

function viewGenerate(row) {
  const ts = S.transcripts;
  const tlist = ts == null ? `<div class="st-dim">${S.engine ? 'Loading transcripts...' : 'Start the PC engine to list cached VOD transcripts.'}</div>`
    : ts.slice().sort((a, b) => (b.streamer === 'GhazzyTV') - (a.streamer === 'GhazzyTV') || (b.date > a.date ? 1 : -1))
      .map((t) => `<label class="st-check"><input type="checkbox" class="stT" value="${esc(t.id)}"> <b>${esc(t.streamer)}</b> ${esc(t.date)} - ${esc(t.title.slice(0, 80))} <span class="st-dim">${t.kb} KB</span></label>`).join('');
  return `<div class="st-card"><h4>Generate the script (DeepSeek)</h4>
    <input id="stGenPrompt" placeholder="What should the video do? e.g. Rank every PoE2 league before 1.0, his opinion first" value="${esc(row.title)}">
    <textarea id="stGenNotes" rows="3" placeholder="Your notes for this video">${esc(row.notes || '')}</textarea>
    <details open><summary>Reference transcripts (cached VODs on this PC)</summary><div class="st-tlist">${tlist}</div></details>
    <textarea id="stGenYt" rows="2" placeholder="YouTube videos to use as sources - one link per line"></textarea>
    <textarea id="stGenStyle" rows="2" placeholder="Ghazzy's past video essays for style - one link per line">${DEFAULT_STYLE}</textarea>
    <textarea id="stGenPaste" rows="2" placeholder="Paste anything else (patch notes, a doc) - optional"></textarea>
    <div class="st-row">${btn('script-gen', '📝 Generate script')}</div>${msgLine('script-gen')}
    <div class="st-dim">Or put a script.json in the project's Script folder and press "Load script.json".</div></div>`;
}

function viewScriptLoaded(row, st, sc) {
  const broll = brollOf(row);
  const sources = sc.sources || {};
  const dlBy = {};
  S.downloads.forEach((d) => { dlBy[d.video_id + '|' + d.folder] = d; dlBy[d.video_id] = dlBy[d.video_id] || d; });
  const selCount = Object.values(S.picks).filter(Boolean).length;
  const docBar = st.docUrl
    ? `<a class="st-btnlink" href="${esc(st.docUrl)}" target="_blank">📄 Open Google Doc</a> ${btn('doc-sync', '⟲ Re-sync from Doc', 'secondary')}`
    : `${btn('doc-create', '📄 Create Google Doc')} <input id="stDocLink" placeholder="...or paste an existing Doc link"> ${btn('doc-link', 'Link', 'secondary')}`;
  const total = (sc.sections || []).reduce((a, s) => a + (+s.minutes || 0), 0);
  let html = `<div class="st-card st-toolbar"><b>${esc((sc.meta && sc.meta.title) || row.title)}</b> <span class="st-dim">${sc.sections.length} sections · ~${Math.round(total)} min</span>
      <span class="spacer"></span>${docBar} ${btn('script-save', '💾 Save to folder', 'secondary')} ${btn('script-reset', 'New script…', 'secondary')}</div>
    ${msgLine('doc-create')}${msgLine('doc-link')}${msgLine('doc-sync')}${msgLine('script-save')}
    <div class="st-card st-toolbar">🎮 <b>B-roll</b>
      <label>clip length <input id="stClipMin" type="number" min="0.5" step="0.5" value="4" style="width:56px"> min</label>
      <label><input id="stFull" type="checkbox"> full videos</label>
      <span class="spacer"></span>${btn('broll-all', '🔎 Find b-roll for every section')} ${btn('dl-selected', `⬇ Download selected (${selCount})`, selCount ? '' : 'secondary')}</div>
    ${msgLine('broll-all')}${msgLine('dl-selected')}`;
  sc.sections.forEach((s, i) => {
    const folder = folderFor(sc, s.id);
    const collapsed = S.collapsed[s.id];
    const results = broll[s.id] || [];
    const nDone = S.downloads.filter((d) => d.folder === folder && (d.status === 'done' || d.status === 'skipped')).length;
    const pt = (p) => {
      const cites = (p.src || []).map((c) => { const so = sources[c[0]] || {}; return `<li><a href="${esc(so.url || '#')}" target="_blank">${esc(so.label || c[0])}</a> - ${esc(c[1])}</li>`; }).join('');
      const cls = p.edited ? 'edited' : (!(p.src || []).length && p.unsourced ? 'unsourced' : '');
      return `<li class="${cls}">${esc(p.text)}${p.edited ? ' <span class="st-tag">edited in Doc</span>' : ''}${S.showSources[s.id] && cites ? `<ul class="st-src">${cites}</ul>` : ''}</li>`;
    };
    html += `<div class="st-section"><div class="st-sechead" data-act="collapse" data-v="${s.id}">${collapsed ? '▸' : '▾'} <b>${i + 1}. ${esc(s.title)}</b>
        ${s.subtitle ? `<span class="st-dim">${esc(s.subtitle)}</span>` : ''}<span class="spacer"></span>
        <span class="st-dim">${s.minutes ? '~' + s.minutes + ' min · ' : ''}${nDone} clip${nDone === 1 ? '' : 's'} in ${esc(folder)}</span></div>`;
    if (!collapsed) {
      html += `<div class="st-secbody"><ul>${(s.points || []).map(pt).join('')}</ul>
        ${(s.prompts || []).length ? `<div class="st-lbl">Your take</div><ul>${s.prompts.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
        ${(s.deeper || []).length ? `<div class="st-lbl st-dim">If you want more</div><ul class="st-dim">${s.deeper.map(pt).join('')}</ul>` : ''}
        <div class="st-row"><button class="secondary st-sm" data-act="sources" data-v="${s.id}">${S.showSources[s.id] ? 'Hide' : 'Show'} sources</button>
          <input id="stRw_${s.id}" placeholder="Rewrite this section... (e.g. punchier, add X)"><button class="secondary st-sm" data-act="rewrite" data-v="${s.id}">Rewrite</button></div>${msgLine('rewrite-' + s.id)}
        <div class="st-needs">🎮 ${(s.broll || []).map((n, k) => `<span class="st-chip">${esc(n)} <a href="#" data-act="need-del" data-v="${s.id}" data-k="${k}">✕</a></span>`).join('')}
          ${s.broll_window ? `<span class="st-dim">uploaded ${esc(s.broll_window[0])} → ${esc(s.broll_window[1])}</span>` : ''}
          <input id="stNeed_${s.id}" placeholder="+ b-roll need" class="st-needin"><button class="secondary st-sm" data-act="need-add" data-v="${s.id}">Add</button>
          <button class="secondary st-sm" data-act="broll-one" data-v="${s.id}">🔎 Find</button></div>${msgLine('broll-' + s.id)}
        ${results.map((r) => resultBlock(r, s.id, folder, dlBy)).join('')}</div>`;
    }
    html += '</div>';
  });
  html += downloadsBlock();
  return html;
}

function cardHtml(c, pickKey, dl, pickMap) {
  const picked = (pickMap || S.picks)[pickKey];
  if (c.source === 'local') {
    return `<div class="st-vid local"><div class="st-thumb local">${c.in_project ? '✔ in project' : '💾 on disk'}</div>
      <div class="st-vinfo"><b>${esc(c.title)}</b><div class="st-dim">${esc(c.channel)}${c.duration ? ' · ' + fmtDur(c.duration) : ''}</div>
      ${c.in_project ? '' : `<label><input type="checkbox" data-act="pick" data-v="${esc(pickKey)}" ${picked ? 'checked' : ''}> copy into project</label>`}</div></div>`;
  }
  const prev = S.previews[pickKey];
  const thumb = prev
    ? `<iframe src="https://www.youtube-nocookie.com/embed/${esc(c.id)}?autoplay=1&start=${Math.round((c.duration || 0) * 0.1)}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
    : `<div class="st-thumb" data-act="preview" data-v="${esc(pickKey)}" style="background-image:url('${esc(c.thumb)}')"><span>▶</span><em>${fmtDur(c.duration)}</em></div>`;
  const state = dl ? `<span class="st-dl ${esc(dl.status)}">${dl.status === 'downloading' ? Math.round(dl.progress) + '%' : esc(dl.status)}</span>` : '';
  return `<div class="st-vid">${thumb}<div class="st-vinfo"><a href="${esc(c.url)}" target="_blank"><b>${esc(c.title)}</b></a>
    <div class="st-dim">${esc(c.channel)} · ${esc(c.published || 'date ?')} · ${c.views ? (c.views / 1000).toFixed(c.views > 1e5 ? 0 : 1) + 'k views' : ''}${c.date_unchecked ? ' · ⚠ date not checked' : ''}</div>
    ${c.why ? `<div class="st-why">${esc(c.why)}</div>` : ''}
    <div class="st-row"><label><input type="checkbox" data-act="pick" data-v="${esc(pickKey)}" ${picked ? 'checked' : ''}> select</label>
      <button class="secondary st-sm" data-act="dl-one" data-v="${esc(pickKey)}">⬇ Download</button>${state}</div></div></div>`;
}

function resultBlock(r, sid, folder, dlBy) {
  const yt = (r.youtube || []).map((c) => cardHtml(c, `${sid}|${r.query}|${c.id}`, dlBy[c.id + '|' + folder])).join('');
  const local = (r.local || []).map((c) => cardHtml(c, `${sid}|${r.query}|${c.id}`, null)).join('');
  return `<div class="st-need"><div class="st-needq">“${esc(r.query)}”${r.error ? ` <span class="st-msg err">⚠ ${esc(r.error)}</span>` : ''}${(r.youtube || [])[0] && r.youtube[0].note ? ` <span class="st-dim">${esc(r.youtube[0].note)}</span>` : ''}</div>
    <div class="st-vids">${local}${yt || (r.error ? '' : '<div class="st-dim">No results.</div>')}</div></div>`;
}

function downloadsBlock() {
  if (!S.downloads.length) return '';
  return `<div class="st-card"><h4>Downloads on this PC</h4>${S.downloads.slice().reverse().map((d) => `<div class="st-dlrow"><span class="st-dl ${esc(d.status)}">${esc(d.status)}${d.status === 'downloading' ? ' ' + Math.round(d.progress) + '%' : ''}</span>
    <b>${esc(d.folder)}</b> ${esc(d.title)} <span class="st-dim">${esc(d.message || '')}${d.error ? ' ⚠ ' + esc(d.error) : ''}</span>
    ${d.status === 'error' ? `<button class="secondary st-sm" data-act="dl-retry" data-v="${esc(d.id)}">↻ Retry</button>` : ''}</div>`).join('')}
    <div class="st-row">${btn('root-open-gameplay', '📂 Open Gameplay folder', 'secondary')}</div></div>`;
}

// ---- Gameplay finder
function viewFinder() {
  const withRoot = ideaRows().filter((r) => studioOf(r).root);
  const opts = withRoot.map((r) => `<option value="${r.id}" ${r.id === S.projectId ? 'selected' : ''}>${esc(r.title)}</option>`).join('');
  const res = S.finder.results;
  const nSel = Object.values(S.finder.picks).filter(Boolean).length;
  return `<div class="st-card"><div class="st-row"><input id="stFq" placeholder="What gameplay? e.g. fate of the vaal temple juiced mapping" style="flex:1">
      <label>from <input id="stFa" type="date"></label><label>to <input id="stFb" type="date"></label>
      <label>max <input id="stFn" type="number" value="8" min="1" max="20" style="width:50px"></label>${btn('find', '🔎 Find')}</div>${msgLine('find')}
    <div class="st-row"><label>Save to project</label><select id="stFproj">${opts || '<option value="">(set a project folder in Script & B-roll first)</option>'}</select>
      <span class="st-dim">→ Gameplay\\Extra</span>
      <label>clip length <input id="stClipMin" type="number" min="0.5" step="0.5" value="4" style="width:56px"> min</label><label><input id="stFull" type="checkbox"> full videos</label>
      <span class="spacer"></span>${btn('find-dl', `⬇ Download selected (${nSel})`, nSel ? '' : 'secondary')}</div>${msgLine('find-dl')}</div>
    ${res ? `<div class="st-vids">${[...(res.local || []), ...(res.youtube || [])].map((c) => cardHtml(c, 'F|' + c.id, null, S.finder.picks)).join('') || '<div class="st-dim">No results.</div>'}</div>` : ''}
    ${downloadsBlock()}`;
}

// ------------------------------------------------------------------ actions
function findCandidate(pickKey) {
  if (pickKey.startsWith('F|')) {
    const id = pickKey.slice(2); const r = S.finder.results || {};
    return [...(r.local || []), ...(r.youtube || [])].find((c) => c.id === id);
  }
  const [sid, query, id] = pickKey.split('|');
  const res = (brollOf(project())[sid] || []).find((r) => r.query === query) || {};
  return [...(res.youtube || []), ...(res.local || [])].find((c) => c.id === id);
}

const handlers = {
  tab: (v) => { S.tab = v; renderHead(); renderBody(); if (v === 'brainstorm') loadIdeas(); },
  close: () => toggle(false),
  'engine-retry': () => { checkEngine().then(() => { loadTranscripts(); pollDownloads(); }); },
  'engine-url': () => { const u = prompt('PC engine address (the shorts tool on this PC):', ENGINE); if (u) { ENGINE = u.replace(/\/$/, ''); try { localStorage.setItem(ENGINE_KEY, ENGINE); } catch (e) {} checkEngine(); } },
  'engine-help': () => alert('This panel needs the shorts tool running on THIS PC (desktop shortcut, port 8000).\n\nChrome may ask "allow this site to access devices on your local network" - click Allow.\n\nOn any other device you can still read and edit scripts; searching and downloading need the PC.'),
  collapse: (v) => { S.collapsed[v] = !S.collapsed[v]; renderBody(); },
  sources: (v) => { S.showSources[v] = !S.showSources[v]; renderBody(); },
  preview: (v) => { S.previews[v] = true; renderBody(); },
  pick: (v, e) => { (v.startsWith('F|') ? S.finder.picks : S.picks)[v] = e.target.checked; renderBody(); },

  'root-save': () => act('root-save', async () => { await saveStudio(project(), { root: $('#stRoot').value.trim() }); return 'Saved.'; }),
  'root-init': () => act('root-init', async () => {
    const root = $('#stRoot').value.trim(); const row = project();
    await saveStudio(row, { root });
    const out = await api('/api/studio/project/init', { root, script: scriptOf(row) });
    return `Folders ready: Gameplay (${Object.keys(out.folders).length} section folders + Extra), Script, Assets.`;
  }),
  'root-open': () => act('root-open', () => api('/api/studio/project/open', { root: $('#stRoot').value.trim() }).then(() => '')),
  'root-open-gameplay': () => act('root-open-gameplay', () => api('/api/studio/project/open', { root: studioOf(project()).root, sub: 'Gameplay' }).then(() => '')),
  'script-load': () => act('script-load', async () => {
    const root = $('#stRoot').value.trim(); const row = project();
    const sc = await api('/api/studio/project/script?root=' + encodeURIComponent(root));
    await saveStudio(row, { root, scriptJson: JSON.stringify(sc) });
    return `Loaded ${sc.sections.length} sections from Script\\script.json.`;
  }),
  'script-save': () => act('script-save', async () => {
    const row = project();
    const p = await api('/api/studio/project/script', { root: studioOf(row).root, script: scriptOf(row) });
    return 'Saved ' + p.path;
  }),
  'script-reset': () => { if (confirm('Clear this script and its b-roll results so you can generate a new one? (The Google Doc and downloaded files are not touched.)')) saveStudio(project(), { scriptJson: null, brollJson: null }).catch(P().onError); },
  'script-gen': () => act('script-gen', async () => {
    const row = project();
    const body = {
      title: row.title, prompt: $('#stGenPrompt').value, notes: $('#stGenNotes').value,
      transcripts: [...document.querySelectorAll('.stT:checked')].map((x) => x.value),
      youtube: $('#stGenYt').value.split(/\s+/).filter(Boolean), style: $('#stGenStyle').value.split(/\s+/).filter(Boolean),
      pasted: $('#stGenPaste').value,
    };
    const sc = await runJob('/api/studio/script/generate', body, 'script-gen');
    await saveScript(row, sc);
    if (studioOf(row).root) await api('/api/studio/project/script', { root: studioOf(row).root, script: sc }).catch(() => {});
    return `Script ready - ${(sc.facts || []).length} facts used.${(sc.source_errors || []).length ? ' Some sources failed: ' + sc.source_errors.join('; ') : ''}`;
  }),
  rewrite: (v) => act('rewrite-' + v, async () => {
    const row = project(); const instr = ($('#stRw_' + v) || {}).value || '';
    const sc = await runJob('/api/studio/script/section', { script: scriptOf(row), section_id: v, instruction: instr }, 'rewrite-' + v);
    await saveScript(row, sc); return 'Rewritten. (Re-create or edit the Google Doc to match.)';
  }),
  'need-add': (v) => { const row = project(); const sc = scriptOf(row); const s = sc.sections.find((x) => x.id === v); const val = ($('#stNeed_' + v).value || '').trim(); if (!val) return; s.broll = [...(s.broll || []), val]; saveScript(row, sc).catch(P().onError); },
  'need-del': (v, e) => { const row = project(); const sc = scriptOf(row); const s = sc.sections.find((x) => x.id === v); s.broll.splice(+e.target.dataset.k, 1); saveScript(row, sc).catch(P().onError); },

  'doc-create': () => act('doc-create', () => createGoogleDoc(project(), scriptOf(project()))),
  'doc-link': () => act('doc-link', async () => { const id = docIdFrom($('#stDocLink').value); if (!id) throw new Error('Paste a Google Doc link.'); await saveStudio(project(), { docId: id, docUrl: `https://docs.google.com/document/d/${id}/edit` }); return 'Linked.'; }),
  'doc-sync': () => act('doc-sync', async () => {
    const row = project(); const md = await docMarkdown(row);
    const sc = mergeDocMarkdown(scriptOf(row), md); await saveScript(row, sc);
    const edited = sc.sections.reduce((a, s) => a + (s.points || []).filter((p) => p.edited).length, 0);
    return `Synced from the Doc - ${sc.sections.length} sections, ${edited} bullet(s) edited there.`;
  }),

  'broll-all': () => act('broll-all', async () => {
    const row = project();
    const out = await runJob('/api/studio/broll/plan', { script: scriptOf(row), root: studioOf(row).root, per_need: 4 }, 'broll-all');
    await saveStudio(row, { brollJson: JSON.stringify(out) });
    return 'Found b-roll for ' + Object.keys(out).length + ' sections. Click a thumbnail to preview, tick what you want, then Download selected.';
  }),
  'broll-one': (v) => act('broll-' + v, async () => {
    const row = project();
    const out = await runJob('/api/studio/broll/plan', { script: scriptOf(row), root: studioOf(row).root, per_need: 4, sections: [v] }, 'broll-' + v);
    const all = brollOf(row); all[v] = out[v] || []; await saveStudio(row, { brollJson: JSON.stringify(all) });
    return '';
  }),
  'dl-one': (v) => {
    if (v.startsWith('F|')) return handlers['find-dl'](v);
    act('dl-selected', () => { const row = project(); const sc = scriptOf(row); const c = findCandidate(v); return queueDownloads(studioOf(row).root, [{ folder: folderFor(sc, v.split('|')[0]), item: c }]); });
  },
  'dl-retry': (v) => act('dl-selected', async () => { await api('/api/studio/download/retry', { id: v }); pollDownloads(); return 'Retrying.'; }),
  'dl-selected': () => act('dl-selected', async () => {
    const row = project(); const sc = scriptOf(row);
    const items = Object.keys(S.picks).filter((k) => S.picks[k] && !k.startsWith('F|')).map((k) => ({ folder: folderFor(sc, k.split('|')[0]), item: findCandidate(k) })).filter((x) => x.item);
    const out = await queueDownloads(studioOf(row).root, items); S.picks = {}; return out;
  }),

  find: () => act('find', async () => {
    const q = $('#stFq').value.trim(); if (!q) throw new Error('Type what gameplay you want.');
    const proj = ideaRows().find((r) => r.id === ($('#stFproj') || {}).value);
    S.finder.results = await runJob('/api/studio/broll/search', { query: q, after: $('#stFa').value, before: $('#stFb').value, count: +$('#stFn').value || 8, root: proj ? studioOf(proj).root : null }, 'find');
    S.finder.picks = {}; S.previews = {};
    return '';
  }),
  'find-dl': (single) => act('find-dl', async () => {
    const proj = ideaRows().find((r) => r.id === ($('#stFproj') || {}).value);
    if (!proj) throw new Error('Pick a project (with a folder set) to save into.');
    S.projectId = proj.id;
    const keys = typeof single === 'string' ? [single] : Object.keys(S.finder.picks).filter((k) => S.finder.picks[k]);
    const out = await queueDownloads(studioOf(proj).root, keys.map((k) => ({ folder: 'Extra', item: findCandidate(k) })).filter((x) => x.item));
    S.finder.picks = {}; return out;
  }),

  'bs-pitch': () => act('bs-pitch', async () => {
    const idea = $('#stBsIdea').value.trim(); if (!idea) throw new Error('Type an idea first.');
    S.bs.current = await runJob('/api/studio/brainstorm', { idea, notes: $('#stBsNotes').value }, 'bs-pitch');
    S.bs.footage = null; return '';
  }),
  'bs-rework': (v) => act('bs-rework', async () => {
    const followup = typeof v === 'string' && v ? v : $('#stBsFollow').value.trim(); if (!followup) throw new Error('Say what to change.');
    const c = S.bs.current;
    S.bs.current = await runJob('/api/studio/brainstorm', { idea: c.idea, notes: c.notes, followup, previous: c }, 'bs-rework');
    S.bs.footage = null; return 'Reworked: ' + followup;
  }),
  'bs-footage': () => act('bs-footage', async () => { S.bs.footage = await runJob('/api/studio/brainstorm/footage', { outline: S.bs.current.outline || [] }, 'bs-footage'); return ''; }),
  'bs-save': () => act('bs-save', async () => {
    const c = S.bs.current; const { db, doc, setDoc } = P();
    const ideas = [{ id: 'i' + Date.now(), idea: c.idea, notes: c.notes || '', pitchJson: JSON.stringify(c), at: Date.now() }, ...S.bs.ideas].slice(0, 60);
    await setDoc(doc(db, 'config', 'brainstorm'), { ideas }); S.bs.ideas = ideas; return 'Saved.';
  }),
  'bs-load': (v) => { const it = S.bs.ideas.find((x) => x.id === v); if (it) { try { S.bs.current = JSON.parse(it.pitchJson); } catch (e) {} S.bs.footage = null; S.resetInputs = true; renderBody(); } },
  'bs-del': (v) => { const { db, doc, setDoc } = P(); S.bs.ideas = S.bs.ideas.filter((x) => x.id !== v); setDoc(doc(db, 'config', 'brainstorm'), { ideas: S.bs.ideas }).catch(P().onError); renderBody(); },
  'bs-promote': () => act('bs-promote', async () => {
    const c = S.bs.current; const { db, collection, addDoc, serverTimestamp } = P();
    const title = prompt('To-Do video title:', (c.titles || [])[0] || c.idea); if (!title) return '';
    const root = prompt('Project folder on this PC (where Gameplay/Script/Assets will live):', '') || '';
    const script = {
      meta: { title, channel: 'GhazzyTV', status: 'from brainstorm' }, sources: {},
      sections: (c.outline || []).map((s, i) => ({ id: 's' + (i + 1), title: s.title, points: (s.points || []).map((t) => ({ text: t, src: [] })), prompts: [], deeper: [], broll: s.broll ? [s.broll] : [], broll_window: null })),
    };
    const ref = await addDoc(collection(db, 'pipeline'), {
      title, status: 'Idea', doFast: false, notes: [c.hook, c.notes].filter(Boolean).join('\n\n'),
      upload: '', filename: '', driveFileId: '', pendingDelete: false, createdAt: serverTimestamp(),
      studio: { root, scriptJson: JSON.stringify(script), updatedAt: Date.now() },
    });
    S.projectId = ref.id; S.tab = 'script'; renderHead();
    return 'Added to To-Do Videos. Generate the full script from Script & B-roll.';
  }),
};

async function loadIdeas() {
  if (S.bs.loaded || !P()) return;
  const { db, doc, getDoc } = P();
  try { const snap = await getDoc(doc(db, 'config', 'brainstorm')); S.bs.ideas = snap.exists() ? (snap.data().ideas || []) : []; S.bs.loaded = true; renderBody(); }
  catch (e) { console.error('[studio] ideas', e); }
}

async function loadTranscripts() {
  if (S.transcripts || !S.engine) return;
  try { S.transcripts = await api('/api/studio/transcripts'); renderBody(); } catch (e) {}
}

// ------------------------------------------------------------------ open / close
function toggle(open, tab, projectId) {
  const panel = $('#studioPanel'); if (!panel) return;
  S.open = open == null ? !S.open : open;
  if (tab) S.tab = tab;
  if (projectId) S.projectId = projectId;
  panel.classList.toggle('open', S.open);
  if (S.open) {
    renderHead(); renderBody();
    checkEngine().then(() => { loadTranscripts(); pollDownloads(); });
    if (S.tab === 'brainstorm') loadIdeas();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

window.openStudio = (tab, projectId) => toggle(true, tab, projectId);

document.addEventListener('click', (e) => {
  const t = e.target.closest('#studioPanel [data-act]');
  if (!t || t.tagName === 'SELECT') return;
  if (t.tagName === 'INPUT' && t.type !== 'checkbox') return;
  if (t.tagName === 'A' && !t.getAttribute('href').startsWith('#')) return;
  if (t.tagName === 'A') e.preventDefault();
  const h = handlers[t.dataset.act]; if (h) h(t.dataset.v, e);
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'stProject') { S.projectId = e.target.value; S.picks = {}; S.previews = {}; S.downloads = []; S.resetInputs = true; renderBody(); pollDownloads(); }
});
window.addEventListener('pipeline-rows', () => { if (S.open && !document.activeElement.closest?.('#studioPanel input, #studioPanel textarea')) renderBody(); });

document.head.appendChild(el(`<style>
#studioPanel{display:none;padding:12px 20px;background:var(--panel);border-bottom:1px solid var(--border)}
#studioPanel.open{display:block}
#stHead{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
#stHead .spacer,.st-toolbar .spacer,.st-sechead .spacer,.st-row .spacer{flex:1}
.st-tab{background:var(--card);color:var(--muted);border:1px solid var(--border)}
.st-tab.on{background:var(--accent);color:#10131c;border-color:var(--accent)}
.st-pill{font-size:12px;padding:3px 9px;border-radius:12px;background:var(--card);border:1px solid var(--border)}
.st-pill.ok{color:var(--good)}.st-pill.off{color:var(--danger)}
.st-sm{padding:3px 8px;font-size:12px}
#stBody input,#stBody textarea,#stBody select{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:6px 8px;font:inherit;font-size:13px}
#stBody textarea{width:100%;box-sizing:border-box;margin:4px 0;resize:vertical}
#stBody > input,.st-card > input,.st-main > input{width:100%;box-sizing:border-box;margin:4px 0}
.st-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0}
.st-row label{font-size:12px;color:var(--muted)}
.st-row input[id^=stRw_]{flex:1;min-width:180px}
#stRoot{flex:1;min-width:260px}
.st-card{background:var(--card);border:1px solid var(--border);border-radius:4px;padding:10px 12px;margin:8px 0}
.st-card h4{margin:12px 0 4px;font-size:13px;color:var(--muted)}
.st-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.st-msg{font-size:12px;color:var(--good);margin:4px 0}.st-msg.err{color:var(--danger)}
.st-dim{color:var(--muted);font-size:12px}
.st-cols{display:flex;gap:16px;align-items:flex-start}.st-main{flex:1;min-width:0}.st-side{width:260px;flex:none}
@media (max-width:800px){.st-cols{flex-direction:column}.st-side{width:100%}}
.st-idea{display:flex;gap:6px;align-items:center;font-size:13px;margin:4px 0}.st-idea a{flex:1;color:var(--text)}
.st-score{display:flex;gap:10px;align-items:center}.st-bar{flex:0 0 140px;height:8px;background:var(--panel);border-radius:4px;overflow:hidden}.st-bar i{display:block;height:100%;background:var(--accent)}
.st-sec{margin:6px 0}
.st-tlist{max-height:220px;overflow:auto;border:1px solid var(--border);padding:6px;border-radius:3px}
.st-check{display:block;font-size:12px;margin:2px 0}
.st-section{border:1px solid var(--border);border-radius:4px;margin:8px 0;background:var(--card)}
.st-sechead{display:flex;gap:8px;align-items:center;padding:8px 12px;cursor:pointer;flex-wrap:wrap}
.st-secbody{padding:0 12px 10px}
.st-secbody ul{margin:4px 0;padding-left:20px}.st-secbody li{margin:2px 0;font-size:13px}
li.unsourced{opacity:.55}li.edited{border-left:2px solid var(--warn);padding-left:4px}
.st-tag{font-size:10px;color:var(--warn)}
.st-lbl{font-weight:600;font-size:12px;margin-top:6px}
.st-src{font-size:11px;color:var(--muted)}.st-src a{color:var(--accent)}
.st-needs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0;font-size:12px}
.st-chip{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:2px 8px}.st-chip a{color:var(--muted);text-decoration:none}
.st-needin{width:200px}
.st-need{margin:8px 0}.st-needq{font-size:12px;color:var(--muted);margin-bottom:4px}
.st-vids{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.st-vid{background:var(--panel);border:1px solid var(--border);border-radius:4px;overflow:hidden;font-size:12px}
.st-vid iframe,.st-thumb{width:100%;aspect-ratio:16/9;border:0;display:block}
.st-thumb{background:#000 center/cover;position:relative;cursor:pointer}
.st-thumb span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:30px;color:#fff;text-shadow:0 2px 8px #000;opacity:.85}
.st-thumb em{position:absolute;right:6px;bottom:6px;background:#000c;color:#fff;font-style:normal;padding:1px 5px;border-radius:3px}
.st-thumb.local{display:flex;align-items:center;justify-content:center;background:var(--card);cursor:default;color:var(--good)}
.st-vinfo{padding:6px 8px}.st-vinfo a{color:var(--text);text-decoration:none}
.st-why{color:var(--accent);margin-top:2px}
.st-dl{font-size:11px;padding:1px 6px;border-radius:3px;background:var(--panel);border:1px solid var(--border)}
.st-dl.done,.st-dl.skipped{color:var(--good)}.st-dl.error{color:var(--danger)}.st-dl.downloading,.st-dl.queued{color:var(--warn)}
.st-dlrow{font-size:12px;margin:3px 0}
.st-btnlink{background:var(--good);color:#06261a;padding:5px 10px;border-radius:3px;text-decoration:none;font-weight:600;font-size:13px}
</style>`));
