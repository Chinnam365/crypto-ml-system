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

  // Init portfolio
  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }

  // Init weights
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
  res.rows.forEach(t => t.pnl > 0 ? win++ : loss++);

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
    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    const coins = response.data
      .filter(c =>
        c.symbol.endsWith("USDT") &&
        parseFloat(c.volume) > 1000000 &&
        !c.symbol.includes("UP") &&
        !c.symbol.includes("DOWN") &&
        !c.symbol.includes("BULL") &&
        !c.symbol.includes("BEAR")
      )
      .slice(0, 200)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.volume)
      }));

    // ===== SCORING =====
    const scored = coins.map(c => ({
      ...c,
      score: scoreCoin(c, weights)
    }));

    const sorted = scored.sort((a, b) => b.score - a.score);

    // ===== DIVERSIFIED TOP 5 =====
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

    // ===== LOAD POSITIONS =====
    let positions = (await pool.query(
      `SELECT * FROM positions WHERE status='OPEN'`
    )).rows;

    // ===== ENRICH =====
    let enriched = positions.map(p => {
      const c = coins.find(x => x.symbol === p.symbol);
      if (!c) return null;

      const value = p.quantity * c.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, currentPrice: c.price, value, pnl };
    }).filter(Boolean);

    // ===== HARD CAP SAFETY =====
    while (enriched.length > MAX_POSITIONS) {
      let worst = enriched.reduce((a, b) => a.pnl < b.pnl ? a : b);

      await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [worst.id]);
      enriched = enriched.filter(p => p.id !== worst.id);
    }

    // ===== EXIT RULES =====
    for (let pos of enriched) {
      if (pos.pnl >= 0.02 || pos.pnl <= -0.01) {
        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);

        portfolio.capital += pos.value;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl)
           VALUES ($1,$2,$3,$4,$5)`,
          [pos.symbol, pos.pnl > 0 ? 'SELL (TP)' : 'SELL (SL)', pos.currentPrice, pos.value, pos.pnl]
        );

        await updateWeights();
      }
    }

    // refresh positions
    positions = (await pool.query(
      `SELECT * FROM positions WHERE status='OPEN'`
    )).rows;

    enriched = positions.map(p => {
      const c = coins.find(x => x.symbol === p.symbol);
      if (!c) return null;

      const value = p.quantity * c.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, currentPrice: c.price, value, pnl };
    }).filter(Boolean);

    // ===== REBALANCING =====
    for (let coin of top5) {
      const alreadyHeld = enriched.find(p => p.symbol === coin.symbol);
      if (alreadyHeld) continue;

      // ensure space
      if (enriched.length >= MAX_POSITIONS) {
        let worst = enriched.reduce((a, b) => a.pnl < b.pnl ? a : b);

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [worst.id]);

        portfolio.capital += worst.value;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl)
           VALUES ($1,'SELL (REBALANCE)',$2,$3,$4)`,
          [worst.symbol, worst.currentPrice, worst.value, worst.pnl]
        );

        enriched = enriched.filter(p => p.id !== worst.id);
      }

      // allocate
      const allocation = portfolio.capital / (MAX_POSITIONS - enriched.length || 1);
      if (allocation <= 0) break;

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
        entry_price: coin.price,
        quantity,
        capital: allocation,
        pnl: 0
      });
    }

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

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

      <h1>🚀 Integrated ML Portfolio Engine</h1>

      <div class="card">
        <b>Capital:</b> €${portfolio.capital.toFixed(2)} <br>
        <b>Momentum Weight:</b> ${weights.momentum.toFixed(2)}
      </div>

      <div class="card">
        <h3>Top Coins</h3>
        ${top5.map(c => `<div>${c.symbol} (${c.change.toFixed(2)}%)</div>`).join('')}
      </div>

      <div class="card">
        <h3>Positions (${enriched.length})</h3>
        ${enriched.map(p => `
          <div>${p.symbol} | ${(p.pnl*100).toFixed(2)}%</div>
        `).join('')}
      </div>

      <div class="card">
        <h3>Recent Trades</h3>
        ${trades.map(t => `
          <div>${t.action} ${t.symbol} ${t.pnl ? '('+(t.pnl*100).toFixed(2)+'%)' : ''}</div>
        `).join('')}
      </div>

      <a href="/history" style="color:lightblue">History</a>

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
