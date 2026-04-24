const express = require('express');
const axios = require('axios');

const app = express();

app.get('/', async (req, res) => {
  try {
    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    const coins = response.data.slice(0, 10).map(c => {
      const change = parseFloat(c.priceChangePercent);

      let signal = "HOLD";

      if (change > 2) signal = "BUY";
      if (change < -2) signal = "SELL";

      return {
        symbol: c.symbol,
        price: c.lastPrice,
        change: change,
        signal: signal
      };
    });

    res.json({
      message: "Crypto ML Decision Engine 🚀",
      decisions: coins
    });

  } catch (err) {
    res.send("Error fetching data");
  }
});

app.listen(3000, () => {
  console.log('Server running');
});
