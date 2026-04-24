const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== INIT DB (AUTO FIXING) =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      id INT PRIMARY KEY,
      capital FLOAT,
      position TEXT,
      coin TEXT,
      entry_price FLOAT
    )
  `);

  // Safe schema upgrades
  try { await pool.query(`ALTER TABLE state ADD COLUMN position TEXT`); } catch {}
  try { await pool.query(`ALTER TABLE state ADD COLUMN coin TEXT`); } catch {}
  try { await pool.query(`ALTER TABLE state ADD COLUMN entry_price FLOAT`); } catch {}

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

  try { await pool.query(`ALTER TABLE trades ADD COLUMN pnl FLOAT`); } catch {}

  const res = await pool.query(`SELECT * FROM state WHERE id=1`);
  if (res.rows.length === 0) {
    await pool.query(`
      INSERT INTO state (id, capital, position, coin, entry_price)
      VALUES (1, 100, 'NONE', NULL, NULL)
    `);
  }
}

// ===== MAIN =====
app.get('/', async (req, res) => {
  try {
    await initDB();

    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);
    let capital = dbState.rows[0].capital;
    let position = dbState.rows[0].position || "NONE";
    let currentCoin = dbState.rows[0].coin || null;
    // Fix broken state (no entry price but holding)
if (position === "HOLDING" && !entryPrice) {
  position = "NONE";
  currentCoin = null;
}

    const tradesResult = await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`
    );

    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    const coins = response.data
      .filter(c =>
        c.symbol.endsWith("USDT") &&
        parseFloat(c.volume) > 1000000 &&
        parseFloat(c.lastPrice) > 0
      )
      .slice(0, 50)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent)
      }));

    const validCoins = coins.filter(c =>
      Math.abs(c.change) > 1 && Math.abs(c.change) < 5
    );

    const best = validCoins.length > 0
      ? validCoins.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
      : coins[0];

    let action = "HOLD";
    let pnl = 0;

    // ===== ENTRY =====
    if (position === "NONE") {
      if (best.change > 1 && best.change < 5) {
        position = "HOLDING";
        currentCoin = best.symbol;
        entryPrice = best.price;
        action = "BUY";
      }
    }

    // ===== HOLD / EXIT =====
    else if (position === "HOLDING") {
      const current = coins.find(c => c.symbol === currentCoin);

      if (current && entryPrice) {
        pnl = (current.price - entryPrice) / entryPrice;

        // Take Profit
        if (pnl >= 0.02) {
          capital *= (1 + pnl);
          action = "SELL (TP)";
          position = "NONE";
          currentCoin = null;
          entryPrice = null;
        }

        // Stop Loss
        else if (pnl <= -0.01) {
          capital *= (1 + pnl);
          action = "SELL (SL)";
          position = "NONE";
          currentCoin = null;
          entryPrice = null;
        }
      }
    }

    // Save trade
    if (action !== "HOLD") {
      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital, pnl)
         VALUES ($1, $2, $3, $4, $5)`,
        [best.symbol, action, best.price, capital, pnl]
      );
    }

    // Update state
    await pool.query(
      `UPDATE state SET capital=$1, position=$2, coin=$3, entry_price=$4 WHERE id=1`,
      [capital, position, currentCoin, entryPrice]
    );

    // ===== UI =====
    res.send(`
      <html>
      <head>
        <title>Crypto ML Dashboard</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body { font-family: Arial; background:#0f172a; color:white; padding:20px; }
          .card { background:#1e293b; padding:20px; margin-bottom:15px; border-radius:10px; }
          .green { color:#22c55e; }
          .red { color:#ef4444; }
          .yellow { color:#facc15; }
        </style>
      </head>
      <body>

        <h1>🚀 Crypto ML Dashboard (Real Simulation)</h1>

        <div class="card">
          <h2>💰 Capital: €${capital.toFixed(2)}</h2>
        </div>

        <div class="card">
          <h3>📊 Market</h3>
          <p>${best.symbol}</p>
          <p>Change: ${best.change.toFixed(2)}%</p>
        </div>

        <div class="card">
          <h3>📌 Position</h3>
          <p>Status: ${position}</p>
          <p>Coin: ${currentCoin || "None"}</p>
          <p>Entry: ${entryPrice || "-"}</p>
          <p>PnL: ${(pnl * 100).toFixed(2)}%</p>
        </div>

        <div class="card">
          <h3>⚡ Action</h3>
          <p class="${
            action.includes('BUY') ? 'green' :
            action.includes('SELL') ? 'red' : 'yellow'
          }">${action}</p>
        </div>

        <div class="card">
          <h3>📜 Recent Trades</h3>
          <ul>
            ${tradesResult.rows.map(t => `
              <li>
                ${t.action} ${t.symbol} → €${Number(t.capital).toFixed(2)}
                (${t.pnl ? (t.pnl * 100).toFixed(2) : 0}%)
              </li>
            `).join('')}
          </ul>
        </div>

      </body>
      </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

// HISTORY
app.get('/history', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM trades ORDER BY created_at DESC LIMIT 20`
  );
  res.json(result.rows);
});

app.listen(3000, () => {
  console.log('Server running');
});
