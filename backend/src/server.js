const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== INIT DB =====
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

// ===== SCORING FUNCTION =====
function scoreCoin(c) {
  const momentum = Math.abs(c.change); // strength
  const stability = (c.change > 1 && c.change < 5) ? 1 : 0; // valid zone
  const volumeScore = Math.log10(c.volume || 1);

  return momentum * 0.6 + stability * 2 + volumeScore * 0.4;
}

// ===== MAIN =====
app.get('/', async (req, res) => {
  try {
    await initDB();

    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);

    let capital = dbState.rows[0].capital;
    let position = dbState.rows[0].position || "NONE";
    let currentCoin = dbState.rows[0].coin || null;
    let entryPrice = dbState.rows[0].entry_price || null;

    // Fix broken state
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
      .slice(0, 100)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.volume)
      }));

    // Score all coins
    const scored = coins.map(c => ({
      ...c,
      score: scoreCoin(c)
    }));

    // Top 5 coins
    const top5 = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const best = top5[0];

    let action = "HOLD";
    let pnl = 0;

    // ENTRY
    if (position === "NONE") {
      if (best.change > 1 && best.change < 5) {
        position = "HOLDING";
        currentCoin = best.symbol;
        entryPrice = best.price;
        action = "BUY";
      }
    }

    // HOLD / EXIT
    else if (position === "HOLDING") {
      const current = coins.find(c => c.symbol === currentCoin);

      if (current && entryPrice) {
        pnl = (current.price - entryPrice) / entryPrice;

        if (pnl >= 0.02) {
          capital *= (1 + pnl);
          action = "SELL (TP)";
          position = "NONE";
          currentCoin = null;
          entryPrice = null;
        }
        else if (pnl <= -0.01) {
          capital *= (1 + pnl);
          action = "SELL (SL)";
          position = "NONE";
          currentCoin = null;
          entryPrice = null;
        }
      }
    }

    if (action !== "HOLD") {
      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital, pnl)
         VALUES ($1, $2, $3, $4, $5)`,
        [best.symbol, action, best.price, capital, pnl]
      );
    }

    await pool.query(
      `UPDATE state SET capital=$1, position=$2, coin=$3, entry_price=$4 WHERE id=1`,
      [capital, position, currentCoin, entryPrice]
    );

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
        </style>
      </head>
      <body>

        <h1>🚀 Crypto ML Dashboard (Top 5 Engine)</h1>

        <div class="card">
          <h2>💰 Capital: €${capital.toFixed(2)}</h2>
        </div>

        <div class="card">
          <h3>🏆 Best Coin</h3>
          <p>${best.symbol}</p>
          <p>Score: ${best.score.toFixed(2)}</p>
          <p>Change: ${best.change.toFixed(2)}%</p>
        </div>

        <div class="card">
          <h3>📊 Top 5 Coins</h3>
          <ul>
            ${top5.map(c => `
              <li>${c.symbol} | Score: ${c.score.toFixed(2)} | ${c.change.toFixed(2)}%</li>
            `).join('')}
          </ul>
        </div>

        <div class="card">
          <h3>📌 Position</h3>
          <p>${position}</p>
          <p>${currentCoin || "-"}</p>
          <p>Entry: ${entryPrice || "-"}</p>
          <p>PnL: ${(pnl * 100).toFixed(2)}%</p>
        </div>

      </body>
      </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

app.listen(3000);
