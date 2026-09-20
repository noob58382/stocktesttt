import {
  PRODUCTS,
  STORES,
  APPLE_API,
  POLL_DELAY_MS
} from "./config.js";


const APPLE_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-HK,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Referer": "https://www.apple.com/hk-zh/shop/buy-iphone",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/140.0.0.0 Safari/537.36"
};


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
}


function getTodayString() {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(new Date());
}


function getHongKongTime() {
  return new Intl.DateTimeFormat(
    "zh-HK",
    {
      timeZone: "Asia/Hong_Kong",
      dateStyle: "short",
      timeStyle: "medium"
    }
  ).format(new Date());
}


function containsToday(text) {
  if (!text) {
    return false;
  }

  const value = String(text).toLowerCase();

  return (
    value.includes("today") ||
    value.includes("今日") ||
    value.includes("今天")
  );
}


function isAvailableToday(part) {
  if (!part || typeof part !== "object") {
    return false;
  }

  const pickupDisplay =
    String(part.pickupDisplay || "").toLowerCase();

  const storePickEligible =
    part.storePickEligible === true;

  const storePickupQuote =
    String(part.storePickupQuote || "");

  const pickupSearchQuote =
    String(part.pickupSearchQuote || "");

  const pickupMessage =
    String(part.pickupMessage || "");

  const message =
    `${storePickupQuote} ` +
    `${pickupSearchQuote} ` +
    `${pickupMessage}`;

  return (
    pickupDisplay === "available" &&
    storePickEligible &&
    containsToday(message)
  );
}


function getPickupQuote(part) {
  return (
    part.storePickupQuote ||
    part.pickupSearchQuote ||
    part.pickupMessage ||
    "今日"
  );
}


function buildAppleUrl(partNumber, storeId) {
  const params = new URLSearchParams();

  params.set("pl", "true");
  params.set("mts.0", "regular");
  params.set("parts.0", partNumber);
  params.set("store", storeId);

  return `${APPLE_API}?${params.toString()}`;
}


async function fetchStoreStock(product, store) {
  const url = buildAppleUrl(
    product.partNumber,
    store.id
  );

  console.log(
    `Checking ${store.id} ${store.name}`
  );

  console.log(url);

  let response;

  try {
    response = await fetch(
      url,
      {
        method: "GET",
        headers: APPLE_HEADERS,
        redirect: "follow",
        cf: {
          cacheTtl: 0,
          cacheEverything: false
        }
      }
    );
  } catch (error) {
    console.error(
      `Apple request failed for ${store.id}:`,
      error
    );

    return {
      ok: false,
      store,
      product,
      error: String(error)
    };
  }

  console.log(
    `${store.id} HTTP ${response.status}`
  );

  if (!response.ok) {
    const text =
      await response.text();

    console.error(
      `${store.id} Apple returned HTTP ${response.status}`
    );

    console.error(
      text.slice(0, 500)
    );

    return {
      ok: false,
      store,
      product,
      status: response.status,
      error: `HTTP ${response.status}`
    };
  }

  let data;

  try {
    data = await response.json();
  } catch (error) {
    return {
      ok: false,
      store,
      product,
      status: response.status,
      error: "Apple response was not JSON"
    };
  }

  const stores =
    data?.body?.stores;

  if (!Array.isArray(stores)) {
    return {
      ok: false,
      store,
      product,
      status: response.status,
      error: "body.stores is missing"
    };
  }

  const appleStore =
    stores.find(
      item =>
        item.storeNumber === store.id
    ) || stores[0];

  if (!appleStore) {
    return {
      ok: false,
      store,
      product,
      status: response.status,
      error: "Store not found in Apple response"
    };
  }

  const partsAvailability =
    appleStore.partsAvailability || {};

  const part =
    partsAvailability[
      product.partNumber
    ];

  if (!part) {
    return {
      ok: false,
      store,
      product,
      status: response.status,
      error:
        `Part ${product.partNumber} ` +
        `not found in partsAvailability`
    };
  }

  const availableToday =
    isAvailableToday(part);

  console.log(
    `${store.id} ${product.partNumber} ` +
    `availableToday=${availableToday} ` +
    `pickupDisplay=${part.pickupDisplay}`
  );

  return {
    ok: true,
    store,
    product,
    availableToday,
    pickupDisplay:
      part.pickupDisplay || "",
    storePickEligible:
      part.storePickEligible === true,
    pickupQuote:
      getPickupQuote(part),
    rawPart: part
  };
}


async function checkAllStock() {
  const results = [];

  for (const product of PRODUCTS) {
    for (const store of STORES) {

      const result =
        await fetchStoreStock(
          product,
          store
        );

      results.push(result);

      await sleep(
        POLL_DELAY_MS
      );
    }
  }

  return results;
}


async function getPreviousStates(db) {
  const result =
    await db
      .prepare(
        `
        SELECT
          part_number,
          store_id,
          available
        FROM stock_state
        `
      )
      .all();

  const map = new Map();

  for (const row of result.results || []) {
    const key =
      `${row.part_number}:${row.store_id}`;

    map.set(
      key,
      Number(row.available) === 1
    );
  }

  return map;
}


async function saveStates(db, results) {
  const statements = [];

  const now =
    Date.now();

  for (const result of results) {

    if (!result.ok) {
      continue;
    }

    statements.push(
      db
        .prepare(
          `
          INSERT INTO stock_state (
            part_number,
            store_id,
            store_name,
            available,
            pickup_quote,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(part_number, store_id)
          DO UPDATE SET
            store_name = excluded.store_name,
            available = excluded.available,
            pickup_quote = excluded.pickup_quote,
            updated_at = excluded.updated_at
          `
        )
        .bind(
          result.product.partNumber,
          result.store.id,
          result.store.name,
          result.availableToday ? 1 : 0,
          result.pickupQuote,
          now
        )
    );
  }

  if (statements.length > 0) {
    await db.batch(
      statements
    );
  }
}


async function sendTelegram(
  env,
  message
) {
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_CHAT_ID
  ) {
    throw new Error(
      "Telegram secrets are missing"
    );
  }

  const url =
    `https://api.telegram.org/bot` +
    `${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response =
    await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          chat_id:
            env.TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview:
            false
        })
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Telegram HTTP ${response.status}: ${text}`
    );
  }

  return true;
}


function buildTelegramMessage(matches) {
  const now =
    getHongKongTime();

  const lines = [
    `🚨📱 Apple Store 有貨`,
    `⏰ ${now}`,
    ""
  ];

  for (const item of matches) {

    lines.push(
      `• ${item.product.name}`
    );

    lines.push(
      `  🏪 ${item.store.name}`
    );

    lines.push(
      `  📦 備妥於：${item.pickupQuote}`
    );

    lines.push("");
  }

  lines.push(
    "🔗 Apple：",
    PRODUCTS[0].productUrl
  );

  return lines.join("\n");
}


async function processInventory(env) {

  console.log(
    "=================================================="
  );

  console.log(
    "🍎 Apple Hong Kong Stock Monitor"
  );

  console.log(
    `Time: ${getHongKongTime()}`
  );

  console.log(
    `Products: ${PRODUCTS.length}`
  );

  console.log(
    `Stores: ${STORES.length}`
  );

  console.log(
    "=================================================="
  );

  const previousStates =
    await getPreviousStates(
      env.DB
    );

  const results =
    await checkAllStock();

  const successfulResults =
    results.filter(
      result => result.ok
    );

  const failedResults =
    results.filter(
      result => !result.ok
    );

  console.log(
    `Successful checks: ${successfulResults.length}`
  );

  console.log(
    `Failed checks: ${failedResults.length}`
  );

  if (
    successfulResults.length === 0
  ) {
    throw new Error(
      "All Apple inventory checks failed. " +
      "State was NOT changed."
    );
  }

  const newStock =
    [];

  for (
    const result
    of successfulResults
  ) {

    if (!result.availableToday) {
      continue;
    }

    const key =
      `${result.product.partNumber}:` +
      `${result.store.id}`;

    const previouslyAvailable =
      previousStates.get(
        key
      ) === true;

    if (!previouslyAvailable) {

      newStock.push(
        result
      );
    }
  }

  if (newStock.length > 0) {

    console.log(
      `🚨 New stock detected: ${newStock.length}`
    );

    const message =
      buildTelegramMessage(
        newStock
      );

    await sendTelegram(
      env,
      message
    );

    console.log(
      "✅ Telegram notification sent."
    );
  } else {

    console.log(
      "No new today-pickup stock."
    );
  }

  await saveStates(
    env.DB,
    successfulResults
  );

  return {
    checked:
      successfulResults.length,
    failed:
      failedResults.length,
    newStock:
      newStock.length
  };
}


async function authenticate(request, env) {
  const url =
    new URL(request.url);

  const key =
    url.searchParams.get(
      "key"
    );

  return (
    !!env.ADMIN_KEY &&
    key === env.ADMIN_KEY
  );
}


export default {

  async scheduled(
    controller,
    env,
    ctx
  ) {

    ctx.waitUntil(
      processInventory(env)
        .catch(error => {
          console.error(
            "Inventory monitor failed:",
            error
          );
        })
    );
  },


  async fetch(
    request,
    env
  ) {

    const url =
      new URL(request.url);

    if (
      url.pathname === "/"
    ) {
      return json({
        service:
          "Apple Hong Kong Stock Monitor",
        status:
          "online",
        time:
          getHongKongTime()
      });
    }


    if (
      url.pathname === "/health"
    ) {
      return json({
        ok: true,
        service:
          "apple-hk-stock-monitor"
      });
    }


    if (
      url.pathname === "/test"
    ) {

      if (
        !(await authenticate(
          request,
          env
        ))
      ) {
        return json(
          {
            error:
              "Unauthorized"
          },
          401
        );
      }

      await sendTelegram(
        env,
        [
          "🧪 TEST — Apple Stock Monitor",
          "",
          "🚨📱 測試通知",
          "• iPhone 18 Pro 512GB 冰川色",
          "• TEST Apple Store",
          "📦 備妥於：今日",
          "",
          "⚠️ 呢個係測試訊息，唔代表真實有貨。"
        ].join("\n")
      );

      return json({
        ok: true,
        message:
          "Test Telegram sent"
      });
    }


    if (
      url.pathname === "/run"
    ) {

      if (
        !(await authenticate(
          request,
          env
        ))
      ) {
        return json(
          {
            error:
              "Unauthorized"
          },
          401
        );
      }

      try {

        const result =
          await processInventory(
            env
          );

        return json({
          ok: true,
          result
        });

      } catch (error) {

        return json(
          {
            ok: false,
            error:
              String(error)
          },
          500
        );
      }
    }


    return json(
      {
        error:
          "Not found"
      },
      404
    );
  }
};
