const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_POSITIONS = 5;

// ===== INIT DB =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry_price FLOAT,
      capital FLOAT,
      quantity FLOAT,
      status TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      action TEXT,
      price FLOAT,
      capital FLOAT,
      pnl FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id INT PRIMARY KEY,
      capital FLOAT
    )
  `);

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }
}

// ===== RESET =====
app.get('/reset', async (req, res) => {
  await initDB();
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);
  res.send("Reset complete");
});

// ===== VOLATILITY =====
async function getVolatility(symbol) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=10`
    );

    let total = 0;
    res.data.forEach(c => {
      const high = parseFloat(c[2]);
      const low = parseFloat(c[3]);
      total += (high - low) / low;
    });

    return total / res.data.length;
  } catch {
    return 0.02;
  }
}

// ===== SCORING =====
function momentumScore(c) {
  const stability = 1 - Math.abs(c.change) / 10;
  return (c.change * stability) + Math.log10(c.volume);
}

function crashScore(c) {
  return Math.abs(c.change) * Math.log10(c.volume);
}

// ===== MAIN =====
app.get('/', async (req, res) => {

  if (global.running) return res.send("Processing...");
  global.running = true;

  try {
    await initDB();

    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    // ===== BTC REGIME =====
    const btc = response.data.find(c => c.symbol === "BTCUSDT");
    const btcChange = parseFloat(btc.priceChangePercent);

    if (btcChange < 0) {
      global.running = false;
      return res.send(`
        <body style="background:#0f172a;color:white;padding:20px">
        <h1>⚠️ Market Weak — No Trading</h1>
        <div>BTC: ${btcChange.toFixed(2)}%</div>
        <div>Cash: €${portfolio.capital.toFixed(2)}</div>
        </body>
      `);
    }

    // ===== BUILD COINS =====
    const allCoins = response.data
      .filter(c => c.symbol.endsWith("USDT"))
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.quoteVolume)
      }));

    // ===== MOMENTUM =====
    const momentumCoins = allCoins
      .filter(c =>
        c.price > 0.05 &&
        c.volume > 10000000 &&
        c.change > 1.5 && c.change < 5
      )
      .map(c => ({ ...c, score: momentumScore(c) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // ===== CRASH =====
    const crashCoins = allCoins
      .filter(c =>
        c.change < -15 &&
        c.volume > 20000000
      )
      .map(c => ({ ...c, score: crashScore(c) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    const candidates = [...momentumCoins, ...crashCoins];

    // ===== LOAD POSITIONS =====
    let positions = (await pool.query(
      `SELECT * FROM positions WHERE status='OPEN'`
    )).rows;

    let enriched = positions.map(p => {
      const coin = allCoins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== EXIT =====
    for (let pos of enriched) {
      if (pos.pnl >= 0.03 || pos.pnl <= -0.015) {
        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);
        portfolio.capital += pos.value;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            pos.symbol,
            pos.pnl > 0 ? 'SELL (TP)' : 'SELL (SL)',
            pos.price,
            pos.value,
            pos.pnl
          ]
        );
      }
    }

    // refresh
    positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    enriched = positions.map(p => {
      const coin = allCoins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== BUY / REBALANCE =====
    for (let coin of candidates) {

      if (enriched.find(p => p.symbol === coin.symbol)) continue;

      if (enriched.length >= MAX_POSITIONS) {
        const worst = enriched.reduce((a, b) => a.pnl < b.pnl ? a : b);

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [worst.id]);
        portfolio.capital += worst.value;

        enriched = enriched.filter(p => p.id !== worst.id);
      }

      const volatility = await getVolatility(coin.symbol);
      const riskFactor = 1 / (volatility + 0.01);

      let allocation = portfolio.capital * 0.2 * (riskFactor / 10);

      // smaller for crash trades
      if (coin.change < -15) {
        allocation *= 0.4;
      }

      if (allocation < 5) continue;

      const qty = allocation / coin.price;
      portfolio.capital -= allocation;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, quantity, status)
         VALUES ($1,$2,$3,$4,'OPEN')`,
        [coin.symbol, coin.price, allocation, qty]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital)
         VALUES ($1,'BUY',$2,$3)`,
        [coin.symbol, coin.price, allocation]
      );

      enriched.push({
        symbol: coin.symbol,
        capital: allocation,
        quantity: qty,
        pnl: 0,
        value: allocation
      });
    }

    // ===== TOTAL =====
    let total = portfolio.capital;
    enriched.forEach(p => total += p.value);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

    const trades = (await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`
    )).rows;

    res.send(`
      <body style="background:#0f172a;color:white;padding:20px;font-family:Arial">

      <h1>🚀 ML Dual Strategy Engine</h1>

      <div>💰 Total: €${total.toFixed(2)}</div>
      <div>💵 Cash: €${portfolio.capital.toFixed(2)}</div>
      <div>📊 BTC: ${btcChange.toFixed(2)}%</div>

      <h3>Momentum</h3>
      ${momentumCoins.map(c => `<div>${c.symbol} (${c.change.toFixed(2)}%)</div>`).join('')}

      <h3>Crash Recovery</h3>
      ${crashCoins.map(c => `<div>${c.symbol} (${c.change.toFixed(2)}%)</div>`).join('')}

      <h3>Positions (${enriched.length})</h3>
      ${enriched.map(p => `<div>${p.symbol} | ${(p.pnl*100).toFixed(2)}%</div>`).join('')}

      <h3>Trades</h3>
      ${trades.map(t => `<div>${t.action} ${t.symbol}</div>`).join('')}

      </body>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }

  global.running = false;
});

app.listen(3000);
