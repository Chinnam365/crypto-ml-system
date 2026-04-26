const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   IN-MEMORY STATE (Render-safe)
========================= */

let portfolio = {
  capital: 100,
  cash: 100
};

let positions = [];
let trades = [];

let weights = {
  momentum: 1,
  crash: 1
};

let stats = {
  wins: 0,
  losses: 0,
  total: 0
};

/* =========================
   SAFE HELPERS
========================= */

function safe(n, def = 0) {
  return isFinite(n) ? n : def;
}

/* =========================
   MARKET DATA
========================= */

async function getMarket() {
  const res = await axios.get(
    "https://api.binance.com/api/v3/ticker/24hr"
  );

  return res.data
    .filter(c => c.symbol.endsWith("USDT"))
    .map(c => ({
      symbol: c.symbol,
      change: parseFloat(c.priceChangePercent),
      volume: parseFloat(c.quoteVolume),
      price: parseFloat(c.lastPrice)
    }));
}

/* =========================
   STRATEGY (Momentum + Crash)
========================= */

function scoreCoins(coins) {
  return coins.map(c => {
    let score = 0;
    let strategy = "momentum";

    // momentum
    score += weights.momentum * safe(c.change);

    // crash buy (oversold bounce)
    if (c.change < -5) {
      score += weights.crash * Math.abs(c.change);
      strategy = "crash";
    }

    return { ...c, score, strategy };
  });
}

/* =========================
   SELECT TOP 5
========================= */

function pickTop(coins) {
  return coins
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/* =========================
   TRADING ENGINE
========================= */

function trade(topCoins) {
  const allocation = portfolio.cash / 5;

  topCoins.forEach(coin => {
    if (portfolio.cash <= 0) return;

    const qty = allocation / coin.price;
    if (!isFinite(qty) || qty <= 0) return;

    positions.push({
      symbol: coin.symbol,
      entry: coin.price,
      quantity: qty,
      capital: allocation,
      strategy: coin.strategy
    });

    portfolio.cash -= allocation;

    trades.push(`BUY ${coin.symbol}`);
  });
}

/* =========================
   POSITION UPDATE
========================= */

function updatePositions(coins) {
  const updated = [];

  positions.forEach(p => {
    const coin = coins.find(c => c.symbol === p.symbol);
    if (!coin) return;

    const value = safe(p.quantity) * safe(coin.price);
    const pnl = safe((value - p.capital) / p.capital);

    if (!isFinite(pnl)) return;

    // SELL RULES
    if (pnl > 0.02 || pnl < -0.02) {
      portfolio.cash += value;

      trades.push(`SELL ${p.symbol} (${(pnl * 100).toFixed(2)}%)`);

      stats.total++;
      if (pnl > 0) stats.wins++;
      else stats.losses++;

      // LEARNING
      if (p.strategy === "momentum") {
        weights.momentum += pnl > 0 ? 0.05 : -0.05;
      } else {
        weights.crash += pnl > 0 ? 0.05 : -0.05;
      }

    } else {
      updated.push({
        ...p,
        pnl
      });
    }
  });

  positions = updated;
}

/* =========================
   TOTAL VALUE
========================= */

function getTotal(coins) {
  let total = safe(portfolio.cash);

  positions.forEach(p => {
    const coin = coins.find(c => c.symbol === p.symbol);
    if (!coin) return;

    const value = safe(p.quantity) * safe(coin.price);
    if (isFinite(value)) total += value;
  });

  return total;
}

/* =========================
   DASHBOARD
========================= */

app.get("/", async (req, res) => {
  try {
    const coins = await getMarket();

    const scored = scoreCoins(coins);
    const top = pickTop(scored);

    // trade only if no positions
    if (positions.length === 0) {
      trade(top);
    }

    updatePositions(coins);

    const total = getTotal(coins);

    res.send(`
    <html>
    <body style="background:#0b1220;color:white;font-family:sans-serif;padding:20px">

    <h1>🧠 ML Engine (Stable)</h1>

    <p>💰 Total: €${safe(total).toFixed(2)}</p>
    <p>💵 Cash: €${safe(portfolio.cash).toFixed(2)}</p>

    <h3>📊 Performance</h3>
    <p>Trades: ${stats.total}</p>
    <p>Win Rate: ${
      stats.total ? ((stats.wins / stats.total) * 100).toFixed(2) : 0
    }%</p>

    <h3>⚙️ Weights</h3>
    <p>Momentum: ${safe(weights.momentum).toFixed(2)}</p>
    <p>Crash: ${safe(weights.crash).toFixed(2)}</p>

    <h3>🏆 Top 5</h3>
    ${top.map(c => `<p>${c.symbol} (${c.strategy})</p>`).join("")}

    <h3>📦 Positions (${positions.length})</h3>
    ${positions.map(p =>
      `<p>${p.symbol} (${p.strategy}) | ${(safe(p.pnl) * 100).toFixed(2)}%</p>`
    ).join("")}

    <h3>📜 Trades</h3>
    ${trades.slice(-10).map(t => `<p>${t}</p>`).join("")}

    <br/>
    <a href="/reset" style="color:cyan">Reset</a>

    </body>
    </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

/* =========================
   RESET
========================= */

app.get("/reset", (req, res) => {
  portfolio = { capital: 100, cash: 100 };
  positions = [];
  trades = [];
  weights = { momentum: 1, crash: 1 };
  stats = { wins: 0, losses: 0, total: 0 };

  res.send("Reset done");
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
