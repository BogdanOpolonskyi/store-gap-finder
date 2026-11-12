# Store Gap Finder

An Apify Actor that shows how well the Apify Store covers a list of e-commerce shops. For each shop it measures supply (how many Actors exist, how many people use them, how well they are rated and priced) and checks whether the Apify [E-commerce Scraping Tool](https://apify.com/apify/e-commerce-scraping-tool) supports the shop out of the box. It returns one ranked row per shop.

It reads **public Apify Store data only**. It does not scrape any shop, and it needs no login, proxy or API token. A run should cost cents.

## Input

| Field | Description | Default |
|---|---|---|
| `shops` | Shop names, one per line, for example `Walmart` or `Home Depot` | 10 popular shops |
| `maxActorsPerShop` | How many Store listings to read per shop, most popular first | 50 |
| `category` | Store category to search | `ECOMMERCE` |

## Output

One dataset row per shop, with the biggest gap first:

| Field | Meaning |
|---|---|
| `snapshotDate` | Date of the run |
| `shop` | Shop name from the input |
| `gapScore` | Number from 0 to 7, higher means worse coverage (see below) |
| `gapReading` | The reasons behind the score, in plain words |
| `storeMatches` | Total Store results for the search term (broad) |
| `relevantActors` | Actors among those read whose title, name or developer contains the shop name |
| `topActor`, `topActorUrl` | Most used relevant Actor |
| `topActorUsers`, `topActorUsers30d`, `topActorMonthlyRatio` | Its total users, users in the last 30 days, and their ratio |
| `avgRatingTop3` | Average rating of the three most used relevant Actors (each with 3 or more reviews) |
| `runs30dAllRelevant`, `successRate30d` | Runs in the last 30 days across relevant Actors, and the share that succeeded |
| `priceMinPer1000`, `priceMaxPer1000`, `priceSpread` | Price range per 1,000 results (Free-plan price of the main billing event), and max divided by min |
| `ecstCovered` | Whether the shop appears in the E-commerce Scraping Tool's preset marketplace list |

The key-value store also holds `ECST_SNAPSHOT`: the E-commerce Scraping Tool's user and run statistics on the run date, so later runs can be compared.

## How the gap score works

Points are added for each reason below. Actors that do a different job (reviews, stock checkers, trackers, sellers, sentiment, inventory, alerts) are left out.

| Points | Reason |
|---|---|
| +3 | No Actor found for the shop |
| +2 | The most used Actor has fewer than 500 users |
| +1 | The most used Actor has 500 to 1,999 users |
| +2 | The top 3 Actors average under 3.5 stars |
| +1 | Under 90% of runs in the last 30 days succeeded (needs 50 or more runs) |
| +1 | Prices differ 5 times or more between Actors (needs 3 or more priced Actors) |
| +1 | The shop is not in the E-commerce Scraping Tool's preset list |

The weights are a simple heuristic, not a measured fact.

## Limitations

- The score reflects supply, not demand. A low number of users can mean a gap, or little interest in that shop.
- Shops are matched by Actor title, name and developer, so Actors with unusual titles can be missed.
- Price spread mixes pricing bases (per result, per detail page), so treat it as a rough signal.
- Not being in the preset list does not mean the E-commerce Scraping Tool cannot handle a shop from a product link.

## Run locally

```bash
npm install
npm start
```

Edit `storage/key_value_stores/default/INPUT.json` to change the shops. Results are written to `storage/datasets/default/`.
