# Holdings

A simple, private net-worth tracker. Add your assets and debts, group them by category, and see your net worth at a glance.

- **Two storage modes:** browser-only (the default), or your own **Airtable** base, synced across your devices.
- **Export / Import** a JSON backup at any time.
- **Multi-currency display** (USD, EUR, GBP, CAD, AUD, JPY, CHF, INR).

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
