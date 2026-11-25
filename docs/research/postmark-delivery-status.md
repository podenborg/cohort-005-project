# Postmark delivery status for notification emails

Research for issue #3, "Research Postmark delivery status for notification emails".
Sources were read on 2026-11-25. Every claim links to the page that owns it. The sources are the official Postmark docs under `postmarkapp.com/developer`. Three claims come from other first-party Postmark pages and are marked **(vendor, non-/developer)**.

## Question

`postmarkTransport` in `app/lib/mailer.server.ts` POSTs to `https://api.postmarkapp.com/email` and throws on a non-OK response. Notification emails are sent after the DB transaction commits and are best-effort. A failed send is recorded on the notification row.

1. What does a rejected Postmark send return, and which failures are worth recording on a notification row?
2. Does Postmark offer delivery and bounce webhooks, and what would receiving them need from this app?
3. Are there rate or volume limits that matter for one email per notification?

## Current behaviour, for reference

This comes from reading `app/lib/mailer.server.ts` in the author's working copy. The file is not on `origin/main` yet.

- The request sends `From`, `To`, `Subject`, `TextBody` and `MessageStream: "outbound"`. It sets no `Tag` and no `Metadata`.
- On `!response.ok` it throws `Postmark rejected the email to <to>: <status>`. It never reads the response body.
- On success it discards the response body. `MailTransport.send` returns `Promise<void>`, so the Postmark `MessageID` is lost.

Both gaps matter below. The error body carries the `ErrorCode` and `Message` that distinguish failure causes. The success body carries the `MessageID` that webhooks refer to.

## 1. What a rejected send returns

### Response shape

The send endpoint's response has `To`, `SubmittedAt`, `MessageID`, `ErrorCode` and `Message`. A success returns HTTP 200 with `ErrorCode: 0` and `Message: "OK"`. [Email API](https://postmarkapp.com/developer/api/email-api)

When Postmark detects a problem, it returns a JSON body with a numeric `ErrorCode` and a human-readable `Message`. It also echoes the code in the `X-PM-ApiErrorCode` response header. Most input errors use HTTP 422, but some use another status. Each code's status is listed in the error-code table. A single `ErrorCode` can cover several related messages. [API overview, error codes](https://postmarkapp.com/developer/api/overview#error-codes)

Example error body, from the same page:

```json
{ "ErrorCode": 403, "Message": "Invalid request field(s): 'From'." }
```

The docs say the `ErrorCode` field "can be used to programmatically detect the type of error". [API overview](https://postmarkapp.com/developer/api/overview#error-codes)

### HTTP status codes

All of these are from [API overview, HTTP response codes](https://postmarkapp.com/developer/api/overview#http-response-codes).

| HTTP | Meaning in the docs | Nature |
| --- | --- | --- |
| 200 | Success | n/a |
| 401 | Missing or incorrect API token in the header | Config bug. Retrying will not help. |
| 413 | Payload over 10 MB for the Email API | Not applicable to short notification emails. |
| 415 | Request is missing the expected headers | Code bug. |
| 422 | Malformed JSON or invalid fields. The body has an API `ErrorCode` and `Message`. | Mostly permanent for that message. See the table below. |
| 429 | Request rate exceeds acceptable use. "You should reduce the rate at which you query the API." | Transient. Back off. |
| 500 | Problem on Postmark's servers. "In most cases the message is lost during the process." | Transient. |
| 503 | Planned service outage. Returns the associated JSON body. | Transient. |

### Send-related API error codes

These are from the [API error codes table](https://postmarkapp.com/developer/api/overview#error-codes). The "Sending" rows are the ones a `/email` call can hit.

| ErrorCode | HTTP | Docs message (abridged) | Relevance to a notification |
| --- | --- | --- | --- |
| 10 | 401 | No valid Server or Account token, or the wrong token type | Misconfiguration: `POSTMARK_SERVER_TOKEN` is wrong. Affects every send. |
| 300 | 422 | Send validation: zero recipients, invalid address, missing `TextBody`/`HtmlBody`, recipient/metadata/attachment/header limits | Per-message bad data, for example a malformed recipient address. |
| 402 | 422 | Invalid JSON | Code bug. |
| 403 | 422 | Invalid request field(s) | Code bug, for example a bad `From`. |
| 406 | 422 | Inactive recipient | Per-recipient. See the next paragraph. |
| 412 | 422 | While the account is pending approval, all recipients must share the `From` domain | Account state. Affects every send to other domains. |
| 413 | 422 | This account is not approved to send email | Account state. Affects every send. |
| 422 | 422 | Invalid Server or Account | Misconfiguration. |
| 100 | 503 | API offline for maintenance | Transient. |
| 101 | 500 | Unexpected error. The response includes an `Error ID` for support. | Transient or Postmark-side. |

The 406 row says "Inactive recipient". The example in the batch docs spells it out. "You tried to send to a recipient that has been marked as inactive … Inactive recipients are ones that have generated a hard bounce, a spam complaint, or a manual suppression." [Email API, batch response example](https://postmarkapp.com/developer/api/email-api) So a user whose address hard-bounced earlier will produce a 406 on every later notification. This is the only documented way a prior delivery failure shows up synchronously on the send.

Two other facts from the same pages:

- The sender must have a registered and confirmed Sender Signature. Otherwise the API returns 422. [Sending email with API](https://postmarkapp.com/developer/user-guide/send-email-with-api)
- Passing `POSTMARK_API_TEST` as the server token validates the request without delivering the email. [API overview, authentication](https://postmarkapp.com/developer/api/overview#authentication)

Note that the batch endpoint behaves differently. `/email/batch` returns a 200-level status even when individual messages fail validation, so each result must be checked. [Email API, batch response](https://postmarkapp.com/developer/api/email-api) This app uses the single `/email` endpoint, so the batch behaviour does not apply today. It would matter if sends were ever batched.

### Which failures are worth recording on the notification row

This is an interpretation of the sources above. The docs do not say which fields an app should store.

Worth recording, because they let someone act on the failure:

- The HTTP status.
- `ErrorCode` and `Message` from the body, when the body parses as JSON. The `ErrorCode` is the documented machine-readable discriminator. A bare HTTP status like the current thrown message cannot tell 422/406 (bad recipient) from 422/403 (code bug).
- A coarse failure class derived from those, so the UI or a retry job does not need to know Postmark's codes:
  - **recipient** (300, 406): that user's address is the problem. It is not worth retrying until the address changes.
  - **config/account** (10, 412, 413, 422 with ErrorCode 422, 401): the whole integration is broken. This should be an alert, not just a row flag.
  - **transient** (429, 500, 503, network error): a retry could succeed.
  - **other**: a code bug (402, 403, 415).
- The `MessageID` on a successful send. See section 2.

Not worth recording as separate states: the individual 4xx codes for pagination, streams, templates and similar. A `/email` call cannot return them.

Network failures (a `fetch` rejection, a timeout) never reach Postmark's error handling and have no `ErrorCode`. The row should still record them as a failed send with the thrown message.

## 2. Delivery and bounce webhooks

### They exist

Postmark offers outbound webhooks for delivery, bounce, spam complaint, open, click and subscription change events. It also offers inbound webhooks, which are not relevant here. [Webhooks overview](https://postmarkapp.com/developer/webhooks/webhooks-overview)

A webhook is "the act of Postmark making an HTTP POST request to your application's API when an event occurs", so the app does not have to poll. [Webhooks overview](https://postmarkapp.com/developer/webhooks/webhooks-overview)

**Delivery webhook** [docs](https://postmarkapp.com/developer/webhooks/delivery-webhook):

- It fires when the destination email server returns an OK response. It is per recipient.
- "Delivery means the receiving server accepted your message, not that it reached the inbox." Spam filtering and forwarding happen after this point.
- Payload fields: `RecordType: "Delivery"`, `MessageStream`, `ServerID`, `MessageID`, `Recipient`, `Tag`, `DeliveredAt`, `Details` (the destination server's response line), `Metadata`.

**Bounce webhook** [docs](https://postmarkapp.com/developer/webhooks/bounce-webhook):

- It fires when inbox providers respond with outcomes such as a hard bounce, soft bounce or undeliverable.
- Spam complaints, subscription changes and manual deactivations have their own webhooks and do not fire this one.
- Payload fields: `RecordType: "Bounce"`, `ID`, `Type`, `TypeCode`, `Name`, `Description`, `Details`, `MessageID`, `Metadata`, `Tag`, `Email`, `From`, `BouncedAt`, `Inactive`, `CanActivate`, `Subject`, and optionally `Content`, the full bounce dump. `Content` is off by default.
- `TypeCode` 1 is a hard bounce. The address is invalid and should be suppressed. `TypeCode` 4096 is a soft bounce. Check `Inactive` and `CanActivate`. `TypeCode` 2 is a transient failure. [Bounce webhook, important TypeCodes](https://postmarkapp.com/developer/webhooks/bounce-webhook)
- The full list of bounce types is on the [Bounce API page](https://postmarkapp.com/developer/api/bounce-api). It includes `HardBounce` (1), `Transient` (2), `SoftBounce` (4096), `BadEmailAddress` (100000), `Blocked` (100006, an ISP block), `DMARCPolicy` (100009) and `SpamComplaint` (100001). Spam complaints arrive on their own webhook, as noted above.

Webhooks are configured per Server and Message Stream. The default transactional stream is `outbound`, which is what the transport already uses. [Webhooks API](https://postmarkapp.com/developer/api/webhooks-api) Enable them in the Postmark UI, or via the API with `Triggers.Delivery.Enabled` and `Triggers.Bounce.Enabled`. [Delivery webhook](https://postmarkapp.com/developer/webhooks/delivery-webhook), [Bounce webhook](https://postmarkapp.com/developer/webhooks/bounce-webhook)

### Correlating an event with a notification row

Both payloads carry `MessageID` and `Metadata`.

- The send response's `MessageID` "can be used to log in your system. It can then be used to associate the message you sent to a possible bounce that you obtained from a bounce webhook or the bounce API." [Sending email with API](https://postmarkapp.com/developer/user-guide/send-email-with-api)
- The send request accepts a `Metadata` object of custom key/value pairs. [Email API](https://postmarkapp.com/developer/api/email-api) The delivery and bounce payloads echo it back as "Custom metadata that was included in the email". [Delivery webhook](https://postmarkapp.com/developer/webhooks/delivery-webhook), [Bounce webhook](https://postmarkapp.com/developer/webhooks/bounce-webhook)

So there are two ways to correlate: store the `MessageID` on the row, or send the notification id as `Metadata`. The current transport does neither. Metadata is the more robust option, because it does not depend on the `MessageID` being persisted after the post-commit send.

### What receiving webhooks needs from this app

All from [Webhooks overview](https://postmarkapp.com/developer/webhooks/webhooks-overview) unless noted.

1. **A public HTTPS endpoint.** "You will need a publicly accessible URL." Postmark "highly recommend[s] using HTTPS". Local development needs a tunnel or a request-capture service. The docs suggest curl against the endpoint, or RequestBin. [Testing your webhook](https://postmarkapp.com/developer/webhooks/webhooks-overview)
2. **No signature verification is available.** "Postmark does not currently support HMAC webhook signature verification." The docs recommend two things instead, plus payload validation:
   - HTTP Basic Authentication, set as `https://<username>:<password>@example.com/webhook`, or through the `HttpAuth` field of the Webhooks API ([Webhooks API](https://postmarkapp.com/developer/api/webhooks-api)). The API also supports custom `HttpHeaders`, so a shared-secret header is possible too.
   - Allowlisting Postmark's webhook IPs. The origin IP "can change for each attempt". The addresses are on [Postmark's IPs for firewalls page](https://postmarkapp.com/support/article/800-ips-for-firewalls) **(vendor, non-/developer)**.
   - Validating the structure of the payload before acting on it.
3. **Respond 200 quickly.** Any non-200 response counts as a failure. If the endpoint is slow, "respond with a 200 first, then process the event or hand it off to a queue".
4. **Be idempotent.** Retries, and timeouts where the work was done but the response was late, mean an event can arrive more than once.
   - The `X-PM-Webhook-Trace-Id` header is stable across retries of the same event, and the delivery and bounce pages say it is the better dedupe key. Fall back to a compound key: `MessageID` + `Recipient` + `DeliveredAt` for delivery, or `MessageID` + `Email` + `BouncedAt` for bounce. [Delivery webhook](https://postmarkapp.com/developer/webhooks/delivery-webhook), [Bounce webhook](https://postmarkapp.com/developer/webhooks/bounce-webhook)
   - `MessageID` alone does not identify one delivery, because a message sent to several recipients produces several delivery events. This app sends to one recipient per message.
   - A status update such as "mark delivered" or "mark bounced" is naturally idempotent if the handler only writes final states.
5. **Retry behaviour to design for.**
   - Retried: 5xx, 408, 429 and network failures. Not retried: any other 4xx. The event is dropped.
   - The back-off schedule is 1, 5, 10, 10, 10 and 15 minutes, six attempts in all. After that, Postmark stops retrying that event. Each request carries an `X-PM-Retries-Remaining` header.
   - So a handler that throws a 4xx on, say, a not-yet-committed notification row would lose the event permanently. Return 5xx, or 200 after queueing, in any case where the row might legitimately not exist yet.
6. **Webhook health.** If an event type fails every delivery attempt, Postmark emails a warning and keeps sending for 48 hours. If nothing gets through in that time, it disables that event type until the webhook is verified again. Events that happen while disabled are not replayed. Health is tracked per event type. [Webhook health notifications](https://postmarkapp.com/developer/webhooks/webhooks-overview)
7. **Verification on create.** When a webhook is created or edited, Postmark tests the endpoint for each enabled event type and expects a 200. The docs do not say what the test payload contains. The endpoint must therefore not fail verification just because an event matches no notification row. This has to be balanced against item 5, where an unknown row may be a real row that is not committed yet. [Verifying your webhook](https://postmarkapp.com/developer/webhooks/webhooks-overview), [Webhooks API](https://postmarkapp.com/developer/api/webhooks-api)

In this app, receiving webhooks would mean an unauthenticated-by-session route (Postmark has no user session, which collides with the "401 Select a user from the DevUI panel" behaviour in `AGENTS.md`), a Basic-Auth check on it, and a new write path to the notification row. This is an inference from the app's structure, not from the Postmark docs.

### Polling alternative

There are also pull APIs. The Bounce API lists bounces for the server, and "Bounces are available for your retention period, which is 45 days by default". The Messages API can search outbound messages. [Bounce API](https://postmarkapp.com/developer/api/bounce-api), [Webhooks overview](https://postmarkapp.com/developer/webhooks/webhooks-overview) A polling job avoids exposing an endpoint but needs a scheduler. This note did not read the Messages API reference pages in detail.

## 3. Rate and volume limits

- **No numeric request rate limit is documented for sending.** The API overview documents a 429 ("a rate that exceeds acceptable use of the API. You should reduce the rate") but states no number. [API overview](https://postmarkapp.com/developer/api/overview#http-response-codes) Postmark's own SendGrid migration guide says Postmark "does not have a hard limit for requests/second when sending email". [Postmark migration guide](https://postmarkapp.com/migration-guides/sendgrid) **(vendor, non-/developer)**
- **Per-message limits.**
  - A message has at most 50 recipients across To, Cc and Bcc. [Sending email with API](https://postmarkapp.com/developer/user-guide/send-email-with-api)
  - Total message size is at most 10 MB. [Sending email with API](https://postmarkapp.com/developer/user-guide/send-email-with-api)
  - Subject is at most 2000 characters. `Tag` is at most 1000 characters. [Email API](https://postmarkapp.com/developer/api/email-api)
  - One email per notification is far inside all of these.
- **Batch.** `/email/batch` takes up to 500 messages and 50 MB per call. [Email API](https://postmarkapp.com/developer/api/email-api)
- **Monthly volume depends on the plan.** The free Developer plan includes 100 emails per month, and "No overages allowed in this plan". Paid plans list "Unlimited emails/day". [Postmark pricing](https://postmarkapp.com/pricing) **(vendor, non-/developer)** This is the limit most likely to matter. On the free plan, one email per notification would stop being accepted once the month's allowance is used up. The pricing page does not say what error code comes back at that point, and none of the error-code rows read for this note describes it.
- **SMTP** has an informal 10-concurrent-connections recommendation. [Postmark support](https://postmarkapp.com/support/article/do-we-have-rate-limits-for-smtp) **(vendor, non-/developer)** It does not apply, because this app uses the HTTP API.

## What this means for the notifications spec

- **Record structured failure detail, not just a status.** Read the error response body on a non-OK send. Store the HTTP status, `ErrorCode` and `Message`. Add a coarse class: recipient, config/account, transient or other. The `ErrorCode` is the only documented way to tell a bad recipient from a bug.
- **Decide retry policy per class.** Postmark documents 429, 500 and 503 as transient. 406 and 300 are about the one recipient, so retrying will not help. 10, 412, 413 and 422/422 mean every send is failing and should raise an operator alert. The spec's "best-effort" stance fits, but a 406 will recur for every notification to that user.
- **Capture the `MessageID` on success, and send the notification id as `Metadata`.** Change `MailTransport.send` to return the `MessageID` (it is `void` now). Add the notification id to `Metadata` in the request. Either one is what lets a later webhook find the row. Without them, delivery status cannot be wired up later without changing the transport.
- **Treat delivery and bounce webhooks as a separate, optional later step.** They are available and cheap to enable for the `outbound` stream. They need a public route, Basic Auth (there is no signing), idempotent handling keyed on `X-PM-Webhook-Trace-Id`, and a fast 200. They do not change what the post-commit send records. They only add later states: delivered, or bounced with `TypeCode`. A "delivered" state means the receiving server accepted the message, not that it reached the inbox.
- **Extra row states if webhooks are adopted.** A hard bounce (`TypeCode` 1) means the address is bad, and Postmark will then reject further sends to it with 406. The spec could record the bounce on the row, and possibly flag the user's address.
- **Volume is mainly a plan question.** One email per notification is well inside every documented per-request limit. Confirm which Postmark plan production uses, because a capped plan can reject sends once the monthly allowance is spent.

## Open items not answered from primary sources

- What Postmark returns when a plan's monthly allowance is exhausted. No error-code row read for this note describes it.
- Exact request-rate threshold for 429. Postmark publishes no number.
- Whether `/email` accepts an idempotency key. None appears in the request-body table, so a retry after a timeout can send a duplicate. See [Email API](https://postmarkapp.com/developer/api/email-api).
