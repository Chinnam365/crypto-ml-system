const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_POSITIONS = 5;

// ===== INIT DB + AUTO FIX =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry_price FLOAT,
      capital FLOAT,
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
    CREATE TABLE IF NOT EXISTS weights (
      id INT PRIMARY KEY,
      momentum FLOAT
    )
  `);

  // AUTO ADD COLUMNS (SAFE)
  const columns = [
    "change FLOAT",
    "score FLOAT",
    "volume FLOAT"
  ];

  for (let col of columns) {
    try {
      await pool.query(`ALTER TABLE trades ADD COLUMN ${col}`);
    } catch (e) {}
  }

  const w = await pool.query(`SELECT * FROM weights WHERE id=1`);
  if (w.rows.length === 0) {
    await pool.query(`INSERT INTO weights VALUES (1, 1.2)`);
  }
}

// ===== SCORING =====
function scoreCoin(c, w) {
  if (c.change > 6 || c.change < -3) return -999;
  const momentum = c.change > 0 ? c.change : 0;
  return momentum * w.momentum + Math.log10(c.volume || 1);
}

// ===== LEARNING =====
async function updateWeights() {
  const res = await pool.query(`
    SELECT * FROM trades WHERE pnl IS NOT NULL
    ORDER BY created_at DESC LIMIT 50
  `);

  if (res.rows.length < 10) return;

  let win = 0, loss = 0;

  res.rows.forEach(t => {
    if (t.pnl > 0) win++;
    else loss++;
  });

  let newWeight = 1.2 + (win - loss) * 0.01;

  await pool.query(
    `UPDATE weights SET momentum=$1 WHERE id=1`,
    [Math.max(0.5, Math.min(newWeight, 3))]
  );
}

// ===== MAIN DASHBOARD =====
app.get('/', async (req, res) => {
  try {
    await initDB();

    const weights = (await pool.query(`SELECT * FROM weights WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    const coins = response.data
      .filter(c => {
        const s = c.symbol;
        return (
          s.endsWith("USDT") &&
          parseFloat(c.volume) > 1000000 &&
          !s.includes("UP") &&
          !s.includes("DOWN") &&
          !s.includes("BULL") &&
          !s.includes("BEAR")
        );
      })
      .slice(0, 100)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.volume)
      }));

    const scored = coins.map(c => ({
      ...c,
      score: scoreCoin(c, weights)
    }));

    const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    let positions = (await pool.query(
      `SELECT * FROM positions WHERE status='OPEN'`
    )).rows;

    const capitalPerTrade = 100 / MAX_POSITIONS;

    // ===== ENTRY =====
    for (let coin of top5) {
  if (positions.length >= MAX_POSITIONS) break;

  const exists = positions.find(p => p.symbol === coin.symbol);
  if (exists) continue;

  // 🚨 CORRELATION FILTER (simple)
  const base = coin.symbol.replace("USDT", "");

  const similar = positions.find(p =>
    p.symbol.includes(base.substring(0, 3))
  );

  if (similar) continue;
      if (positions.length >= MAX_POSITIONS) break;

      const exists = positions.find(p => p.symbol === coin.symbol);
      if (exists) continue;

      if (coin.change >= 1 && coin.change <= 5) {
        await pool.query(`
          INSERT INTO positions(symbol, entry_price, capital, status)
          VALUES ($1,$2,$3,'OPEN')
        `, [coin.symbol, coin.price, capitalPerTrade]);

        await pool.query(`
          INSERT INTO trades(symbol, action, price, capital, change, score, volume)
          VALUES ($1,'BUY',$2,$3,$4,$5,$6)
        `, [coin.symbol, coin.price, capitalPerTrade, coin.change, coin.score, coin.volume]);
      }
    }

    // ===== EXIT =====
    let activePositions = [];

    for (let pos of positions) {
      const current = coins.find(c => c.symbol === pos.symbol);
      if (!current) continue;

      const pnl = (current.price - pos.entry_price) / pos.entry_price;

      if (pnl >= 0.02 || pnl <= -0.01) {
        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);

        await pool.query(`
          INSERT INTO trades(symbol, action, price, capital, pnl)
          VALUES ($1,$2,$3,$4,$5)
        `, [pos.symbol, pnl > 0 ? 'SELL (TP)' : 'SELL (SL)', current.price, pos.capital, pnl]);

        await updateWeights();
      } else {
        activePositions.push({ ...pos, pnl });
      }
    }

    const trades = (await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`
    )).rows;

    // ===== UI =====
    res.send(`
      <html>
      <head>
        <meta http-equiv="refresh" content="5">
        <style>
          body { background:#0f172a;color:white;font-family:Arial;padding:20px; }
          .card { background:#1e293b;padding:15px;margin-bottom:10px;border-radius:8px; }
        </style>
      </head>
      <body>

      <h1>🚀 Multi-Position ML Engine</h1>

      <div class="card">
        <h3>Weights</h3>
        Momentum: ${weights.momentum.toFixed(2)}
      </div>

      <div class="card">
        <h3>Top 5 Coins</h3>
        ${top5.map(c => `<div>${c.symbol} (${c.change.toFixed(2)}%)</div>`).join('')}
      </div>

      <div class="card">
        <h3>Active Positions (${activePositions.length})</h3>
        ${activePositions.map(p => `
          <div>${p.symbol} | Entry ${p.entry_price} | PnL ${(p.pnl*100).toFixed(2)}%</div>
        `).join('')}
      </div>

      <div class="card">
        <h3>Recent Trades</h3>
        ${trades.map(t => `
          <div>${t.action} ${t.symbol} (${t.pnl ? (t.pnl*100).toFixed(2)+'%' : ''})</div>
        `).join('')}
      </div>

      <a href="/history" style="color:lightblue">View Full History</a>

      </body>
      </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

// ===== HISTORY PAGE =====
app.get('/history', async (req, res) => {
  try {
    await initDB();

    const trades = (await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 100`
    )).rows;

    res.send(`
      <html>
      <body style="background:#0f172a;color:white;font-family:Arial;padding:20px">
      <h1>📜 Trade History</h1>

      ${trades.map(t => `
        <div style="margin-bottom:8px">
          ${t.created_at} |
          ${t.action} ${t.symbol} |
          Price: ${t.price} |
          Capital: ${t.capital}
          ${t.pnl ? `| PnL: ${(t.pnl*100).toFixed(2)}%` : ''}
        </div>
      `).join('')}

      <br><a href="/" style="color:lightblue">← Back</a>
      </body>
      </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

app.listen(3000);
