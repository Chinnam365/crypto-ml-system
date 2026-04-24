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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weights (
      id INT PRIMARY KEY,
      momentum FLOAT
    )
  `);

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }

  const w = await pool.query(`SELECT * FROM weights WHERE id=1`);
  if (w.rows.length === 0) {
    await pool.query(`INSERT INTO weights VALUES (1, 1.2)`);
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
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=10`;
    const res = await axios.get(url);

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

// ===== SCORE =====
function scoreCoin(c, weight) {
  if (c.change > 5 || c.change < -3) return -999;
  const stability = 1 - Math.abs(c.change) / 10;
  return (c.change * weight * stability) + Math.log10(c.volume);
}

// ===== MAIN =====
app.get('/', async (req, res) => {
  if (global.isRunning) return res.send("Processing...");
  global.isRunning = true;

  try {
    await initDB();

    const weights = (await pool.query(`SELECT * FROM weights WHERE id=1`)).rows[0];
    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    // ===== FILTER =====
    const coins = response.data
      .filter(c => {
        const price = parseFloat(c.lastPrice);
        const change = parseFloat(c.priceChangePercent);
        const volume = parseFloat(c.quoteVolume);

        return (
          c.symbol.endsWith("USDT") &&
          price > 0.05 &&
          volume > 10000000 &&
          change > 1.5 && change < 5 &&
          !c.symbol.includes("UP") &&
          !c.symbol.includes("DOWN")
        );
      })
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.quoteVolume)
      }));

    // ===== SCORE =====
    const scored = coins.map(c => ({
      ...c,
      score: scoreCoin(c, weights.momentum)
    }));

    const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    // ===== LOAD POSITIONS =====
    let positions = (await pool.query(
      `SELECT * FROM positions WHERE status='OPEN'`
    )).rows;

    let enriched = positions.map(p => {
      const c = coins.find(x => x.symbol === p.symbol);
      if (!c) return null;

      const value = p.quantity * c.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: c.price };
    }).filter(Boolean);

    // ===== EXIT =====
    for (let pos of enriched) {
      if (pos.pnl >= 0.02 || pos.pnl <= -0.01) {
        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);

        portfolio.capital += pos.value;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl)
           VALUES ($1,$2,$3,$4,$5)`,
          [pos.symbol, pos.pnl > 0 ? 'SELL (TP)' : 'SELL (SL)', pos.price, pos.value, pos.pnl]
        );
      }
    }

    // refresh
    positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    enriched = positions.map(p => {
      const c = coins.find(x => x.symbol === p.symbol);
      if (!c) return null;

      const value = p.quantity * c.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: c.price };
    }).filter(Boolean);

    // ===== REBALANCE + RISK CONTROL =====
    const totalScore = top5.reduce((s, c) => s + Math.max(c.score, 0), 0);

    for (let coin of top5) {
      if (enriched.find(p => p.symbol === coin.symbol)) continue;

      if (enriched.length >= MAX_POSITIONS) {
        const worst = enriched.reduce((a, b) => a.pnl < b.pnl ? a : b);

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [worst.id]);

        portfolio.capital += worst.value;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl)
           VALUES ($1,'SELL (REBALANCE)',$2,$3,$4)`,
          [worst.symbol, worst.price, worst.value, worst.pnl]
        );

        enriched = enriched.filter(p => p.id !== worst.id);
      }

      const weight = Math.max(coin.score, 0) / (totalScore || 1);

      const volatility = await getVolatility(coin.symbol);
      const riskFactor = 1 / (volatility + 0.01);
      const normalizedRisk = Math.min(Math.max(riskFactor, 5), 50);

      let allocation = portfolio.capital * weight * (normalizedRisk / 10);

      // safety cap
      if (allocation > portfolio.capital * 0.4) {
        allocation = portfolio.capital * 0.4;
      }

      if (allocation < 5) continue;

      const quantity = allocation / coin.price;

      portfolio.capital -= allocation;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, quantity, status)
         VALUES ($1,$2,$3,$4,'OPEN')`,
        [coin.symbol, coin.price, allocation, quantity]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital)
         VALUES ($1,'BUY',$2,$3)`,
        [coin.symbol, coin.price, allocation]
      );

      enriched.push({
        symbol: coin.symbol,
        quantity,
        capital: allocation,
        pnl: 0,
        value: allocation
      });
    }

    // ===== TOTAL =====
    let totalValue = portfolio.capital;
    enriched.forEach(p => totalValue += p.value);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

    const trades = (await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`
    )).rows;

    res.send(`
      <html>
      <head><meta http-equiv="refresh" content="5"></head>
      <body style="background:#0f172a;color:white;font-family:Arial;padding:20px">

      <h1>🚀 ML Portfolio Engine (Risk Controlled)</h1>

      <div>💰 Total: €${totalValue.toFixed(2)}</div>
      <div>💵 Cash: €${portfolio.capital.toFixed(2)}</div>

      <h3>Top Coins</h3>
      ${top5.map(c => `<div>${c.symbol} (${c.change.toFixed(2)}%)</div>`).join('')}

      <h3>Positions (${enriched.length})</h3>
      ${enriched.map(p => `<div>${p.symbol} | ${(p.pnl*100).toFixed(2)}%</div>`).join('')}

      <h3>Trades</h3>
      ${trades.map(t => `<div>${t.action} ${t.symbol}</div>`).join('')}

      </body>
      </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }

  global.isRunning = false;
});

app.listen(3000);
