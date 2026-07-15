# notion-worker-luma-api-sync

A [Notion Worker](https://developers.notion.com/workers/get-started/overview.md) that syncs the guest list of a single [Luma](https://luma.com) event into a Notion database.

Every 15 minutes, the `lumaGuestsSync` capability pulls all guests from Luma's [List Guests endpoint](https://docs.luma.com) (`GET /v1/events/guests/list`) and writes them to a Worker-managed database titled **Luma Guests**, keyed on Guest ID. The sync runs in replace mode, so guests removed upstream are also removed from Notion.

## What gets synced

All fields returned by the list-guests endpoint:

| Notion property | Source |
|---|---|
| Name (title) | `user_name`, falling back to `user_email` |
| Guest ID (primary key), User ID | `id`, `user_id` |
| Email, First Name, Last Name, Phone Number | `user_email`, `user_first_name`, `user_last_name`, `phone_number` |
| Approval Status (select) | `approval_status` |
| Registered At, Invited At, Joined At | `registered_at`, `invited_at`, `joined_at` |
| Check-in QR Code, UTM Source | `check_in_qr_code`, `utm_source` |

**Registration answers** (`registration_answers`) are flattened into one property per question. The mapping lives in the `QUESTIONS` config in [src/index.ts](src/index.ts): question labels are trimmed into short property names (e.g. "Have you used Zapier before?" → **Zapier Experience**), dropdown questions become select properties, email-shaped questions become email properties, and the mailing-list opt-in becomes a checkbox. Comma-laden dropdown values are normalized into valid select option names ("No, not a Lorong AI Member" → "No").

**Event tickets** (`event_tickets`) are flattened into: Ticket Names, Ticket Count, Ticket IDs, Ticket Type IDs, Checked In (checkbox), Checked In At (earliest check-in), and Tickets Captured. Monetary fields (`amount`, `amount_discount`, `amount_tax`, `currency`) are intentionally ignored — our events are free.

Crypto wallet fields (`eth_address`, `solana_address`) are not synced.

## Setup

Requires Node ≥ 22 and the [`ntn` CLI](https://ntn.dev), logged into a workspace with Workers enabled.

```bash
npm install
ntn login
```

Configure the two environment variables (see [.env.example](.env.example)):

```bash
ntn workers env set LUMA_API_KEY=<key>      # generate on the Luma calendar dashboard
ntn workers env set LUMA_EVENT_ID=evt-xxxx  # the event to sync
```

For local runs (`ntn workers exec … --local`, previews of local code), put the same values in a `.env` file — it's git-ignored.

## Deploy & operate

```bash
npm run check                                    # type-check
ntn workers deploy                               # build and publish
ntn workers sync trigger lumaGuestsSync --preview  # inspect output without writing
ntn workers sync trigger lumaGuestsSync          # force an immediate real run
ntn workers sync status                          # monitor health
```

Deploys do not reset sync state. To rebuild from scratch: `ntn workers sync state reset lumaGuestsSync && ntn workers sync trigger lumaGuestsSync`.

## Rate limits

Luma allows 200 requests/minute per calendar API key. The worker declares a pacer at 100 requests/minute (half the budget) and paginates 100 guests per page, so even large guest lists sync in a handful of requests.

## Changing the event or its questions

- **Different event**: update `LUMA_EVENT_ID`, then reset sync state and trigger. If the new event has different registration questions, update the `QUESTIONS` config to match.
- **Questions added or reworded on the event**: answers whose labels aren't in `QUESTIONS` are skipped. Add the new label (with a trimmed property name and kind) to the config and redeploy.
- Old columns left behind by schema changes can be deleted from the Notion database by hand — the sync no longer writes to them.
