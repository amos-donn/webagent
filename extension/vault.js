// The local vault: a real hierarchical filesystem inside the extension's own origin, backed by the
// Origin Private File System. It is deliberately free of chrome.* so the panel, an injected script and
// the tests can all use the same rules, and the rules live here rather than at each call site: a model
// that asks for ../../memory.md should be told no, not quietly helped.
//
// OPFS has no append, so appendText is read-then-write. That is fine for notes and transcripts and wrong
// for logs a person tails; nothing here writes one of those.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Vault = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Everything the agent writes lands in one of these, plus memory.md as the index into memory/.
  const DIRS = ['memory', 'plans', 'reports', 'drafts', 'data', 'runs', 'transcripts', 'uploads'];
  const TOP = ['memory.md', ...DIRS];
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  const MAX_SEGMENT = 120;
  const MAX_DEPTH = 6;
  const MAX_TEXT = 2 * 1024 * 1024;
  const MAX_UPLOAD = 25 * 1024 * 1024;

  function safePath(value) {
    const raw = String(value ?? '').replace(/\\/g, '/').trim();
    const parts = raw.split('/').filter(part => part !== '' && part !== '.');
    if (!parts.length) throw new Error('A file needs a name.');
    if (parts.length > MAX_DEPTH) throw new Error('That path is too deep.');
    if (parts.includes('..')) throw new Error('A file cannot point outside the vault.');
    if (parts.some(part => part.length > MAX_SEGMENT)) throw new Error('That name is too long.');
    if (parts.some(part => /[\u0000-\u001f<>:"|?*]/.test(part))) throw new Error('That name has characters a file cannot have.');
    if (parts.some(part => RESERVED.test(part))) throw new Error('That name is reserved on Windows.');
    if (!TOP.includes(parts[0])) throw new Error(`Files live in ${DIRS.join(', ')} or memory.md.`);
    if (parts[0] === 'memory.md') {
      if (parts.length > 1) throw new Error('memory.md is a file, not a folder.');
      return 'memory.md';
    }
    if (parts.length < 2) throw new Error('That is a folder, not a file.');
    return parts.join('/');
  }

  const slug = (text, max = 48) => String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'file';

  const isText = name => /\.(md|txt|csv|json|log|html|css|js|ts|srt|vtt|ya?ml)$/i.test(String(name ?? ''));

  function humanSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
  }

  // Folders first, then by name: the list should not jump around as files are added.
  const sortEntries = entries => [...(entries || [])].sort((a, b) => (b.kind === 'directory') - (a.kind === 'directory') || String(a.name).localeCompare(String(b.name)));

  async function root() {
    if (!navigator.storage?.getDirectory) throw new Error('This browser has no local file store.');
    return navigator.storage.getDirectory();
  }

  async function dirFor(path, create) {
    const parts = safePath(path).split('/');
    parts.pop();
    let handle = await root();
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create });
    return handle;
  }

  async function fileHandle(path, create = false) {
    const clean = safePath(path);
    const directory = await dirFor(clean, create);
    return directory.getFileHandle(clean.split('/').pop(), { create });
  }

  const readText = async path => (await (await fileHandle(path)).getFile()).text();
  const readBlob = async path => (await fileHandle(path)).getFile();

  async function writeBlob(path, blob) {
    const clean = safePath(path);
    if ((blob?.size || 0) > MAX_UPLOAD) throw new Error(`That file is larger than ${humanSize(MAX_UPLOAD)}.`);
    const stream = await (await fileHandle(clean, true)).createWritable();
    await stream.write(blob);
    await stream.close();
    return { path: clean, bytes: blob?.size || 0 };
  }

  async function writeText(path, text) {
    const clean = safePath(path);
    if (clean.split('/')[0] === 'uploads') throw new Error('Uploads hold files, not text. Use the upload button.');
    const body = String(text ?? '');
    if (body.length > MAX_TEXT) throw new Error(`That text is larger than ${humanSize(MAX_TEXT)} for one file.`);
    return writeBlob(clean, new Blob([body], { type: 'text/plain;charset=utf-8' }));
  }

  // OPFS has no append, so this reads the file, appends and writes it back in one operation.
  async function appendText(path, text) {
    const clean = safePath(path);
    let existing = '';
    try { existing = await readText(clean); } catch { existing = ''; }
    const addition = String(text ?? '').trim();
    if (!addition) return { path: clean, bytes: existing.length };
    return writeText(clean, existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${addition}\n` : `${addition}\n`);
  }

  async function list(dir = '') {
    const clean = String(dir ?? '').replace(/^\/+|\/+$/g, '');
    let handle;
    try {
      handle = clean ? await dirFor(`${clean}/placeholder`, false) : await root();
    } catch {
      // A folder that has never been written to is empty, not an error.
      return [];
    }
    const out = [];
    for await (const [name, entry] of handle.entries()) {
      const path = clean ? `${clean}/${name}` : name;
      if (entry.kind === 'directory') {
        out.push({ name, kind: 'directory', path });
        continue;
      }
      const file = await entry.getFile();
      out.push({ name, kind: 'file', path, bytes: file.size, at: file.lastModified });
    }
    return sortEntries(out);
  }

  async function remove(path) {
    const clean = safePath(path);
    const directory = await dirFor(clean, false);
    await directory.removeEntry(clean.split('/').pop(), { recursive: true });
    return { path: clean };
  }

  async function usage() {
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    return { used: Number(estimate?.usage) || 0, quota: Number(estimate?.quota) || 0 };
  }

  return {
    DIRS, TOP, MAX_TEXT, MAX_UPLOAD,
    safePath, slug, isText, humanSize, sortEntries,
    readText, readBlob, writeText, writeBlob, appendText, list, remove, usage
  };
});
