# CC Tracker

Credit card bill tracker. Monthly cards, one card per person, installment plans, split bills, and a statement (SOA) you can screenshot for each person who owes.

- **Hosting:** Vercel (free Hobby plan)
- **Database:** Neon Postgres (free plan)
- **Sign-in:** one password that you choose

Your data is saved in the database, so every phone and computer shows the same numbers.

---

## 1. Set up in about 15 minutes

### Step 1. Create the database (Neon)
1. Go to **neon.com** and sign up (free, no card).
2. Click **Create project**. Name it `cc-tracker`. Pick the region closest to you (for the Philippines, choose **Asia Pacific (Singapore)**).
3. On the project page click **Connect** and copy the connection string. It starts with `postgresql://`. Keep it for Step 3.

You do **not** need to create any tables. The app creates them the first time it runs.

### Step 2. Put the files on GitHub
1. Create a new **private** repository on github.com (private matters, see "Privacy" below).
2. Upload everything in this folder, keeping the folders as they are: `api`, `lib`, `public`, `scripts`, `test`, `data`, `package.json`, `package-lock.json`, `vercel.json`, `.gitignore`, `.env.example`, `README.md`.
   - On the repository page: **Add file → Upload files**, then drag the folder contents in.

### Step 3. Deploy on Vercel
1. Go to **vercel.com**, sign in with GitHub, click **Add New → Project**, and import your repository.
2. Leave **Framework Preset** as **Other**. Leave the build command empty.
3. Open **Environment Variables** and add these three:

| Name | Value |
|---|---|
| `DATABASE_URL` | the Neon connection string from Step 1 |
| `APP_PASSWORD` | the initial password you will type to sign in (use this once, then change it in Settings) |
| `SESSION_SECRET` | any random text of 32+ characters |

   To make a random secret, run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, or type 40 random letters and numbers.
4. Click **Deploy**.

### Step 4. First sign-in
Open your Vercel link and type your initial password. On this first sign-in the app loads your starting data (copied from your Excel file) into the database, once, and stores a one-way password hash in Neon. After that, everything you change is saved to Neon. Change the initial password from **Settings** in the app.

---

## 2. Will it stay free and keep working?

Checked against Neon's and Turso's pricing pages on 11 Oct 2026. Plans and limits can change, so look again if something stops working.

- **Neon Free plan:** no time limit. 1 GB storage per project. 100 compute-hours per month. The database sleeps after 5 minutes without use and wakes on the next visit, so the **first load after a quiet period can take a second or two**. Nothing is deleted when it sleeps. This app stores about 100 KB, far below the 1 GB limit.
- **Vercel Hobby plan:** free, with no expiry. It is for personal, non-commercial use, which fits this tracker.
- **Why Neon and not Turso:** both are free. Neon is plain Postgres and connects to Vercel in one click. Turso's free plan (5 GB) would also work, but the code would need a small change.
- Press **Back up data** in the app whenever you want your own copy.

Neon also has a one-click Vercel integration (Vercel project → Storage → Neon) that fills in `DATABASE_URL` for you. Either way works.

---

## 3. Privacy and safety

- Your names and amounts are in `lib/seed.js`. Keep the GitHub repository **private**.
- `lib/seed.js` runs only on the server. Visitors who are not signed in cannot read it or anything in the database. Every data request needs the login cookie.
- The login cookie is HttpOnly, Secure and SameSite=Strict, and lasts 30 days. **Sign out** is in the left menu.
- After your first sign-in you can replace the contents of `lib/seed.js` with an empty start so your numbers are not sitting in the repository:
  `export default { v: 2, limit: 90000, people: [], months: [], plans: [] };`
  The database already has your data, so nothing is lost. Keep a copy of the original file if you want to run `npm test` again, because those tests compare the seed to your Excel numbers.
- Change the master password from **Settings** in the app. New passwords must be at least 8 characters. `APP_PASSWORD` is only used to initialize the first sign-in; once a password hash is stored in Neon, the database hash is the source of truth. Changing `SESSION_SECRET` in Vercel signs every device out.
- **Daily safety copy:** before the first change each day, the app saves a snapshot of the data in the table `app_backups`. If something is deleted by mistake, open Neon's **SQL Editor** and run this (replace the date):
  ```sql
  UPDATE app_state SET data = (SELECT data FROM app_backups WHERE day = '2026-10-11'), version = version + 1 WHERE id = 'main';
  ```
  Then reload the app.
- **Storage and month deletion:** Settings shows the current Postgres database size against the Neon Free plan's 1 GB reference limit. Deleting a month removes it from the current tracker and from daily recovery snapshots; download **Back up data** first if you want to keep a separate copy. Neon may not reclaim the underlying storage immediately after a deletion.

---

## 4. Using the app

- **Overview:** outstanding balance, available credit, your credit limit (type a new one any time), the highest month, a chart of every month (tap a bar to open that month), installment progress, who still owes, and a table of all months.
- **Monthly card:** pick a year and a month. You get one merged card: each transaction, amount and person, then the total credit amount, paid, outstanding, credit limit and available credit.
  - **Monthly statements** makes one receipt per person for that month, ready to screenshot. **Copy as text** copies the same receipt for a chat message.
- **People cards:** one card per person (3 across on desktop and tablet, 1 on a phone). Edit the product, price and remark on the card, tick items as paid, add items, or press **Split** to share a bill. Each card has a **Statement (SOA)** button. It shows that person's receipt for the month you filtered, or all of their unpaid charges across every month.
- **Installments:** every plan with its full payment schedule. Tick each payment as it is paid. **New installment** asks for the product, total price, number of months, first payment month, due day and who pays.
- **Settings:** change the master password, check the live database-size bar, and remove a month after confirming. The password and month-management cards sit side by side when there is room and stack on phones and narrower screens. Deleting a month also removes that month from daily recovery snapshots, so download **Back up data** first if you may need a separate copy. Months containing installment payments stay protected until the linked plan is deleted.
- **Split bills:** Add charge → enter the total → choose each person → **Split equally** (or type each share). The shares must add up to the bill.

### How the numbers are calculated
- All money is calculated in whole centavos, so nothing drifts by a fraction.
- **Installment:** monthly amount = total ÷ months, rounded down to the centavo. The last month takes the leftover centavos, so the plan always adds up exactly. Example: ₱10,000 over 3 months is ₱3,333.33, ₱3,333.33, ₱3,333.34.
- **Equal split:** the first people listed take the leftover centavos. ₱100 between 3 people is ₱33.34, ₱33.33, ₱33.33.
- **Outstanding balance:** every charge not yet paid, in all months, including upcoming installments.
- **Available credit:** credit limit minus the outstanding balance.
- The server refuses to save data that does not add up (for example an item whose shares differ from its total).

### Two devices at once
If you edit on your phone and your laptop at the same time, the second device sees a notice asking you to reload, so one device never overwrites the other.

---

## 5. Proof that the numbers are right

Run `npm install` then `npm test` (needs Node 20 or newer). 21 checks run, including:
- Every bill total equals the total printed in your Excel (₱12,193.07 / ₱26,665.05 / ₱45,371.10 / ₱14,124.80 / ₱17,998.93 / ₱19,936.26 / ₱25,986.75).
- Every person's total in every bill equals the section total in your Excel. The Excel values are in `data/excel-checksums.json`.
- The Sharp refrigerator (₱27,055 over 12 months) and the iPad (₱24,108 over 12 months) add up to the exact price. The remaining payments are ₱20,291.26 and ₱10,045.00, which together are the ₱30,336.26 outstanding balance.
- 3,000 random splits and 3,000 random installment plans never gain or lose a centavo.
- Statements add up to the bill and to each person's card.
- The API refuses wrong passwords, forged cookies, stale saves and data that does not add up.

### What was imported from the Excel file
- The seven bills due Apr 9, May 8, Jun 1, Jul 1, Aug 1, Sep 5 and Oct 3, line by line from the person sections.
- Everything up to the Oct 3 bill is marked **paid** (you said all months are paid except November and December).
- Nov 2026 onward is the remaining installment schedule from the Installment sheet, marked unpaid.
- Not imported: the Feb table (it has no per-person breakdown) and the "RealTime Money" block.
- A few charges appear under more than one person in the sheet (for example Penthouse and Coco SM). They are kept as written.

---

## 6. Run it on your own computer (optional)

```
npm install
cp .env.example .env.local     # then fill in APP_PASSWORD and SESSION_SECRET
npm run dev                    # http://localhost:3000
```
With `DATABASE_URL` empty, the dev server saves to a file in `.data/` instead of Neon.

## 7. Files

```
public/index.html    page shell
public/styles.css    the Civic Trust design
public/app.js        screens and buttons
public/logic.js      all money math (used by the app, the server and the tests)
public/favicon.svg   tab icon
api/login.js         POST  /api/login
api/password.js      POST  /api/password (authenticated password change)
api/logout.js        POST  /api/logout
api/state.js         GET and PUT /api/state
lib/handlers.js      the API logic
lib/auth.js          signed login cookie and password hashing
lib/store.js         Neon, file and memory storage
lib/seed.js          your starting data (server only)
data/excel-checksums.json   Excel totals the tests compare against
test/                21 automated checks
scripts/dev.mjs      local server
```
