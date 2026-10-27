# TRATOPUP — Deploy to Vercel + Neon + Bakong

1. **Neon**: create a Postgres project, copy the connection string.
2. **GitHub**: push this folder to a repo.
3. **Vercel**: Add New → Project → import the repo, then set env vars:

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `JWT_SECRET` | random string, 32+ chars |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first admin login |
| `BAKONG_ACCOUNT_ID` | your Bakong account, e.g. `name@abaa` |
| `BAKONG_API_TOKEN` | token from https://api-bakong.nbc.gov.kh/register |
| `BAKONG_MERCHANT_NAME` | shop name shown in the bank app |
| `NEXT_PUBLIC_BASE_URL` / `PUBLIC_APP_URL` | your https site URL |
| `PAYMENT_SIMULATION_MODE` | `true` to test without real payments |

4. First deploy only: set Build Command to
   `npx prisma db push && npx tsx prisma/seed.ts && npm run build`,
   deploy, then change it back to `npm run build`.

Payments: the checkout page shows a Bakong KHQR (valid 10 min). Bakong has no
webhooks, so the server polls `check_transaction_by_md5` while the customer
waits. Bakong's API may block non-Cambodian IPs; if checks fail from Vercel, set
`BAKONG_API_URL` to a proxy hosted in Cambodia.
