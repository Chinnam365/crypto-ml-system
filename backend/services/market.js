const axios = require('axios');

async function getMarket() {
  const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

  return res.data
    .filter(c => c.symbol.endsWith("USDT"))
    .slice(0, 15)
    .map(c => ({
      symbol: c.symbol,
      price: parseFloat(c.lastPrice),
      change: parseFloat(c.priceChangePercent)
    }));
}

async function getMomentum(symbol) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=2`
    );

    const prev = parseFloat(res.data[0][4]);
    const last = parseFloat(res.data[1][4]);

    return ((last - prev) / prev) * 100;
  } catch {
    return 0;
  }
}

module.exports = { getMarket, getMomentum };
