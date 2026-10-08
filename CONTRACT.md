# Shop driver contract, version 1

**Contract version 1.** This is what a driver in `shops/<domain>/` must be, and what the AI-Bot gate does with it. It is derived from the
gate's own code (`gate/src/shops/driver-contract.ts`, `driver-manifest.ts`, `driver-run.ts`, `driver-truth.ts`, `abilities/scan.ts` and
`recipe.ts`). `tools/check.mjs` and `tools/probe.mjs` implement it; when the text and the tools disagree, that is a bug in one of them.

A driver reads one shop. It answers one question: "which products does this shop have for this word?". It never buys, never signs in, never
writes. The gate runs it in a sandbox, checks its answer against the shop's own pages, and only then lets a bot use it.

## 1. Folder layout

```
shops/<domain>/
  driver.json       required  the manifest (section 2)
  index.mjs         required  the code (section 3)
  PROVENANCE.json   optional  where the driver came from (section 9)
  RESULT.json       optional  what the build job reported (section 8)
```

- `<domain>` is the shop's public domain in lower case without `www.` (`celeiro.pt`, not `www.celeiro.pt`). It must equal `domain` in
  `driver.json`.
- **At most 2 driver files**: `driver.json` and `index.mjs`. `PROVENANCE.json` and `RESULT.json` are metadata and are allowed in addition.
  No other file, no sub-folder, no link. File names are plain (`A-Z a-z 0-9 . _ -`).
- **At most 60 KB per file** (61,440 bytes).
- A `RESULT.json` with `"status": "failed"` may stand alone: a failed build is a record, not a driver.
- A pull request changes files in exactly one `shops/<domain>/` folder and nothing else.

## 2. `driver.json`

```json
{ "domain": "celeiro.pt", "name": "Celeiro", "hosts": ["www.celeiro.pt", "celeiro.pt"], "probe": "arroz" }
```

| field | rule |
| --- | --- |
| `domain` | The shop's public domain (`www.` is dropped). A public DNS name: no IP address, no `.local`, `.internal`, `.lan`, `.ts.net`. |
| `name` | The shop's name: 1 to 60 letters, digits, spaces or `. & ' -`. |
| `hosts` | 1 to 5 public host names the driver may request. At least one must be on `domain`. No wildcards, no paths. |
| `probe` | One search word from the common-word list (section 7). |
| `tests` | Absent or empty. Recorded answers stay out of the library (section 6). |

Unknown fields are ignored by the gate (the check reports a note). The gate itself would fill in a missing `name`, `hosts` or `probe`; the
library requires all of them written out.

**Own domain only.** `hosts` should list the shop's domain and its subdomains. A driver that lists any other host is allowed but is flagged
`ownDomainOnly: false` in `tools/check.mjs --json` and in `index.json`, and is never merged automatically: it needs a person.

## 3. `index.mjs`

One ES module, one self-contained file, that exports:

```js
export async function run(action, params, http) { ... }
```

- **Actions.** Contract version 1 has exactly one action: `"search"`. `params` is `{ q: "<search word>" }`. Any other action must throw.
  There is no product, basket or any other action in version 1.
- **Return value** for `search`: `{ products: [ ... ] }` (section 4).
- **Errors.** Throw an `Error` with a plain message (`"the shop's search answered 404"`). The message is shown to the builder as data.
- `console.log` goes to the gate's log, never to the user.
- Imports: none, except your own files with `./x.mjs` (and v1 allows no extra files, so: none).
- The gate runs `run` in its own Node process under the permission model: it reads only its own folder, has no network except `http()`, no
  child processes, no workers, 128 MB of memory.

### The static scan

`index.mjs` is refused if any of these appear (equivalent to the gate's `scanCode`; `tools/check.mjs` contains the same patterns):

| pattern | meaning |
| --- | --- |
| `eval(` | no building code from text |
| `new Function`, `Function(` | no building code from text |
| `import(` | no dynamic import |
| `require(` | no `require` |
| `import ... from "x"` / `import "x"` where `x` does not start with `./` | no outside modules (`node:`, packages, URLs) |
| `process.` / `process[` | the process object is not available |
| `globalThis` | not allowed |
| `WebAssembly` | not allowed |
| `fetch(` | use the `http()` you are given |
| 200 or more letters/digits/`+`/`/` in a row | no encoded blobs |

## 4. The product shape

`search` returns `{ products: [...] }` with **1 to 60** products. An empty list is "no match" (`no products for the search`), not a
crash: a driver for a word the shop has nothing for returns `{ products: [] }`. Each product is an object with only these fields:

| field | required | rule |
| --- | --- | --- |
| `id` | yes | The shop's own product id: letters, digits, `_` or `-`, at most 40 (a number is turned into text). Unique in the answer. Never a position. |
| `name` | yes | 1 to 200 characters, as the shop's product page shows it. |
| `price` | yes | 1 to 30 characters containing a digit, **exactly as the shop writes it** (`"1,75 €"`, `"12.99 AED"`). Never converted, never invented. |
| `url` | yes | `https` product page on the shop's own domain or a subdomain, no user name or password, and not a forbidden page (section 5). |
| `brand`, `size`, `unitPrice` | no | 1 to 80 characters when given. |
| `image` | no, but expected | The product's photo as an **absolute `https` address on the shop's own domain or one of its subdomains** (the tile's `img`, `og:image` or JSON-LD `image`; a relative address is made absolute in the driver). At most 500 characters, no user name, password or port. See "Product photos" below. |
| `available` | no | `true` or `false`. |

Unknown fields make the answer invalid. Two searches for the same word must give mostly the same ids (the gate compares them; 80% must
agree).

### Product photos

The app draws a product card with the photo; without one it draws a grey placeholder with the shop's initials. So a driver should return
`image` whenever the shop's search page shows a photo for the product.

- **Own domain only, the same rule as `url`.** The gate keeps an `image` only when it is `https`, has no user name, password or port, is at most
  500 characters, and its host is the shop's `domain` or a subdomain of it (`files.shop.pt` for `shop.pt`). Anything else is dropped without an
  error and the card shows the placeholder. This is the gate's `safeImage` rule, and `tools/lib/contract.mjs` `ownImage` is the same rule.
- **A photo on a foreign CDN is not accepted.** The `hosts` list is not widened for photos: a host in `hosts` is a host the driver may *request*
  (with extra headers) and makes the driver `ownDomainOnly: false`, so listing a CDN there for an `<img>` would buy a wider sandbox for a
  picture. There is no separate `imageHosts` field either. Leave `image` out when the shop's photos live only on another domain.
- **The gate never fetches the photo.** It only passes the address on; the phone app loads the picture itself. That is why the address must
  be the shop's own and why nothing else is allowed.
- **A missing photo is a note, not a failure.** `tools/probe.mjs` prints a note when no product has an image, when some have none, or when
  some images are not on the shop's domain (the gate would drop them); `tools/check.mjs` prints a note when `index.mjs` never mentions
  `image`. A shop that really shows no photos can ignore the note. Neither tool fails on a missing image.

## 5. `http()` and forbidden pages

`http({ method, url, headers })` returns `{ status, headers, body }` (the body is text). The gate answers it, never the driver's own code:

- **Own hosts only**: the URL's host must be one of `hosts` in `driver.json`, over `https` only, no user name or password.
- **Read only**: method `GET` or `HEAD`. Anything else is refused.
- **Forbidden paths**: the request path must not match
  `/(checkout|payment|pagamento|order|encomenda|login|signin|account|conta)/i` (anywhere in the path), must not contain a whole path
  segment that is a basket, wishlist or sign-out page (`cart`, `carrinho`, `cesto`, `basket`, `bag`, `wishlist`, `favoritos`, `logout`,
  `log-out`, `signout`, `sign-out`, `sair`), and must not carry a query key that changes a basket or session on a plain GET
  (`add-to-cart`, `add_to_basket`, `remove_item`, `empty-cart`, `clear_cart`, `logout`, `customer-logout`, ...), or a front-controller key
  (`controller`, `action`, `route`, `page`, `fc`, `module`, `view`) whose value is one of those pages (`?controller=cart`,
  `?route=checkout/cart`).
- **Headers**: to the shop's own domain only `accept` may be sent. To another listed host, any header except `host`, `cookie`,
  `authorization`, `proxy-authorization`, `content-length`, `connection`, `transfer-encoding`.
- The shop sees an ordinary browser and the driver never sees cookies. A bot check ends the run as its own outcome.
- Bodies are capped; a driver should read at most a few pages per search.

`tools/check.mjs` also refuses string literals in `index.mjs` that name such a page (`"/cart"`, `"https://shop.pt/checkout"`,
`"?add-to-cart="`), because a driver has no reason to know them.

## 6. The truth check

After a driver runs, the gate opens each of the first 3 returned products' own page itself and looks for the product's **name** (at least
60% of its words of 3 letters or more, accents and case folded) and its **price** in one of three places only:

1. the page's visible text (scripts and styles removed) where a price has two decimals or a currency sign;
2. a price attribute (`data-price-amount`, `itemprop="price"`);
3. the page's JSON-LD (`"price": ...`).

A bare number elsewhere never counts. A page that draws its price in the browser is opened for real before the driver fails. So: read the
name and the price from the same place the product page shows them. A driver whose products do not match their pages is refused.

The gate also runs the search twice and requires the two answers to agree, and it proves the driver **live on the real shop** before a
user's bot may use it. **There are no recorded tests in the library**: recordings come from a user's signed-in browser and stay local, so
`driver.json` has no `tests`.

## 7. The probe word

The probe word is a **common search word**, never a user's item. It must be one of this list (the gate's `AUTO_WORDS`, same order):

`arroz`, `leite`, `aveia`, `agua`, `rice`, `milk`, `cafe`, `protein`

The list is part of the contract: it changes only with a contract version. `driver.json` `probe` must be on it, and `tools/probe.mjs`
only accepts `--word` from it. This keeps what a user shops for out of the library, out of CI logs and out of shops' access logs.

## 7a. Quality

A driver that has the right shape can still be a poor one: a menu instead of the results, three products out of fifty, no photos. The quality
bar is what a finished driver must meet. `tools/probe.mjs` runs it (use `--quick` only while iterating; a driver is done when the full run
passes), `tools/lib/quality.mjs` and `tools/lib/truth.mjs` are the rules, and the AI-Bot gate applies the same bar before it accepts a driver
(`gate/src/shops/driver-quality.ts`). Every failure names the field.

- **Held-out words.** The probe runs the driver's own probe word and then **two more common words** (section 7) that the tool picks: other
  words of the same language group, chosen by the shop's domain, so the driver cannot be tuned to them. The driver must work for any search word.
- **Complete** (`products`). At least one of the three words gives **5 or more** products. A shop's search page lists more than a suggestion box;
  a driver that stops at 3 is reading the wrong thing. (The bar cannot count the shop's page, so "5 for the best word" stands for "the whole list".)
- **Every product** has a `name`, a `price` above zero **with a currency** (`1,75 €`, `12.99 AED`; a bare `1,75` fails), an `url` on the shop's
  hosts, an `id` that is the shop's own (not 1, 2, 3 in order), no duplicate ids, and the same ids when the same word is searched twice (80%).
- **Relevant** (`name`). For each word the shop knows (at least 5 products, at least one name containing the word), **80% or more of the product
  names contain the search word or a close form** (accents, case and plurals ignored: "Água" matches `agua`). This catches drivers that return
  menus, ads or related products (when the shop itself pads a list with unrelated products, the driver keeps only those whose name contains the word). A word the shop has fewer than 5 products for is not judged for it (the shop's own fuzzy fallback).
- **Photos** (`image`). When the shop's answer shows a photo beside the products (a photo address within a short distance of a returned
  product's name, logos and icons ignored) or the driver returns any, **80% or more of the products carry a valid `image`** (own domain, see
  "Product photos"). A shop that shows no photos is not asked for them.
- **True** (section 6). Two sampled products' own pages are opened; each page must show the product's name and its price. A page that shows
  no price at all (the shop draws it in the browser) is a note, not a failure: the gate opens such pages in a real browser.

`tools/probe.mjs --json` returns the score as `quality`: `productsPerProbe` (words and counts), `imageShare`, `relevanceShare`, `photosShown`.
The gate records the same four facts per accepted driver (`shop_driver_quality` in its audit, and in `aibot.builder.jobs`).

## 8. `RESULT.json`

What the build job reports about the folder it made. Optional; when present it is validated.

```json
{ "job": "job-0001", "domain": "celeiro.pt", "status": "built", "attempt": 1, "notes": "Built from the shopify starter.", "files": ["driver.json", "index.mjs"] }
```

| field | rule |
| --- | --- |
| `job` | The build job id: 1 to 80 letters, digits or `. _ : -`, starting with a letter or digit. |
| `domain` | The shop's domain; must equal the folder name. |
| `status` | `"built"` (the driver passed the builder's own checks) or `"failed"` (the builder gave up; see `notes`). |
| `attempt` | Whole number 1 to 99: which try produced this folder. |
| `notes` | Text, at most 2000 characters, plain words. No personal data. May be empty. |
| `files` | The files in the folder, each once, from `driver.json`, `index.mjs`, `PROVENANCE.json`, `RESULT.json`; each must exist. A `built` result lists at least `driver.json` and `index.mjs`. |

No other fields. A `failed` folder may hold only `RESULT.json`; it is not indexed.

## 9. `PROVENANCE.json`

Where the driver came from. Optional, every field optional, no other fields:

| field | rule |
| --- | --- |
| `contract` | Whole number from 1 to the current contract version: the version the driver was written for. |
| `builder`, `engine`, `platform`, `template` | A short label, 1 to 80 characters (`routine`, `shopify`, `json-feed`, ...). |
| `builtAt` | A date `2026-10-07` or `2026-10-07T09:30:00Z`. |
| `source` | An `https` address without `?` or `#`: a public page the driver was derived from. |

## 10. What is forbidden

- Anything that buys, signs in, or changes state: basket, checkout, payment, order, account, login pages and actions (section 5).
- Any request to a host not in `hosts`; any method but `GET`/`HEAD`; any header the gate owns.
- Building code from text, outside imports, `process`, `fetch` (section 3).
- Invented, converted or stale prices (section 6).
- A probe word that is not on the common-word list (section 7).
- **Personal data and secrets, in any file of the folder.** `tools/check.mjs` scans every file for:
  - e-mail addresses;
  - phone numbers (with a country code, grouped digits, or 9 or more digits in a row);
  - IBANs;
  - web addresses whose query has values (`?id=7`); keep the key only and add the word in code;
  - long hex strings (32+), UUIDs and long encoded tokens (32+ letters and digits);
  - the words `cookie`, `set-cookie`, `authorization` and `session`.

  The library is public. It holds no one's login, address, basket, order, name or search history. The report never repeats a matched
  value in full, because CI logs are public too.

## 11. Changing the contract

The contract version is an integer in `tools/lib/contract.mjs` (`CONTRACT_VERSION`) and in this file's title. A change that makes an existing
driver invalid raises it, and `index.json` records the version each driver was written for. A gate should refuse a library whose contract
version it does not know.
