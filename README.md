# Calendar

An offline desktop calendar built with Electron, Vite, and Bootstrap 5.

## Run

Use Node.js 22.12 or newer. Install dependencies with `npm install`, then run:

```sh
npm start
```

Starting automatically builds the renderer before opening Electron, so source changes appear the next time you start the app. Use `npm run build` to rebuild `dist` separately. On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`.

## Use

- Navigate with the month arrows, Today, or the month picker.
- Select a date to see its agenda. Double-click a date, click New event, or use Add an event to plan something.
- Save all-day or timed events with an optional end time, notes, and one of five colors.
- Click an event in the sidebar to edit it. Deleting requires confirmation.
- Search event names and notes across every month. Coming up lists the next four events from today onward, excluding the selected day.
- Keyboard: arrow keys move between calendar dates, Page Up/Down change months, Enter adds an event, N opens a new event, T goes to today, and Ctrl/Cmd+F focuses search. Escape closes the editor or clears search.

Dates follow the device's local calendar and times are local wall-clock times. Events cover a single date; an end time must be after its start time. Supported years are 1900–2100. Recurring events, automatic cloud synchronization, and notifications are outside the current app.

## Appearance

The Ore UI–inspired design uses squared panels, beveled buttons, and green accents. Open Settings to choose System, Light, or Dark. System follows the operating system and updates while the app is running. Theme changes apply immediately, including to the native window, and are saved automatically in settings.json beside your events. Interface text cannot be highlighted; event fields and search still support selecting, copying, and editing text.

Square scrollbar thumbs appear while scrolling and fade out after a short pause, without moving the content. The page uses an overlay thumb with no native scrollbar gutter. Scrolling supports the wheel, keyboard, touch, and thumb dragging. Reduced-motion preferences disable the fade; high-contrast mode keeps scrollbars visible.

The background is translucent while text and controls stay opaque. Windows 11 22H2 and newer use native Acrylic; macOS uses vibrancy. Other systems use the transparent background without native blur. Reduced-transparency and high-contrast OS preferences take priority. The title bar remains draggable and keeps the native minimize, maximize, and close controls.

## Data

Events are saved as versioned JSON in Electron's user data directory, normally `%APPDATA%\calendar\events.json` on Windows, `~/Library/Application Support/calendar/events.json` on macOS, or `~/.config/calendar/events.json` on Linux. Back up this file while the app is closed. To restore, close the app and replace it with a valid backup. Rebuilding `dist` does not affect events.

Writes are serialized and replace the file through a temporary file. Unreadable or damaged files produce an error and are preserved. The renderer uses narrow calendar, settings, and Drive IPC methods and has no Node.js or filesystem access.

## Google Drive backups

Google Drive is optional. The app connects directly to Google from Electron's main process; no hosted backend, API key, or continuously running server is needed. Sign-in uses your system browser, OAuth authorization code with S256 PKCE and state validation, and a temporary HTTP listener bound only to `127.0.0.1` on an OS-assigned port. The listener closes on completion, denial, cancellation, error, timeout, or app exit.

### One-time Google setup

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) for that project.
3. Configure Google Auth Platform branding, audience, and data access. Add the scope `https://www.googleapis.com/auth/drive.appdata`. If your app is in Testing, add your Google account as a test user.
4. Create an OAuth client with application type **Desktop app**, then download its JSON. Web clients and service accounts are not accepted. Do not configure a hosted redirect URL; Desktop clients support the temporary loopback redirect.
5. Run Calendar, open **Settings → Google Drive → Import OAuth JSON**, select the downloaded file, then choose **Connect Google Drive** and complete the browser consent flow.

Keep the downloaded JSON private and outside source control. The app imports its client configuration into an OS-encrypted local credential file; credentials and access/refresh tokens are never sent to the renderer or written into the events file or Drive backup. If secure credential storage is unavailable, connecting is blocked rather than saving plaintext credentials. On Linux, a working secure keyring is required. The original downloaded JSON is not deleted.

### Upload and restore

- **Upload new backup** creates a new private snapshot of your calendar events. Uploads are manual; there is no background synchronization. Each upload preserves earlier Drive snapshots and consumes Drive storage. There is a 5 MB size limit per backup.
- **Restore latest backup** retrieves the newest snapshot for this app in the connected account, validates every event, then asks for confirmation before replacing local events. A copy of the current calendar is saved first in `backups/before-drive-restore-*.json` beside `events.json`. Cancelling or downloading an invalid backup leaves local events unchanged. The app does not merge calendars.
- **Disconnect** revokes the Google refresh token and removes the local sign-in credentials, retaining the imported OAuth client for reconnecting. It leaves your local calendar unchanged. Revocation requires a network connection.

Backups contain events only, not theme settings or Google credentials. They use Drive's hidden `appDataFolder`, so they do not appear in My Drive and cannot be shared. The app requests only the `drive.appdata` permission, not access to your other Drive files. To restore on another device, import a Desktop OAuth client from the **same Google Cloud project**, sign in to the same Google account, and choose Restore latest backup.

OAuth clients left in Google's external Testing mode commonly receive refresh tokens that expire after seven days; reconnect when prompted, or configure the appropriate publishing status for ongoing use. Google Workspace administrator policies can also restrict access. See [Google's desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app), [application data guide](https://developers.google.com/workspace/drive/api/guides/appdata), and [token expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration).

The encrypted connection is stored in `drive-auth.bin` beside `events.json`. It is tied to the current OS user's credential storage and is not portable. To recover from an unreadable connection file, close Calendar, move that file aside, reopen, and import/connect again. You can revoke the old connection from your Google Account's third-party access settings. Do not remove `events.json` or `settings.json` when resetting a connection.

## Check

```sh
npm test
npm run build
npm run test:smoke
```

Tests cover date boundaries, leap years, event validation, searching, saving and reopening, concurrent writes, and damaged data preservation.

Drive tests use real local loopback callbacks and simulated Google HTTP responses; no real Google account is used. They cover PKCE/state, listener cleanup, encrypted storage, token refresh/revocation, private uploads, failed requests, invalid/oversized downloads, and restore safety copies. Live Google OAuth and Drive access require your own Desktop client and account and are not verified by the automated suite.

The smoke test runs Electron with a hidden window and a separate test profile under `.test-artifacts`. It exercises the real preload, IPC, persistence, editing, searching, deletion, and compact layout, and saves screenshots there for visual review. It does not access your normal calendar data.
