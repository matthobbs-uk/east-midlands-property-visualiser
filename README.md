# Premium East Midlands Property AI Data Visualiser

An offline visualiser for the Land Registry record of home sales at £550,000 or more
across eight East Midlands districts, July 2010 – June 2026.

## Running it

Double-click **`index.html`**. That's it — no build step, no internet connection, no dependencies.
All 8,964 home sales and all 49 postcode-district map shapes are baked into `data.js`.

If you'd rather serve it over http (useful if your browser is strict about local files):

```bash
node serve.js
```

then open http://localhost:8712.

## What's in it

Filters run across the top and scope every chart on every tab at once: year range, county, district,
village, property type, price band, and three row toggles. The village box is a type-ahead over the
697 settlements that have a £550k+ sale, and only ever suggests places that exist under your other
filters. Hover any of them — or tab to it — for a
plain-English explanation of what it does, what it drops, and how many of the 11,460 rows it keeps.

| Tab | What it answers |
|---|---|
| **Pulse** | How big is this market, what does it cost, and which way is it going? Quarterly volume with a rolling average, median price with the middle half shaded, the six fastest-heating and fastest-cooling zones, and a small-multiple of all eight districts. |
| **Map** | Where are the hotspots? A choropleth of the 51 postcode districts you can switch between sales volume, median price, momentum and premium-vs-region, plus a treemap of all 47 settlement zones sized by volume and coloured by prime (£1m+) depth. |
| **Momentum** | Which areas are heating or cooling? A quadrant scatter of volume change against price change, a sortable movers table with sparklines, and a rank-shuffle chart of the districts year by year. |
| **Value** | What does the money buy where? Price distributions per area on a log axis, premium and discount against the regional median, and each district's split across price bands. |
| **Rhythm** | When do deals happen? A month-by-month heat grid over sixteen years, completion seasonality, and how far each district sits below its own busiest twelve months. |
| **Sales** | Every transaction in the current slice, sortable and searchable. Click a row to open the Land Registry record. |

Every chart has a **Show table** link giving the same numbers as text, and everything responds to
hover and keyboard focus.

## Reading the numbers honestly

- **The extract starts at £550,000.** Every median here is the median *of the top end*, not of the
  market. A rising count of £550k+ sales is the more reliable signal that an area is heating up.
- **Villages are held to a lower sample bar than larger areas** — 10 sales rather than 20 — because at
  a £550k floor even a well-known village records only a handful of sales in sixteen years. 197 of the
  697 clear it. The Value tab's distribution chart draws the 40 busiest and says so; the table twin
  below it always carries all of them.
- **Momentum compares two equal windows** — the most recent 36 months against the 36 before them —
  rather than calendar years, so the partial 2026 never distorts a comparison. Areas below 20 sales
  in the slice, or 5 in either window, are left out as too thin to read.
- **2026 covers January to June only** and is drawn at reduced opacity in the quarterly chart.
- **The app only ever holds sales of a single dwelling.** `classify()` in `build_data.py` decides
  this at build time and never ships the rest to the browser, so a non-comparable cannot reach a
  chart. 2,496 of the 11,460 records are set aside, leaving 8,964. The four reasons are mutually
  exclusive and sum exactly:

  | | |
  |---:|---|
  | 2,454 | not a home — commercial, agricultural or mixed use (type "Other"), the £111m Butlins site among them |
  | 19 | one property split across titles at a single price, e.g. a farmhouse sold with its cottage |
  | 16 | a duplicate of another record |
  | 7 | priced beyond any verified sale of its own type — land or an apportioned portfolio price |

  The breakdown is on the page too: hover the sales count at the right of the filter bar.
- **We deliberately do NOT use the extract's own `residential_comparable` column.** It also drops
  every Land Registry **category B** record as "not full market value", and that is not what category
  B means. It is an *additional price paid entry* — repossessions, but also buy-to-lets and purchases
  by companies, which transact at market price. Excluding the lot withheld ~300 ordinary house sales
  whose price distribution is indistinguishable from the kept ones (25th percentile identical at
  £595,000; median £652,500 against £660,000). Category B sales are kept.
- **The "beyond any verified sale" rule is self-calibrating.** Category A is Land Registry's verified
  full-market-value entry, so the dearest category A sale of each property type is the highest price
  a single dwelling of that type is known to reach here — £4,550,000 detached, £2,800,000 terraced,
  £2,150,000 semi-detached, £1,200,000 flat. An *unverified* category B record above its own type's
  line is land or a portfolio, not a house: it catches an "£8.5m terraced house" in Melton Mowbray
  and a £4.4m terrace in Bourne that a flat price ceiling would have missed. Category A records are
  never capped, so genuine country houses such as Normanton Manor at £4.55m stay.
- **Three postcode districts vanish as a result** — DN17, LE67 and the non-geographic NG80 — because
  every £550k+ record they held was non-residential. That drops the map from 51 shapes to 49.
- **"Search area"** filters to `in_search_geography = yes`.
- **Counties group the districts** as follows: Lincolnshire (East Lindsey, West Lindsey, North
  Kesteven, South Kesteven), Nottinghamshire (Rushcliffe, Newark and Sherwood), Leicestershire
  (Melton alone, in this extract) and Rutland (a single unitary authority). Choosing a county narrows
  the District list to match. The mapping lives in `DISTRICT_COUNTY` in `build_data.py` and the build
  fails loudly if a future extract contains a district that isn't in it. Note that postcode districts
  don't respect county lines — NG23 and NG32, for instance, cross the Trent into Lincolnshire — so
  filtering to Lincolnshire can still colour an NG area on the map. The county always follows the
  local authority district of the sale, never its postcode.
- **The towns and cities on the map are orientation markers, not data.** The sales extract has no
  coordinates, so these are reference points added by hand. `build_data.py` verifies each one falls
  inside the postcode district it claims and drops any that doesn't, so a mistyped coordinate can't
  quietly end up in the wrong field. Labels are placed by priority — cities and market towns first,
  then postcode codes, then the fringe towns that frame the map — and anything that would collide is
  dropped rather than overlapped.

## Taking the data elsewhere

**Your source file is never modified.** `build_data.py` opens
`EastMidlands_LandRegistry_550k_2010on.csv` read-only and derives everything from it.

To use the cleaning in Excel, Sheets, R or anything else, take
**`EastMidlands_550k_classified.csv`**. It is all 11,460 original rows with all 19 original columns
untouched, plus two appended:

- `is_home_sale` — `yes` (8,964) or `no` (2,496). Filter to `yes` for what the app shows.
- `set_aside_reason` — blank when kept, otherwise which of the four rules it failed.

Nothing is deleted, so you can audit or overrule any decision rather than take it on trust.

## Rebuilding the data

If the source CSV is replaced with a fresher extract:

```bash
python3 build_data.py
```

That reads the source and the boundary files in `geo/`, then rewrites `data.js` and
`EastMidlands_550k_classified.csv`. No third-party packages needed.

## Files

```
EastMidlands_LandRegistry_550k_2010on.csv   your source file — READ ONLY, never modified
EastMidlands_550k_classified.csv            generated — the same 11,460 rows plus our verdict
index.html        page structure and all the explanatory copy
styles.css        dark editorial theme; every colour is a named role
app.js            data slicing, aggregation and every chart (no libraries)
data.js           generated — the sales table plus simplified map shapes
build_data.py     generated data.js from the CSV + geo/
geo/*.geojson     postcode-district boundaries (open uk-postcode-polygons dataset)
serve.js          optional local static server
```

Chart colours follow one system throughout: **amber = magnitude** (sequential ramps, the emphasis
colour for single-series charts), **blue↔red = polarity** (momentum, premium — cool is down or
cheap, warm is up or dear), and grey for de-emphasis. The palette was validated for colour-vision
deficiency and contrast against the dark surface, and no chart relies on colour alone — every one
has a legend, direct labels, a tooltip and a table view.

## Licence

The code in this repository is MIT licensed — see [LICENSE](LICENSE).

The data is **not** mine to license. Contains HM Land Registry data © Crown copyright and database
right 2026. This data is licensed under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
If you reuse it, that attribution must travel with it. Postcode-district boundaries come from the
open [uk-postcode-polygons](https://github.com/missinglink/uk-postcode-polygons) dataset.

Price Paid Data records real addresses and the prices paid for them. It is published openly by HM
Land Registry, but putting a searchable, mapped interface over it is a step beyond a CSV on gov.uk —
worth keeping in mind before extending it.
