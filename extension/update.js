// Update checking, kept out of the panel so the part that decides "is this newer" can be tested
// without a browser. Chrome's own updater does the silent work for a CRX install; this module is what
// an unpacked install reads to find out a new build exists at all.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Update = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Chrome compares versions as dot-separated integers and treats a missing component as zero, so
  // 1.10 is newer than 1.9 and 1.9.0.1 is newer than 1.9.0. String comparison gets both wrong.
  const PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/;

  function parts(version) {
    const match = PATTERN.exec(String(version || '').trim());
    if (!match) return null;
    return [1, 2, 3, 4].map(index => Number(match[index] || 0));
  }

  function newer(candidate, current) {
    const a = parts(candidate), b = parts(current);
    if (!a || !b) return false;
    for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index] > b[index];
    return false;
  }

  // The update feed is a two-line document, but it is still parsed rather than regexed into shape:
  // an attribute that is not there must be missing, not the string "undefined" in a download link.
  function attribute(tag, name) {
    const match = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(tag);
    return match ? match[1].trim() : '';
  }

  function parse(xml) {
    const text = String(xml || '');
    const tag = /<updatecheck\b[^>]*>/i.exec(text);
    if (!tag) return null;
    const version = attribute(tag[0], 'version');
    const codebase = attribute(tag[0], 'codebase');
    // A feed that points at http:// is not usable: Chrome only updates from https.
    if (!parts(version) || !/^https:\/\//i.test(codebase)) return null;
    return { version, codebase };
  }

  // An unpacked extension is never replaced by Chrome, so the download is the plain archive the user
  // unzips over their folder; the codebase in the feed is the signed package for Chrome's own updater.
  const ZIP_URL = 'https://github.com/amos-donn/webagent/releases/latest/download/mezze-extension.zip';
  const FEED_URL = 'https://github.com/amos-donn/webagent/releases/latest/download/updates.xml';

  return { parts, newer, parse, ZIP_URL, FEED_URL };
});
