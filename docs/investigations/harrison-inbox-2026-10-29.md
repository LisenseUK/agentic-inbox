# Harrison inbox incident, 29 October 2026

## Findings

The inbox failure and the delivery to `peterscrew@snailbox.live` were separate events. The mailbox's SQLite storage returned `out of memory: SQLITE_NOMEM`, including during initialization and small reads. The exact trigger for the native SQLite failure has not been established.

The failing reads recovered after temporary diagnostic code was removed and the original application version was reactivated. No messages were deleted, moved, restored, or edited during the investigation.

## Delivery timeline

All times are UTC.

- **15:30:16:** First captured failure reading `harrison@lisense.uk` folders. Subsequent failures included SQLite memory errors during `applyMigrations` and `MailboxEvents` initialization.
- **15:30:24.731:** Cloudflare delivered a 7,234-byte message to `peterscrew@snailbox.live`. The Worker logged `Ignoring email for peterscrew@snailbox.live: mailbox does not exist and no catch-all configured`. This delivery returned before storing a message. It was not routed to the Harrison mailbox.
- **15:37:37:** Automatic creation of mailboxes was deployed, after the inbox failure had already started.
- **15:40:48–15:40:53:** The supplied HAR shows mailbox metadata returning HTTP 200, with folders and the threaded inbox list repeatedly returning HTTP 500 and `Internal Server Error`.

The earlier snailbox message must be resent if it is needed in this application. Automatic mailbox creation cannot recover an already discarded delivery.

## Reproduction and inspection

A temporary private Wrangler preview bound to the existing production `MailboxDO` namespace reproduced the same failures through `getFolders`, `getEmails`, and `getThreadedEmails`. It did not expose a public inbox endpoint or invoke email sending.

The minimized live reproduction was an ordinary message-list read with `limit=1`. A lookup for a nonexistent message and an empty-folder list also failed. This rules out the threaded query as the only trigger and does not isolate the failure to one email.

`support@lisense.uk` passed the equivalent reads. Harrison's folder and count queries sometimes succeeded while other reads failed.

Temporary read-only diagnostics reported:

- Database size: **2,150,400 bytes**, approximately 2.05 MiB.
- Stored messages: **108**, comprising 34 inbox messages, 58 drafts, and 16 sent messages.
- Folder counts were readable.
- Reading message lengths and `PRAGMA quick_check(1)` failed with `SQLITE_NOMEM`. Database integrity therefore could not be established while the fault was active.

A separate local test with 128 synthetic messages and 64 MiB of bodies passed both ordinary and threaded reads. It did not reproduce the production storage failure. No query rewrite or schema change was deployed as a speculative fix.

## Recovery and validation

The private diagnostic method was removed by reactivating the exact original application version, `8c92cddd-950c-4742-8168-0b3769bd726f`, at 100% traffic. All original modules and bindings were verified against the pre-investigation snapshot. This version retains automatic mailbox creation.

After reactivation, the original failing database methods succeeded:

- Folder read: HTTP 200, six folders.
- Ordinary message list: HTTP 200.
- Threaded inbox list with the normal limit of 25: HTTP 200, 25 conversations.
- Message count: HTTP 200, still 108 messages.

This verifies backend recovery. The supplied HAR omitted authentication cookies, and the investigation browser was not signed into Access, so a fresh authenticated browser render was not verified.

## If the failure recurs

Preserve the current mailbox and capture the failed request's timestamp and Cloudflare error reference. The evidence currently supports a fault in the mailbox's SQLite runtime/storage state; it does not establish permanent corruption or a particular malformed message. Do not delete mail or restore an older database snapshot on that assumption.

Cloudflare diagnostic identifiers:

- Worker: `agentic-inbox`, class `MailboxDO`.
- Object ID: `a8304573f7f37335f97df94c225b7e2993c2868bc12f64094d680058c6a6e8ee`.
- SQLite failure at 15:30:18.817: request `d3e35329a79563367758d318abce3c5f`, trace `4b261e193c5c92808dd3eb05c00b03d7`.
- SQLite failure at 15:30:20.131: request `cb4deaad5ae209fc85aa48d6ac7ca5d2`, trace `0317ad331147000151afb23a8866cfec`.

HAR contents, cookies, and tokens are not included in this report.
