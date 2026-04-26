function safe(n, def = 0) {
  return isFinite(n) ? n : def;
}
module.exports = { safe };
