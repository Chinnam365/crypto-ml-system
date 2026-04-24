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
    CREATE TABLE IF NOT EXISTS equity (
      id SERIAL PRIMARY KEY,
      value FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_weights (
      id INT PRIMARY KEY,
      m5 FLOAT,
      m15 FLOAT,
      m1h FLOAT,
      m4h FLOAT,
      m24h FLOAT,
      volume FLOAT,
      recovery FLOAT
    )
  `);

  await pool.query(`
    INSERT INTO model_weights VALUES (1,1,1,1,1,1,1,1)
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS strategy TEXT`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy TEXT`);

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
  await pool.query(`DELETE FROM equity`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);
  await pool.query(`
    UPDATE model_weights SET m5=1,m15=1,m1h=1,m4h=1,m24h=1,volume=1,recovery=1 WHERE id=1
  `);
  res.send("Reset complete");
});

// ===== MOMENTUM =====
async function getMomentum(symbol, interval) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=2`
    );
    const prev = parseFloat(res.data[0][4]);
    const last = parseFloat(res.data[1][4]);
    return ((last - prev) / prev) * 100;
  } catch {
    return 0;
  }
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

    const weights = (await pool.query(`SELECT * FROM model_weights WHERE id=1`)).rows[0];

    let coins = response.data
      .filter(c => c.symbol.endsWith("USDT"))
      .slice(0, 40) // limit API load
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.quoteVolume)
      }));

    const enrichedCoins = [];

    for (let c of coins) {

      const m5 = await getMomentum(c.symbol, '5m');
      const m15 = await getMomentum(c.symbol, '15m');
      const m1h = await getMomentum(c.symbol, '1h');
      const m4h = await getMomentum(c.symbol, '4h');
      const m24h = c.change;

      const volume = Math.log10(c.volume + 1);
      const recovery = m24h < -10 ? Math.abs(m24h) : 0;

      const score =
        weights.m5 * m5 +
        weights.m15 * m15 +
        weights.m1h * m1h +
        weights.m4h * m4h +
        weights.m24h * m24h +
        weights.volume * volume +
        weights.recovery * recovery;

      enrichedCoins.push({ ...c, score });
    }

    const top5 = enrichedCoins.sort((a, b) => b.score - a.score).slice(0, 5);

    // ===== LOAD POSITIONS =====
    let positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy,'ml') as strategy,
             status
      FROM positions WHERE status='OPEN'
    `)).rows;

    let enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== SELL NON-TOP =====
    for (let pos of enriched) {
      if (!top5.find(c => c.symbol === pos.symbol)) {

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);
        portfolio.capital += pos.value;

        // LEARNING
        const lr = 0.001;

        weights.m5  += lr * pos.pnl;
        weights.m15 += lr * pos.pnl;
        weights.m1h += lr * pos.pnl;
        weights.m4h += lr * pos.pnl;
        weights.m24h+= lr * pos.pnl;

        weights.volume += lr * pos.pnl;
        weights.recovery += lr * pos.pnl * (pos.pnl < 0 ? 1 : 0);

        await pool.query(`
          UPDATE model_weights
          SET m5=$1,m15=$2,m1h=$3,m4h=$4,m24h=$5,volume=$6,recovery=$7
          WHERE id=1
        `, [
          weights.m5, weights.m15, weights.m1h,
          weights.m4h, weights.m24h,
          weights.volume, weights.recovery
        ]);

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl, strategy)
           VALUES ($1,'SELL',$2,$3,$4,'ml')`,
          [pos.symbol, pos.price, pos.value, pos.pnl]
        );
      }
    }

    // ===== RELOAD =====
    positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy,'ml') as strategy,
             status
      FROM positions WHERE status='OPEN'
    `)).rows;

    const allocation = portfolio.capital / MAX_POSITIONS;

    for (let coin of top5) {

      if (positions.find(p => p.symbol === coin.symbol)) continue;
      if (portfolio.capital < allocation) continue;

      const qty = allocation / coin.price;
      portfolio.capital -= allocation;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, quantity, strategy, status)
         VALUES ($1,$2,$3,$4,'ml','OPEN')`,
        [coin.symbol, coin.price, allocation, qty]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital, strategy)
         VALUES ($1,'BUY',$2,$3,'ml')`,
        [coin.symbol, coin.price, allocation]
      );
    }

    // ===== FINAL =====
    positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy,'ml') as strategy,
             status
      FROM positions WHERE status='OPEN'
    `)).rows;

    enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl };
    }).filter(Boolean);

    let total = portfolio.capital;
    enriched.forEach(p => total += p.value);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);
    await pool.query(`INSERT INTO equity(value) VALUES ($1)`, [total]);

    const trades = await pool.query(`SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`);
    const equity = await pool.query(`SELECT * FROM equity ORDER BY created_at ASC LIMIT 50`);

    res.send(`
      <body style="background:#0f172a;color:white;padding:20px;font-family:Arial">

      <h1>🚀 Multi-Timeframe ML Engine</h1>

      <div>Total: €${total.toFixed(2)}</div>
      <div>Cash: €${portfolio.capital.toFixed(2)}</div>
      <div>BTC: ${btcChange.toFixed(2)}% (${regime})</div>

      <h3>Weights</h3>
      <div>m5: ${weights.m5.toFixed(3)}</div>
      <div>m15: ${weights.m15.toFixed(3)}</div>
      <div>m1h: ${weights.m1h.toFixed(3)}</div>
      <div>m4h: ${weights.m4h.toFixed(3)}</div>
      <div>m24h: ${weights.m24h.toFixed(3)}</div>

      <h3>Top 5</h3>
      ${top5.map(c => `<div>${c.symbol} (${c.score.toFixed(2)})</div>`).join('')}

      <h3>Positions (${enriched.length})</h3>
      ${enriched.map(p => `<div>${p.symbol} ${(p.pnl*100).toFixed(2)}%</div>`).join('')}

      <h3>Recent Trades</h3>
      ${trades.rows.map(t => `<div>${t.action} ${t.symbol}</div>`).join('')}

      <h3>Equity</h3>
      <canvas id="chart"></canvas>

      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script>
      new Chart(document.getElementById('chart'), {
        type: 'line',
        data: {
          labels: ${JSON.stringify(equity.rows.map((_, i) => i))},
          datasets: [{
            label: 'Portfolio',
            data: ${JSON.stringify(equity.rows.map(e => e.value))},
            borderColor: 'lime'
          }]
        }
      });
      </script>

      </body>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }

  global.running = false;
});

app.listen(3000);
