const express = require('express');
const axios = require('axios');

const app = express();

// simple memory (will improve later)
let capital = 100;

app.get('/', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    let trades = [];

    const coins = response.data.slice(0, 10).map(c => {
      const change = parseFloat(c.priceChangePercent);

      let signal = "HOLD";

      if (change > 2) signal = "BUY";
      if (change < -2) signal = "SELL";

      // simulate simple trading
      if (signal === "BUY") {
        capital *= 1.01; // +1%
        trades.push(`BUY ${c.symbol}`);
      }

      if (signal === "SELL") {
        capital *= 0.99; // -1%
        trades.push(`SELL ${c.symbol}`);
      }

      return {
        symbol: c.symbol,
        change: change,
        signal: signal
      };
    });

    res.json({
      message: "Paper Trading Engine 🚀",
      capital: capital.toFixed(2),
      trades: trades,
      decisions: coins
    });

  } catch (err) {
    res.send("Error fetching data");
  }
});

app.listen(3000, () => {
  console.log('Server running');
});
