const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_POSITIONS = 5;

// ===== INIT =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry_price FLOAT,
      capital FLOAT,
      quantity FLOAT,
      strategy TEXT,
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
      strategy TEXT,
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
    CREATE TABLE IF NOT EXISTS strategy_stats (
      strategy TEXT PRIMARY KEY,
      wins INT,
      losses INT
    )
  `);

  await pool.query(`
    INSERT INTO strategy_stats(strategy, wins, losses)
    VALUES ('momentum',0,0)
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO strategy_stats(strategy, wins, losses)
    VALUES ('crash',0,0)
    ON CONFLICT DO NOTHING
  `);

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }
}

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

// ===== SCORES =====
function momentumScore(c) {
  return c.change + Math.log10(c.volume);
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

    const btc = response.data.find(c => c.symbol === "BTCUSDT");
    const btcChange = parseFloat(btc.priceChangePercent);

    let regime = "NEUTRAL";
    if (btcChange > 1) regime = "STRONG";
    else if (btcChange < -1) regime = "WEAK";

    // ===== BUILD COINS =====
    const coins = response.data
      .filter(c => c.symbol.endsWith("USDT"))
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.quoteVolume)
      }));

    // ===== STRATEGY STATS =====
    const stats = await pool.query(`SELECT * FROM strategy_stats`);
    const momentumStats = stats.rows.find(s => s.strategy === 'momentum');
    const crashStats = stats.rows.find(s => s.strategy === 'crash');

    const momentumWeight = (momentumStats.wins + 1) / (momentumStats.losses + 1);
    const crashWeight = (crashStats.wins + 1) / (crashStats.losses + 1);

    // ===== MOMENTUM =====
    let momentumCoins = coins
      .filter(c => c.change > 1.5 && c.change < 5 && c.volume > 10000000)
      .map(c => ({ ...c, score: momentumScore(c) * momentumWeight }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // ===== CRASH =====
    let crashCoins = coins
      .filter(c => c.change < -15 && c.volume > 20000000)
      .map(c => ({ ...c, score: crashScore(c) * crashWeight }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    // ===== REGIME ADJUST =====
    if (regime === "WEAK") {
      momentumCoins = [];
      crashCoins = crashCoins.slice(0, 1); // minimal trading
    }

    const candidates = [
      ...momentumCoins.map(c => ({ ...c, strategy: 'momentum' })),
      ...crashCoins.map(c => ({ ...c, strategy: 'crash' }))
    ];

    // ===== LOAD POSITIONS =====
    let positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    let enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
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

        // update learning
        if (pos.pnl > 0) {
          await pool.query(`UPDATE strategy_stats SET wins = wins + 1 WHERE strategy=$1`, [pos.strategy]);
        } else {
          await pool.query(`UPDATE strategy_stats SET losses = losses + 1 WHERE strategy=$1`, [pos.strategy]);
        }

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl, strategy)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            pos.symbol,
            pos.pnl > 0 ? 'SELL (TP)' : 'SELL (SL)',
            pos.price,
            pos.value,
            pos.pnl,
            pos.strategy
          ]
        );
      }
    }

    // refresh
    positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== BUY =====
    for (let coin of candidates) {

      if (enriched.find(p => p.symbol === coin.symbol)) continue;

      if (enriched.length >= MAX_POSITIONS) continue;

      const volatility = await getVolatility(coin.symbol);

      let allocation = portfolio.capital * 0.2 * (1 / (volatility + 0.01));

      if (coin.strategy === 'crash') allocation *= 0.4;

      if (regime === "WEAK") allocation *= 0.3;

      if (allocation < 5) continue;

      const qty = allocation / coin.price;

      portfolio.capital -= allocation;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, quantity, strategy, status)
         VALUES ($1,$2,$3,$4,$5,'OPEN')`,
        [coin.symbol, coin.price, allocation, qty, coin.strategy]
      );
    }

    // ===== TOTAL =====
    let total = portfolio.capital;
    enriched.forEach(p => total += p.value);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

    res.send(`
      <body style="background:#0f172a;color:white;padding:20px">

      <h1>🤖 Adaptive ML Engine</h1>

      <div>Total: €${total.toFixed(2)}</div>
      <div>Cash: €${portfolio.capital.toFixed(2)}</div>
      <div>BTC: ${btcChange.toFixed(2)}% (${regime})</div>

      <h3>Momentum Weight: ${momentumWeight.toFixed(2)}</h3>
      <h3>Crash Weight: ${crashWeight.toFixed(2)}</h3>

      <h3>Positions (${enriched.length})</h3>
      ${enriched.map(p => `<div>${p.symbol} (${p.strategy}) ${(p.pnl*100).toFixed(2)}%</div>`).join('')}

      </body>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }

  global.running = false;
});

app.listen(3000);
