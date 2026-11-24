# Body Progress Tracker

Personal body measurement tracker for Android. Data lives in your Google Sheet ("Progress Card").

- `apps-script/` JSON API (standalone Google Apps Script) that reads and writes the Sheet.
- `docs/` The app itself (web app, served by GitHub Pages at https://arsalansirkhot.github.io/body-progress-tracker/).
- `android/` Thin APK that opens the web app full screen. Built by GitHub Actions.

Changes to `docs/` go live on the next app open. No reinstall needed.

## What the app does

- **Log**: pick a date (today by default) and fill in only what you measured. Grey numbers are your last values.
  Waist U/L has two boxes (upper, lower) and is saved as `73, 76` like the Sheet.
- **History**: every check-in, newest first, with the weight change since the previous one. Tap one to edit or delete it.
- **Progress**: a chart per measurement (1M / 3M / 6M / 1Y / All), plus first vs latest for everything.
- Works offline: entries made without signal are saved on the phone and synced when you're back online.

### How it reads the Sheet

The Sheet keeps its current layout: measurements down column A, one date per column.

- The row labelled `Date` holds the dates. A new date becomes a new column, placed in date order and formatted like its neighbour.
- Every other labelled row is a measurement. Add a new row (e.g. `Calf`) and it appears in the app on the next refresh.
- Rows whose label starts with an emoji (your 📉 / 📏 lines) are shown at the bottom of Progress.
- Rows with a link (the "Sample video") show as a link under the Log form.
- Rows with formulas are read-only: the app shows them but never overwrites them.
- Logging a date that already has a column adds to it; blank fields leave the Sheet's values alone.

## 1. Turn on GitHub Pages (one time)

Repo **Settings** > **Pages** > Source: **Deploy from a branch** > Branch: **main**, folder **/docs** > **Save**.
After a minute the app is live at https://arsalansirkhot.github.io/body-progress-tracker/.

## 2. Apps Script setup (one time, about 5 minutes)

This is a new, separate script. Any script already attached to the Sheet keeps working; don't change it.

1. Go to https://script.google.com and click **New project**. Name it `Body Tracker API`.
2. Delete the sample code in `Code.gs` and paste in [`apps-script/Code.gs`](apps-script/Code.gs). Save.
3. Click **Project Settings** (gear icon, left side). Under **Script Properties** click **Add script property** twice:
   - `SHEET_ID` = `14M47281ZequdrwJAqJc5vfXHrT80XKb9eWjI44nJ2Rc`
   - `API_TOKEN` = a long random password you make up (e.g. 30+ letters and digits). Keep it; you'll type it into the app once.
   - Optional: `SHEET_NAME` = the tab name, if the measurements are not on the first tab.
   Click **Save script properties**.
4. Back in **Editor**, pick `testSetup` in the function dropdown and click **Run**. Approve the permissions prompt
   (Google shows "unverified app" because it is your own script: click **Advanced** > **Go to Body Tracker API**).
   The log should list your measurements and dates.
5. Click **Deploy** > **New deployment**. Click the gear next to "Select type" > **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   Click **Deploy** and copy the **Web app URL** (ends in `/exec`).

"Anyone" only means the URL is reachable. Every request must carry your `API_TOKEN`, so nobody can read or write your Sheet without it.

**Updating the script later:** paste the new code, then **Deploy** > **Manage deployments** > pencil icon > Version: **New version** > **Deploy**. The URL stays the same.

## 3. Install the app on your phone

1. On your phone, open https://github.com/arsalansirkhot/body-progress-tracker/releases/latest and download `BodyTracker.apk`.
2. Open it. Android asks to allow installs from your browser: allow it, then **Install**.
3. Open **Body Tracker**. On first launch it shows Settings: paste the Web app URL and your API token, then **Save and test**.

You can also skip the APK and use the web app directly in Chrome (menu > **Add to Home screen**).

## Notes

- Apps Script calls take 1–3 seconds, so saving and refreshing aren't instant.
- The APK signing key (`android/app/release.keystore`) is committed so every build installs over the previous one. Fine for a personal sideloaded app; don't publish this APK to a store.
- Export: History > **Export CSV** (one row per date). In the Android app the CSV downloads through your browser (check Downloads).
- Only a change under `android/` builds a new APK. Everything else updates on the next app open.
- Sharing with someone else: they need their own copy of the Sheet and their own Apps Script deployment; the same APK works, they just enter their own URL and token.
