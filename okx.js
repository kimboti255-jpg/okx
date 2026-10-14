export default {
  async fetch(request, env, ctx) {
    // 1. Fetch Order Book kutoka OKX API (Books-Full Depth 5000)
    const apiUrl = "https://www.okx.com/api/v5/market/books-full?instId=DOGE-USDT-SWAP&sz=5000";

    try {
      // Kuunda table yenye muundo unaofanana 100% na SQLite yako ya kawaida
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS active_orders (
            price REAL PRIMARY KEY,
            side TEXT,
            amount REAL,
            value REAL,
            first_seen INTEGER,
            last_seen INTEGER
        )
      `).run();

      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        return new Response(JSON.stringify({ status: "error", message: "Failed to fetch OKX API data" }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const data = await response.json();

      if (!data.code || data.code !== '0' || !data.data || !data.data[0]) {
        return new Response(JSON.stringify({ status: "error", message: "Invalid JSON structure from OKX" }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const MIN_USD_VALUE = 300000; // Filter ya $300K+
      const LIMIT_PER_SIDE = 5000;  // LIMIT YA ODA 5000
      const CONTRACT_SIZE = 1000;   // Mkataba 1 wa DOGE-USDT-SWAP OKX = 1000 DOGE

      const bookData = data.data[0];
      const rawBids = bookData.bids || [];
      const rawAsks = bookData.asks || [];

      // 2. KUWEKA LIMIT YA ODA 5000 ZA KARIBU ZAIDI
      rawBids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
      const limitedBids = rawBids.slice(0, LIMIT_PER_SIDE);

      rawAsks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
      const limitedAsks = rawAsks.slice(0, LIMIT_PER_SIDE);

      const now = Math.floor(Date.now() / 1000);
      const currentPrices = [];
      const rawLargeOrders = {};

      // Kuchuja Bids zilizofikisha $300K+
      for (const bid of limitedBids) {
        const price = parseFloat(bid[0]);
        const contracts = parseFloat(bid[1]);
        const amount = contracts * CONTRACT_SIZE;
        const usdValue = price * amount;

        if (usdValue >= MIN_USD_VALUE) {
          currentPrices.push(price);
          rawLargeOrders[price.toString()] = {
            side: 'bid',
            price: price,
            amount: amount,
            value: usdValue
          };
        }
      }

      // Kuchuja Asks zilizofikisha $300K+
      for (const ask of limitedAsks) {
        const price = parseFloat(ask[0]);
        const contracts = parseFloat(ask[1]);
        const amount = contracts * CONTRACT_SIZE;
        const usdValue = price * amount;

        if (usdValue >= MIN_USD_VALUE) {
          currentPrices.push(price);
          rawLargeOrders[price.toString()] = {
            side: 'ask',
            price: price,
            amount: amount,
            value: usdValue
          };
        }
      }

      // 3. Database Sync na Kuhifadhi kwenye Cloudflare D1
      if (currentPrices.length > 0) {
        const placeholders = currentPrices.map(() => '?').join(',');
        await env.DB.prepare(`DELETE FROM active_orders WHERE price NOT IN (${placeholders})`).bind(...currentPrices).run();
      } else {
        await env.DB.prepare(`DELETE FROM active_orders`).run();
      }

      for (const priceStr in rawLargeOrders) {
        const order = rawLargeOrders[priceStr];
        const priceFloat = parseFloat(priceStr);

        // Angalia kama bei ilikuwepo ili kuhifadhi 'first_seen' yake ya asili
        const existing = await env.DB.prepare(`SELECT first_seen FROM active_orders WHERE price = ?`).bind(priceFloat).first();
        const firstSeen = existing ? existing.first_seen : now;

        await env.DB.prepare(`
          INSERT OR REPLACE INTO active_orders (price, side, amount, value, first_seen, last_seen) 
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(priceFloat, order.side, order.amount, order.value, firstSeen, now).run();
      }

      // Function ya format USD ($1.55M, $450K, $300K)
      function formatUsdValue(val) {
        if (val >= 1000000) {
          return '$' + (val / 1000000).toFixed(2) + 'M';
        } else if (val >= 1000) {
          return '$' + Math.round(val / 1000) + 'K';
        }
        return '$' + val.toFixed(2);
      }

      // 4. Tengeneza Output
      const { results: activeDbOrders } = await env.DB.prepare(`SELECT * FROM active_orders ORDER BY price DESC`).all();

      const bids = [];
      const asks = [];

      for (const row of activeDbOrders) {
        const durationSeconds = now - row.first_seen;
        const durationMinutes = Math.round((durationSeconds / 60) * 10) / 10;
        const firstSeenIso = new Date(row.first_seen * 1000).toISOString();

        const formattedOrder = {
          id: row.side + "-" + row.price,
          type: row.side,
          price: row.price,
          amount: row.amount,
          value: row.value,
          value_formatted: formatUsdValue(row.value),
          duration_minutes: durationMinutes,
          first_seen_iso: firstSeenIso
        };

        if (row.side === 'bid') {
          bids.push(formattedOrder);
        } else {
          asks.push(formattedOrder);
        }
      }

      const output = {
        status: "success",
        timestamp: new Date().toISOString(),
        bids_count: bids.length,
        asks_count: asks.length,
        bids: bids,
        asks: asks
      };

      return new Response(JSON.stringify(output, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ status: "error", message: err.message }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
