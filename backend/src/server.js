const express = require('express');
const axios = require('axios');

const app = express();

let capital = 100;
let lastPrices = {};

app.get('/', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    let trades = [];

    const coins = response.data.slice(0, 10).map(c => {
      const symbol = c.symbol;
      const price = parseFloat(c.lastPrice);
      const change = parseFloat(c.priceChangePercent);

      let signal = "HOLD";

      if (change > 2) signal = "BUY";
      if (change < -2) signal = "SELL";

      // if we have previous price → calculate real change
      if (lastPrices[symbol]) {
        const prev = lastPrices[symbol];
        const realChange = (price - prev) / prev;

        if (signal === "BUY") {
          capital *= (1 + realChange);
          trades.push(`BUY ${symbol} → ${(realChange * 100).toFixed(2)}%`);
        }

        if (signal === "SELL") {
          capital *= (1 - realChange);
          trades.push(`SELL ${symbol} → ${(realChange * 100).toFixed(2)}%`);
        }
      }

      // update last price
      lastPrices[symbol] = price;

      return {
        symbol,
        price,
        change,
        signal
      };
    });

    res.json({
      message: "Realistic Paper Trading 🚀",
      capital: capital.toFixed(2),
      trades,
      decisions: coins
    });

  } catch (err) {
    res.send("Error fetching data");
  }
});

app.listen(3000, () => {
  console.log('Server running');
});
