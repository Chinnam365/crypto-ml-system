const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// EMA
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaArr = [values[0]];

  for (let i = 1; i < values.length; i++) {
    emaArr.push(values[i] * k + emaArr[i - 1] * (1 - k));
  }

  return emaArr;
}

// MACD
function computeMACD(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = ema(macd, 9);
  const hist = macd.map((v, i) => v - signal[i]);

  return { macd, signal, hist };
}

// MAIN FEATURE BUILDER
async function buildFeatures(symbol) {
  const { rows } = await pool.query(
    `SELECT * FROM candles WHERE symbol=$1 ORDER BY time ASC`,
    [symbol]
  );

  if (rows.length < 50) return;

  const closes = rows.map(r => r.close);
  const volumes = rows.map(r => r.volume);

  const { macd, signal, hist } = computeMACD(closes);

  let obv = 0;

  for (let i = 30; i < rows.length; i++) {
    const r = rows[i];

    const momentum = (closes[i] - closes[i - 1]) / closes[i - 1];
    const momentumMid = (closes[i] - closes[i - 5]) / closes[i - 5];

    const avgVol =
      volumes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;

    const volSpike = r.volume / avgVol;

    if (closes[i] > closes[i - 1]) obv += r.volume;
    else obv -= r.volume;

    const volatility = Math.abs(r.high - r.low) / r.close;

    const window = closes.slice(i - 20, i);

    const distLow = (r.close - Math.min(...window)) / r.close;
    const distHigh = (Math.max(...window) - r.close) / r.close;

    await pool.query(
      `INSERT INTO features (
        symbol,time,
        macd,macd_signal,macd_hist,
        momentum,momentum_mid,
        volume_spike,obv,
        volatility,
        dist_low,dist_high
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (symbol,time) DO NOTHING`,
      [
        symbol,
        r.time,
        macd[i],
        signal[i],
        hist[i],
        momentum,
        momentumMid,
        volSpike,
        obv,
        volatility,
        distLow,
        distHigh
      ]
    );
  }

  console.log(`Features built for ${symbol}`);
}

module.exports = { buildFeatures };
