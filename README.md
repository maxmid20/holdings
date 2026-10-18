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
| `Currency` | Single line text, optional. A currency code: USD, AUD, EUR, GBP, CAD, NZD, JPY, CHF, SGD, HKD, INR, or BTC for bitcoin held directly (Value = the number of coins, e.g. 0.25). Blank means USD. `Value` and `Monthly contribution` are in this currency |
| `Asset class` | Single line text, optional. One of: US stocks, International stocks, Equities, US bonds, International bonds, Bonds, Cash, Property, Gold, Commodities, Bitcoin, Crypto, Other. Set by **Tidy up** or the Bucket picker |

## Currencies

Give a holding a **Currency** (in its edit form, or the `Currency` column in Airtable) and enter its value in that currency. The app converts every holding into the display currency (the picker at the top) for the totals, buckets, projection and contributions. Each converted row also shows its original amount, such as A$900,000.

Rates live in a small **FX rates** table, one row per currency:

| Field | Type |
|---|---|
| `Currency` | Single line text (primary field), e.g. `AUD` |
| `Per USD` | Number (6 decimal places): how many of that currency 1 US dollar buys, e.g. 1.53 |
| `USD each` | Number (2 decimal places): used for bitcoin instead of `Per USD`, the dollar price of 1 BTC, e.g. 82644.65 |
| `As of` | Single line text, e.g. 2026-10-17 |
| `Source` | `Auto (…)` from the daily sync, or `Manual` for a rate you typed |

The daily sync refreshes the rates every weekday: currencies from the European Central Bank (through the free Frankfurter service), and bitcoin from Alpha Vantage (falling back to CoinGecko). You can also set or override a rate under **Exchange rates** (below the totals). A manual rate is kept until you choose "Use the daily rate instead". Until a currency has a rate, its holdings are left out of the totals and the app says so. In browser-only mode, rates you type are kept in this browser.

## Buckets

Everything rolls up into eight buckets: **Equities, Bonds, Cash, Gold, Property, Commodities, Bitcoin, Other**. Equities and Bonds keep a US / International / Global detail.

Each holding's bucket comes from, in order:
1. its ticker's **Fund breakdown** rows (multi-asset funds such as VTTSX or Aware Super are split proportionally),
2. its own **Asset class**,
3. its category (Cash, Property, Bitcoin, Gold),
4. otherwise **Other**.

**Tidy up** (next to "+ Add asset") reads each holding's name, category and account, pulls out tickers buried in names ("Gold IAU ISHARES…" → IAU), suggests a bucket with the reason, and saves your accepted choices to Airtable. It runs entirely in your browser.

Funds without a ticker can still be split: add rows to Fund breakdown under a code (e.g. `AWARE-HG` for Aware Super High Growth) and set that code as the holding's Ticker. Tidy up does this automatically for Aware Super.

## Projection

The **Projection** panel projects every holding forward, month by month:

- **Assets** grow at their `Expected return %` (compounded monthly), plus their `Monthly contribution` at each month's end. Holdings without a return use the panel's **Default return %** if they're Investments, Retirement, Crypto, or Other, and 0% otherwise (cash, property, vehicles…).
- **Debts** grow at their interest rate and shrink by their monthly payment until they're paid off.
- **Today's dollars** divides future values by inflation, so you can see real purchasing power.
- The chart compares projected net worth with **"without growth"** (today's balances plus everything you'll add). The gap between the two lines is investment growth.

Projection settings (years, default return, inflation) are saved only in your browser. The owner filter applies, so you can project just your own holdings or a partner's.

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
