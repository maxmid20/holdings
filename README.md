# Holdings

A simple, private net-worth tracker. Add your assets and debts, group them by category, and see your net worth at a glance.

- **Two storage modes:** browser-only (the default), or your own **Airtable** base, synced across your devices.
- **Export / Import** a JSON backup at any time.
- **Multiple currencies:** each holding can be in its own currency (an Australian property in AUD, say), and everything is converted into the currency you choose to display.

Live app: https://maxmid20.github.io/holdings/

## Connecting Airtable

### 1. Create the base

Create a new base, for example "Holdings", with one table named **`Items`** and these fields (the names must match exactly):

| Field      | Type                                   |
|------------|----------------------------------------|
| `Name`     | Single line text (primary field)       |
| `Kind`     | Single select with options `Asset`, `Debt` |
| `Category` | Single line text                       |
| `Value`    | Number (2 decimal places)              |
| `Note`     | Long text                              |
| `Account type` | Single line text (e.g. 401(k), Roth IRA, Checking) |
| `Fund`     | Single line text (e.g. Vanguard Target Retirement 2060) |
| `Owner`    | Single line text (e.g. Myself, Partner, Joint) |
| `Ticker`   | Single line text (e.g. VTTSX), optional: enables pricing and look-through |
| `Shares`   | Number (4 decimal places), optional: the daily sync sets `Value` = Shares × price |
| `Price`, `Priced on` | Number / text, written by the daily sync |
| `Expected return %` | Number (2 dp, negatives allowed), optional. For a debt, this is its interest rate |
| `Monthly contribution` | Number (2 dp), optional. For a debt, this is its monthly payment |
| `Currency` | Single line text, optional. A currency code: USD, AUD, EUR, GBP, CAD, NZD, JPY, CHF, SGD, HKD, INR, BTC for bitcoin held directly (Value = the number of coins, e.g. 0.25), or XAU for physical gold (Value = troy ounces, e.g. 2.5). Blank means USD. `Value` and `Monthly contribution` are in this currency |
| `Years left` | Number, optional (debts). Remaining term: if the debt has no monthly payment, the app works out the payment that clears it in this time |
| `Written off` | Single line text, optional (debts). A date the remaining balance is forgiven regardless, as `2039` or `2039-04` (e.g. a UK student loan) |
| `Institution` | Single line text, optional. Who holds the asset, e.g. Vanguard, Fidelity, Empower, Chase, NAB. Used by Counterparty risk; if blank, the app guesses from the name, account type, fund or note |
| `12-month return %`, `5-year return %` | Number (2 dp, negatives allowed), optional. Trailing total returns; the 5-year figure is per year. Filled in monthly by the daily sync for holdings with a ticker or in BTC, or typed by you |
| `Return as of`, `Return source` | Single line text, written with the returns (`Auto (…)` from the sync, `Manual` if you typed them; the sync never overwrites Manual) |
| `Asset class` | Single line text, optional. One of: US stocks, International stocks, Equities, US bonds, International bonds, Bonds, Cash, Property, Gold, Commodities, Bitcoin, Crypto, Other. Set by **Tidy up** or the Bucket picker |

## Currencies

Give a holding a **Currency** (in its edit form, or the `Currency` column in Airtable) and enter its value in that currency. The app converts every holding into the display currency (the picker at the top) for the totals, buckets, projection and contributions. Each converted row also shows its original amount, such as A$900,000.

Rates live in a small **FX rates** table, one row per currency:

| Field | Type |
|---|---|
| `Currency` | Single line text (primary field), e.g. `AUD` |
| `Per USD` | Number (6 decimal places): how many of that currency 1 US dollar buys, e.g. 1.53 |
| `USD each` | Number (2 decimal places): used for bitcoin and gold instead of `Per USD`: the dollar price of 1 BTC or 1 troy ounce of gold (XAU), e.g. 4168.00 |
| `As of` | Single line text, e.g. 2026-10-17 |
| `Source` | `Auto (…)` from the daily sync, or `Manual` for a rate you typed |

The daily sync refreshes the rates every weekday: currencies from the European Central Bank (through the free Frankfurter service), bitcoin from Alpha Vantage (falling back to CoinGecko), and gold from Alpha Vantage's spot price. You can also set or override a rate under **Exchange rates** (below the totals). A manual rate is kept until you choose "Use the daily rate instead". Until a currency has a rate, its holdings are left out of the totals and the app says so. In browser-only mode, rates you type are kept in this browser.

## Buckets

Everything rolls up into eight buckets: **Equities, Bonds, Cash, Gold, Property, Commodities, Bitcoin, Other**. Equities and Bonds keep a US / International / Global detail.

Each holding's bucket comes from, in order:
1. its ticker's **Fund breakdown** rows (multi-asset funds such as VTTSX or Aware Super are split proportionally),
2. its own **Asset class**,
3. its category (Cash, Property, Bitcoin, Gold),
4. otherwise **Other**.

**Tidy up** (next to "+ Add asset") reads each holding's name, category and account, pulls out tickers buried in names ("Gold IAU ISHARES…" → IAU), suggests a bucket with the reason, and saves your accepted choices to Airtable. It runs entirely in your browser.

Funds without a ticker can still be split: add rows to Fund breakdown under a code (e.g. `AWARE-HG` for Aware Super High Growth) and set that code as the holding's Ticker. Tidy up does this automatically for Aware Super.

## Trailing returns

Each holding can show its **12-month** and **5-year (per year)** total return, measured to the last month-end with dividends reinvested, like a fund factsheet. The daily sync calculates them once a month from Alpha Vantage's monthly prices for any holding with a ticker, and for bitcoin. For holdings without a ticker (a super fund, a savings account), type the published figures into the holding's edit form.

The asset list shows each holding's returns and a value-weighted 12-month return for each bucket. The **Returns** panel gives two overall figures: **all assets** (every asset at its value: cash earns its interest rate, and anything without a figure counts as 0% and is called out) and **invested holdings only** (just the holdings with a return), plus a table of how much each group adds. These describe the funds' past performance, not your own money-weighted return, and the projection doesn't use them. The edit form has a **Use the 5-year average** link if you want to copy that figure into the holding's Expected return.

## Risk & diversification

An allocator's view of the whole balance sheet, on the overview (owner filter applies):

- **Risk profile**: estimated yearly volatility of net worth (asset volatility × assets ÷ net worth, since debts don't move), labelled Conservative (<5%), Moderate (5–9%), Growth (9–13%) or Aggressive (13%+), with the stock/bond mix of equal volatility.
- **A bad year (1 in 20)**: parametric 95% value at risk over one year, plus expected shortfall (the average loss in the worst 5% of years).
- **Diversification**: the effective number of independent bets (inverse concentration of risk contributions) next to the same measure by money, and the diversification ratio.
- **Where your risk comes from**: each asset class's share of money vs its share of risk (Euler risk contributions).
- **Stress tests**: approximate peak-to-trough moves by asset class for 2008, 2020, 2022, a hypothetical stagflation year and a crypto winter, plus your display currency rising 15% against the others you hold (net of debts in them).
- **Scorecard**: OK / Watch / Concern against common institutional and planning limits:
  - sources of risk (3+ bets);
  - single-asset concentration (one property, coin or other individual asset under 10% of assets; over 25% is a concern; diversified funds don't count);
  - speculative assets (crypto at most 5%);
  - liquidity (at least 25% accessible, with retirement accounts and property counted separately);
  - leverage (debts under 30% of assets);
  - currency match against what you spend in;
  - bank deposits within insurance limits;
  - tail loss (worst stress under 20% of net worth);
  - emergency reserve (6+ months).

Market risk uses the same return, volatility and correlation assumptions as Scenarios, applied to the look-through mix. It's a normal approximation, which understates real tails; the stress tests cover that. The Scenarios table also shows each scenario's net-worth volatility and worst stress loss, and the rebalance what-if shows risk before → after.

## Macro exposure

Two look-through views of your net worth, net of debts: **by country** (where the economic risk sits) and **by currency** (what an exchange-rate move would hit).

- Each holding is split by its asset classes (fund breakdown, then Asset class, then category). US stocks and bonds count as the United States in USD.
- **International shares** are spread over the world stock market minus the fund's home country, using approximate index weights, and are assumed unhedged. So they show up in EUR, JPY, GBP and so on.
- **International bonds** are spread over the same countries but kept in the fund's own currency, since these funds are usually hedged.
- **Unspecified shares or bonds** count as the whole world in a US fund, and as the home market in a non-US fund (e.g. Aware Super).
- **Cash, property and "other"** count in the holding's own country and currency. **Gold** (XAU) and **bitcoin** (BTC) are stateless and show as their own currencies. **Commodities** count as global, priced in USD. **Debts** subtract in their own country and currency (a GBP loan is a short position in GBP).
- The currency card compares your holdings with the currencies you **spend** in (from the Expenses table) and shows how much of your net worth sits outside them.

## Counterparty risk

Shows who holds your money and how it's protected if that institution fails, one bar per institution:

- **Insured:** bank deposits within the deposit-insurance limit. The limit is per depositor, per bank, per ownership category: **FDIC** US$250,000 (US banks), **FCS** A$250,000 (Australian banks), **FSCS** £120,000 (UK banks). A holding with Owner = Joint counts as two depositors.
- **Held in custody / trust:** brokerage accounts (Vanguard, Fidelity, Schwab…), 401(k)/403(b) plans (Empower…) and super funds (Aware Super…). These assets are held for you, not lent to the institution. US brokers add **SIPC** cover up to US$500,000 if assets go missing in a failure.
- **Uninsured:** deposits above the limit, and anything at a crypto exchange.
- **Held directly / not set:** property, physical gold and self-custodied bitcoin, plus holdings without an institution.

Set each holding's **Institution** in its edit form. If it's blank, the app guesses from well-known names (marked *). The headline shows your uninsured bank deposits and your largest single institution. This is a guide, not legal advice; check each bank is covered by its scheme.

## Emergency fund

The **Emergency fund** section answers "how many months could I live on my emergency fund?"

- **Monthly living expenses** live in an **Expenses** table: `Name` (primary), `Monthly amount` (Number, 2 dp), `Currency` (text, blank = USD), `Category` (text), `Essential` (Checkbox), `Owner` and `Note` (text). Add and edit them in the app or in Airtable. For yearly or quarterly bills, enter the monthly equivalent.
- **Months of cover** = your emergency fund ÷ your monthly **essential** spending (or all spending, if nothing is marked essential). The app also shows how long it lasts if you kept all spending.
- **The emergency fund** is every holding in the Cash bucket by default (in any currency). Use **Choose holdings** to pick exactly which holdings count; that choice is saved in your browser.
- A meter shows 0–12 months, marking the common 3–6 month guideline.
- **Set-asides** are cash you're keeping for something else, like business capital or a house deposit. They live in a **Set-asides** table: `Name` (primary), `Amount` (Number, 2 dp), `Currency` (text, blank = USD) and `Note`. The card shows **Total cash − each set-aside = Emergency fund**, and months of cover use what's left.

## Projection

The **Projection** panel projects every holding forward, month by month:

- **Assets** grow at their `Expected return %` (compounded monthly), plus their `Monthly contribution` at each month's end. Holdings without a return use the panel's **Default return %** if they're Investments, Retirement, Crypto, or Other, and 0% otherwise (cash, property, vehicles…).
- **Debts** grow at their interest rate and shrink by their monthly payment until they're paid off. With no payment but **Years left**, the payment is the one that clears the debt in that time. A **Written off** date drops whatever is left to zero on that date. Each debt shows when it ends ("Paid off Oct 2048 at A$1,279/mo" or "Written off Jan 2039 · ~£55,158 forgiven"), and the Debts section says when you'll be debt-free.
- **Today's dollars** divides future values by inflation, so you can see real purchasing power.
- The chart compares projected net worth with **"without growth"** (today's balances plus everything you'll add). The gap between the two lines is investment growth.

Projection settings (years, default return, inflation) are saved only in your browser. The owner filter applies, so you can project just your own holdings or a partner's.

## Rebalance what-if

At the top of the **Scenarios** tab, list manual moves such as "$20,000 from Checking to Gold coins". The destination can be another holding or a new position in any bucket. For the moves together, it shows:

- **Last 12 months**: what the moves would have earned or cost, e.g. 20k × (gold 40% − cash 4%) = +$7,200, and your portfolio's 12-month return before → after.
- **Last 5 years**: the total difference over five years using each holding's 5-year annualised return, compounded.
- **Going forward**: the change in expected yearly return, using each holding's `Expected return %` or, if blank, the long-run assumption for its asset class (from the Scenarios defaults).
- A per-move table, your asset-class mix now vs after, and a warning if the moves change your emergency-fund months.
- **Project this mix forward** turns the after-moves mix into a scenario.

Hindsight uses trailing returns in each holding's own currency. Cash uses today's interest rate for the whole period. A new position uses your existing holdings in that bucket; if there are none, there's no hindsight figure. A move bigger than what's left in the source is capped. Taxes, fees and trading costs are ignored. Moves are saved in this browser.

## Net worth history

At the top of the overview: net worth over time (1M, 3M, YTD, 1Y, All) for the whole household, at today's exchange rates.

- **Data:** in Airtable mode, the daily sync's Exposure history rows. In browser mode, a snapshot saved each day you open the app. Today's live totals are always the last point.
- **Breakdown:** the change is split into **money you put in** and **markets & revaluation**. Money you put in is estimated from each holding's current monthly contribution and each debt's payment. Markets & revaluation is everything else, net of interest. It also shows an approximate money-weighted return (annualised over a year or more).

Airtable's free plan allows 1,000 records per base, and the sync adds one Exposure history row a day, so you may eventually need to thin old rows or upgrade.

## Plan tab

**Target allocation.** Set a target % per asset class, by hand or starting from your current mix or a preset, with a ± band.

- **What the targets cover:** investable assets. Property is excluded unless you tick it, and so is a cash reserve of N months of spending plus set-asides.
- **When it trades:** if any class leaves its band, the plan trades everything back to target. "Only fix breaches" moves just those classes, using cash to balance.
- **How trades become moves:**
  - Excess cash goes first, lowest interest rate first.
  - Then liquid holdings, flagged for possible capital gains.
  - Retirement-account holdings become switches inside the account.
  - Buys go to your largest existing holding in that class, else a new position.
- **Alongside the trades:** the months it would take to close the gap with contributions alone, and the change in risk.
- **Test this plan in the what-if** loads the trades into the rebalance what-if.

**Financial independence.**
- **FI number:** yearly spending (from expenses, or typed) ÷ withdrawal rate.
- **Progress:** investments and cash, plus property if ticked, less debts not secured on excluded property.
- **When:** the median age you'd get there and the chance by your target age, from 600 simulated markets in today's money. If that chance is under 75%, it shows the monthly saving needed to reach 75%.

**Goals.** Name, target, month, funding (a set-aside or a holding) and monthly saving. Each goal shows its projected value (growth at the linked holding's expected return, 3% for cash and set-asides), whether it's on track, and the monthly saving needed if not.

**Expat tax & reporting checks.** Choose whether you're a US taxpayer, where you live, your filing status, and any UK or Australian residency.

- **US checks:**
  - FBAR ($10,000 combined)
  - Form 8938 thresholds by status and residence
  - Possible PFICs (non-US funds outside pensions)
  - Australian super and other foreign pensions
  - Foreign-currency mortgages (exchange gains on repayment)
  - Foreign property
  - Foreign loan write-offs (cancellation-of-debt income)
- **UK check:** offshore funds without reporting status.
- **Australia note:** worldwide income.

These are flags inferred from currency, category and names, not advice.

Policy, FI settings, goals and tax settings are saved in this browser.

## Scenarios

The **Scenarios** tab (or `#scenarios`) tests different allocations against each other, starting from what you hold today.

- **Presets**: As is, Growth (90/10), Balanced (60/40), Conservative, Glide path (shifts from growth to bonds over the horizon), Permanent portfolio and Real assets. Start from any of them and edit the target mix, or start from your current mix.
- **Assumptions**: each bucket has an expected return and volatility (equities 7% / 16%, bonds 4% / 6%, cash 3% / 1%, gold 4% / 15%, property 4% / 10%, commodities 3% / 18%, bitcoin 8% / 60%, other 4% / 10%). You can override them per scenario. They're long-run guesses, not forecasts.
- **Mechanics**: monthly compounding, rebalanced to target once a year. With a glide path, the target moves in a straight line from the start mix to the end mix over the years you choose. Contributions (blank = your current monthly contributions) follow the target and can grow each year. Property can be held as is rather than sold to rebalance. Debts pay down on their own schedule and are subtracted from net worth.
- **Chart and table**: projected net worth for each scenario (up to 5 get their own colour) against "As is" (dashed, your current holdings and returns). The selected scenario gets a shaded 10th–90th percentile range from 400 simulated market paths (correlated, fixed seed, so results don't jump between visits). The table shows each scenario's end value, the difference from as is, its blended expected return (start → end for a glide path) and the range. The bars show how the allocation shifts over time. Years, inflation and today's-dollars are shared with the Projection panel.
- **Saving**: add a **Scenarios** table to the base (`Name` primary field, `Config` long text) to keep scenarios in Airtable. Without it, scenarios are saved in this browser only.

Two more tables power the look-through ("Your real mix") panel:

- **Fund breakdown**: one row per fund per asset class (`Key`, `Fund ticker`, `Asset class`, `Weight %`, `As of`, `Source`). Rows with a `Source` starting with "Manual" are yours and always win. The daily sync writes "Auto" rows.
- **Exposure history**: one row per day, written by the daily sync, with US dollars per bucket plus total assets, debts and net worth (other currencies are converted first).

The daily sync runs as a scheduled GitHub Actions job in a separate **private** repository (`holdings-sync`), so its secrets and logs stay private. The app itself only ever reads these tables.

Copy the **base ID** from the base's URL. It's the part that starts with `app`, as in `airtable.com/appXXXXXXXXXXXXXX/...`.

### 2. Create a tightly scoped token

Go to **https://airtable.com/create/tokens** and create a personal access token:

- **Scopes:** only `data.records:read` and `data.records:write`. No schema, webhook, or workspace scopes.
- **Access:** only the **Holdings** base. Never "All current and future bases".

This way, even if the token ever leaked, it could only touch this one table of numbers. It couldn't reach your other bases or change your account.

### 3. Connect in the app

Click **Connect Airtable** and paste the base ID and token. Then choose a passphrase of 12+ characters. A long, unique phrase is best, and a password manager is a good place to keep it.

## How your data is protected

| Threat | Protection |
|---|---|
| Token leaking via GitHub | The token is **never** in the code or the repo. You enter it in the app. |
| Someone reading your browser storage | The token is encrypted with **AES-256-GCM**, using a key derived from your passphrase by **PBKDF2-SHA256 with 600,000 iterations** and a random salt. The passphrase itself is never stored. Your balances are never cached locally in Airtable mode. |
| Walking away from an unlocked device | The app **auto-locks after 15 minutes** of inactivity and clears the token and balances from memory and the page. You can also use **Lock now**. |
| Guessing the passphrase | The slow key derivation, plus an increasing delay after repeated wrong attempts. |
| Malicious scripts / XSS | A strict **Content Security Policy**. Only this site's own script can run, and the page can only connect to `api.airtable.com`. There are no third-party scripts, fonts, or trackers, and all data is HTML-escaped before display. |
| Clickjacking | The app refuses to run inside a frame. |
| Data leaking in URLs or referrers | Requests send no referrer and no cookies, and the token only travels in the `Authorization` header over HTTPS. |
| Over-privileged access | The token is scoped to one base and records read/write only (see step 2). |

### Your part

- **Turn on two-factor authentication** on both **GitHub** and **Airtable**. The app's code lives in your GitHub account, so securing that account protects the code itself.
- **Don't reuse** your passphrase anywhere else.
- If a device is lost, **revoke the token** at airtable.com/create/tokens and create a new one.
- **Export files are not encrypted.** Store backups somewhere safe.
- Be careful with browser extensions you don't trust, since they can read any page you open.

### Limits worth knowing

- Airtable stores your balances on its servers. Airtable can see them, as with any cloud service.
- A forgotten passphrase can't be recovered. Click **Forgot it? Disconnect**, then reconnect with a new token. Your data in Airtable is unaffected.

## Run it locally

Serve the folder with any static server, for example `python3 -m http.server`, then open `http://localhost:8000`. Encryption needs a secure context (https or localhost).
