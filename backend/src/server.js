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

  const cols = ["change FLOAT", "score FLOAT", "volume FLOAT"];
  for (let col of cols) {
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

// ===== MAIN =====
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
      .slice(0, 200)
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

    const sorted = scored.sort((a, b) => b.score - a.score);

    // ===== DIVERSIFIED SELECTION =====
    const candidates = sorted.slice(0, 30);
    let top5 = [];

    for (let coin of candidates) {
      if (top5.length >= 5) break;

      const similar = top5.find(c =>
        Math.abs(c.change - coin.change) < 1.5
      );

      if (!similar && coin.change >= 1 && coin.change <= 5) {
        top5.push(coin);
      }
    }

    if (top5.length < 5) {
      for (let coin of candidates) {
        if (top5.length >= 5) break;
        if (!top5.find(c => c.symbol === coin.symbol)) {
          top5.push(coin);
        }
      }
    }

    let positions = (await pool.query(
      `SELECT * FROM positions WHERE status='OPEN'`
    )).rows;

    // ===== CALCULATE CURRENT PNL =====
    let enrichedPositions = positions.map(p => {
      const current = coins.find(c => c.symbol === p.symbol);
      if (!current) return null;

      const pnl = (current.price - p.entry_price) / p.entry_price;

      return {
        ...p,
        pnl,
        currentPrice: current.price
      };
    }).filter(Boolean);

    // ===== AGGRESSIVE REBALANCING =====
    // ===== AGGRESSIVE REBALANCING (FIXED) =====
for (let coin of top5) {
  const alreadyHeld = enrichedPositions.find(p => p.symbol === coin.symbol);
  if (alreadyHeld) continue;

  // Ensure space BEFORE buying
  if (enrichedPositions.length >= MAX_POSITIONS) {
    let worst = enrichedPositions.reduce((a, b) => a.pnl < b.pnl ? a : b);

    await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [worst.id]);

    await pool.query(
      `INSERT INTO trades(symbol, action, price, capital, pnl)
       VALUES ($1,'SELL (REBALANCE)',$2,$3,$4)`,
      [worst.symbol, worst.currentPrice, worst.capital, worst.pnl]
    );

    enrichedPositions = enrichedPositions.filter(p => p.id !== worst.id);
  }

  // Now safe to buy (guaranteed space)
  const capitalPerTrade = 100 / MAX_POSITIONS;

  await pool.query(
    `INSERT INTO positions(symbol, entry_price, capital, status)
     VALUES ($1,$2,$3,'OPEN')`,
    [coin.symbol, coin.price, capitalPerTrade]
  );

  await pool.query(
    `INSERT INTO trades(symbol, action, price, capital, change, score, volume)
     VALUES ($1,'BUY',$2,$3,$4,$5,$6)`,
    [coin.symbol, coin.price, capitalPerTrade, coin.change, coin.score, coin.volume]
  );

  enrichedPositions.push({
    id: null,
    symbol: coin.symbol,
    entry_price: coin.price,
    pnl: 0,
    capital: capitalPerTrade
  });
}

      // BUY new coin
      const capitalPerTrade = 100 / MAX_POSITIONS;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, status)
         VALUES ($1,$2,$3,'OPEN')`,
        [coin.symbol, coin.price, capitalPerTrade]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital, change, score, volume)
         VALUES ($1,'BUY',$2,$3,$4,$5,$6)`,
        [coin.symbol, coin.price, capitalPerTrade, coin.change, coin.score, coin.volume]
      );

      enrichedPositions.push({
        symbol: coin.symbol,
        entry_price: coin.price,
        pnl: 0
      });
    }

    // ===== EXIT RULES =====
    let activePositions = [];

    for (let pos of enrichedPositions) {
      if (pos.pnl >= 0.02 || pos.pnl <= -0.01) {
        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl)
           VALUES ($1,$2,$3,$4,$5)`,
          [pos.symbol, pos.pnl > 0 ? 'SELL (TP)' : 'SELL (SL)', pos.currentPrice, pos.capital, pos.pnl]
        );

        await updateWeights();
      } else {
        activePositions.push(pos);
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

      <h1>🚀 Multi-Position ML Engine (Rebalancing)</h1>

      <div class="card">
        <h3>Weights</h3>
        Momentum: ${weights.momentum.toFixed(2)}
      </div>

      <div class="card">
        <h3>Top Coins</h3>
        ${top5.map(c => `<div>${c.symbol} (${c.change.toFixed(2)}%)</div>`).join('')}
      </div>

      <div class="card">
        <h3>Active Positions (${activePositions.length})</h3>
        ${activePositions.map(p => `
          <div>${p.symbol} | PnL ${(p.pnl*100).toFixed(2)}%</div>
        `).join('')}
      </div>

      <div class="card">
        <h3>Recent Trades</h3>
        ${trades.map(t => `
          <div>${t.action} ${t.symbol} ${t.pnl ? '('+(t.pnl*100).toFixed(2)+'%)' : ''}</div>
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

// ===== HISTORY =====
app.get('/history', async (req, res) => {
  const trades = (await pool.query(
    `SELECT * FROM trades ORDER BY created_at DESC LIMIT 100`
  )).rows;

  res.send(`<pre>${JSON.stringify(trades, null, 2)}</pre>`);
});

app.listen(3000);
