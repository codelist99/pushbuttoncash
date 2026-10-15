# Push Button System funnel

## Run

Use Node 20 or newer:

```bash
copy .env.example .env
npm start
```

Set `ADMIN_USER`, `ADMIN_PASSWORD`, and `WEBHOOK_SECRET` in the hosting environment. The admin dashboard is available at `/admin` and uses HTTP Basic authentication.

## Tracking endpoints

- `POST /api/track/optin` records an opt-in, consent, attribution, and transaction ID.
- `POST /api/track/event` records page views and checkout clicks.
- `POST /api/webhooks/fanbasis` records or updates payments. Send the `X-Webhook-Secret` header matching `WEBHOOK_SECRET`.
- `/api/admin/leads/export` and `/api/admin/sales/export` download separate CSV files.

Production data is stored in `data/events.json`. Deploy to a Node host with persistent storage mounted for `data`. Static-only hosting cannot receive webhooks or persist dashboard data.
