function parseSemver(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function compareSemver(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function bumpMinVersion(existing, current) {
  if (!existing) return current;
  return compareSemver(existing, current) >= 0 ? existing : current;
}

function parseIntOr(str, fallback) {
  const n = parseInt(str, 10);
  return Number.isNaN(n) ? fallback : n;
}

module.exports = {
  parseSemver,
  compareSemver,
  bumpMinVersion,
  parseIntOr,
};
