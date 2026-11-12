// Store Gap Finder v0.1
// What it does: for each shop you list, it reads the public Apify Store, measures how well the shop
// is served by existing Actors, checks whether the E-commerce Scraping Tool (ECST) supports the shop,
// and writes one ranked row per shop to the dataset.
// It only reads public Apify Store data. It does not scrape any shop.

import { Actor, log } from 'apify';

const STORE_API = 'https://api.apify.com/v2/store';
const ECST = 'apify~e-commerce-scraping-tool';
const PAUSE_MS = 400; // be polite to the API: one request at a time, with a short pause

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n, digits = 2) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
// "Best Buy" and "bestbuy" and "BestBuy" should all match, so we compare letters and digits only.
const compact = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// One place for all web requests. Retries once if the API is busy (HTTP 429) or has a hiccup (5xx).
async function getJson(url, attempt = 1) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
        if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
            await sleep(2000);
            return getJson(url, attempt + 1);
        }
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return (await response.json()).data;
}

// Price of the main billing event, per 1,000 results, in USD (Free-plan price when tiered).
function pricePer1000(pricingInfo) {
    const events = pricingInfo?.pricingPerEvent?.actorChargeEvents;
    if (events) {
        const candidates = Object.entries(events).filter(([key]) => key !== 'apify-actor-start');
        const main = candidates.find(([, event]) => event.isPrimaryEvent) ?? candidates[0];
        if (!main) return null;
        const event = main[1];
        const price = event.eventPriceUsd ?? event.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd;
        return price == null ? null : round(price * 1000);
    }
    if (pricingInfo?.pricePerUnitUsd != null) return round(pricingInfo.pricePerUnitUsd * 1000);
    return null; // free or monthly-rental Actors have no per-result price
}

// The list of shops ECST supports out of the box, read from ECST's own input form (its "input schema").
async function loadEcstMarketplaces() {
    try {
        const build = await getJson(`https://api.apify.com/v2/acts/${ECST}/builds/default`);
        const schema = JSON.parse(build.inputSchema);
        return schema.properties.marketplaces.items.enum; // e.g. "www.amazon.com", "allegro.pl"
    } catch (error) {
        log.warning(`Could not read ECST marketplaces, ecstCovered will be empty. ${error.message}`);
        return null;
    }
}

// Snapshot of ECST itself, saved so you can compare it on a later run.
async function loadEcstSnapshot() {
    try {
        const act = await getJson(`https://api.apify.com/v2/acts/${ECST}`);
        const stats = act.stats ?? {};
        return {
            totalUsers: stats.totalUsers,
            totalUsers7Days: stats.totalUsers7Days,
            totalUsers30Days: stats.totalUsers30Days,
            totalRuns: stats.totalRuns,
            publicActorRunStats30Days: stats.publicActorRunStats30Days,
        };
    } catch (error) {
        log.warning(`Could not read ECST stats. ${error.message}`);
        return null;
    }
}

const mean = (numbers) => (numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null);

// Turn the Store listings for one shop into one row of signals plus a simple, explainable gap score.
function analyseShop({ shop, storeMatches, items, ecstDomains, snapshotDate }) {
    const token = compact(shop);

    // Keep Actors whose title, name or developer contains the shop name (the Store search is broad).
    // Drop "side job" Actors (reviews, stock checkers, trackers): they do a different job than product
    // scraping, so their prices and ratings would distort the comparison.
    const sideJob = /review|stock|tracker|seller|sentiment|inventory|restock|alert/i;
    const relevant = items
        .filter((item) => compact(`${item.title} ${item.name} ${item.username}`).includes(token))
        .filter((item) => !sideJob.test(`${item.title} ${item.name}`))
        .map((item) => {
            const stats = item.stats ?? {};
            const runs30 = stats.publicActorRunStats30Days ?? {};
            return {
                fullName: `${item.username}/${item.name}`,
                url: item.url,
                users: stats.totalUsers ?? 0,
                users30: stats.totalUsers30Days ?? 0,
                runs30: runs30.TOTAL ?? 0,
                succeeded30: runs30.SUCCEEDED ?? 0,
                rating: item.actorReviewRating ?? null,
                reviews: item.actorReviewCount ?? 0,
                price: pricePer1000(item.currentPricingInfo),
            };
        })
        .sort((a, b) => b.users - a.users);

    const top = relevant[0] ?? null;
    const top3 = relevant.slice(0, 3);
    const top3Ratings = top3.filter((a) => a.reviews >= 3 && a.rating != null).map((a) => a.rating);
    const avgRatingTop3 = mean(top3Ratings);
    // Ignore tiny "prices" under $0.10 per 1,000: they are platform accounting events, not real prices.
    const prices = relevant.map((a) => a.price).filter((p) => p != null && p >= 0.1);
    const priceMin = prices.length ? Math.min(...prices) : null;
    const priceMax = prices.length ? Math.max(...prices) : null;
    // Spread only means something when there are at least 3 priced Actors to compare.
    const priceSpread = prices.length >= 3 ? round(priceMax / priceMin, 1) : null;
    const runs30All = relevant.reduce((sum, a) => sum + a.runs30, 0);
    const succeeded30All = relevant.reduce((sum, a) => sum + a.succeeded30, 0);
    const successRate30d = runs30All >= 50 ? round(succeeded30All / runs30All, 3) : null;
    const ecstCovered = ecstDomains ? ecstDomains.some((domain) => compact(domain).includes(token)) : null;

    // Gap score: more points = bigger gap. Every point has a reason, so the number can be explained.
    let score = 0;
    const reasons = [];
    if (!top) {
        score += 3;
        reasons.push('no Actor found for this shop');
    } else if (top.users < 500) {
        score += 2;
        reasons.push(`thin supply, biggest Actor has only ${top.users} users`);
    } else if (top.users < 2000) {
        score += 1;
        reasons.push(`modest supply, biggest Actor has ${top.users} users`);
    }
    if (avgRatingTop3 != null && avgRatingTop3 < 3.5) {
        score += 2;
        reasons.push(`low ratings, top Actors average ${round(avgRatingTop3, 1)} stars`);
    }
    if (successRate30d != null && successRate30d < 0.9) {
        score += 1;
        reasons.push(`unreliable, ${Math.round(successRate30d * 100)}% of recent runs succeeded`);
    }
    if (priceSpread != null && priceSpread >= 5) {
        score += 1;
        reasons.push(`prices differ ${priceSpread} times between Actors`);
    }
    if (ecstCovered === false) {
        score += 1;
        reasons.push('not in ECST preset list');
    }

    return {
        snapshotDate,
        shop,
        gapScore: score,
        gapReading: reasons.length ? reasons.join('; ') : 'well served',
        storeMatches, // all Store results for this search term (broad)
        relevantActors: relevant.length, // those that really name the shop, among the ones we read
        topActor: top?.fullName ?? null,
        topActorUrl: top?.url ?? null,
        topActorUsers: top?.users ?? null,
        topActorUsers30d: top?.users30 ?? null,
        topActorMonthlyRatio: top && top.users ? round(top.users30 / top.users, 3) : null,
        avgRatingTop3: round(avgRatingTop3, 2),
        runs30dAllRelevant: runs30All,
        successRate30d,
        priceMinPer1000: priceMin,
        priceMaxPer1000: priceMax,
        priceSpread,
        ecstCovered,
    };
}

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    shops = ['Walmart', 'Zalando', 'Alza'],
    maxActorsPerShop = 50,
    category = 'ECOMMERCE',
} = input;

const cleanShops = [...new Set(shops.map((s) => String(s).trim()).filter(Boolean))];
if (cleanShops.length === 0) {
    await Actor.fail('Please give at least one shop name in the "shops" input.');
}

const snapshotDate = new Date().toISOString().slice(0, 10);
log.info(`Store Gap Finder: ${cleanShops.length} shops, up to ${maxActorsPerShop} Actors each, category ${category}.`);

const ecstDomains = await loadEcstMarketplaces();
if (ecstDomains) log.info(`ECST preset list has ${ecstDomains.length} marketplaces.`);
await sleep(PAUSE_MS);

const rows = [];
for (const shop of cleanShops) {
    try {
        const url = `${STORE_API}?search=${encodeURIComponent(shop)}&category=${encodeURIComponent(category)}`
            + `&sortBy=popularity&limit=${maxActorsPerShop}`;
        const data = await getJson(url);
        const row = analyseShop({ shop, storeMatches: data.total, items: data.items ?? [], ecstDomains, snapshotDate });
        rows.push(row);
        log.info(`${shop}: gapScore ${row.gapScore} (${row.gapReading})`);
    } catch (error) {
        log.error(`Failed for "${shop}": ${error.message}`);
        rows.push({ snapshotDate, shop, gapScore: null, gapReading: `error: ${error.message}` });
    }
    await sleep(PAUSE_MS);
}

// Biggest gap first. Rows with an error go to the bottom.
rows.sort((a, b) => (b.gapScore ?? -1) - (a.gapScore ?? -1));

// The dataset holds the result table. One row per shop.
await Actor.pushData(rows);

// The key-value store holds single files. We keep a dated snapshot of ECST itself for later comparison.
const ecstSnapshot = await loadEcstSnapshot();
if (ecstSnapshot) await Actor.setValue('ECST_SNAPSHOT', { snapshotDate, ...ecstSnapshot });

log.info(`Done. ${rows.length} rows written to the dataset.`);
await Actor.exit();
