# Divine Passport

Divine Passport is a Vite multi-page app backed by Supabase Auth, PostgreSQL, Storage, and Edge Functions. The browser uses the Supabase publishable key with row-level security; private payment, email, SMS, and push credentials stay in Supabase Edge Function secrets.

## Supabase setup

1. In the Supabase SQL Editor, run [`sql/setup_project.sql`](./sql/setup_project.sql). It creates the app tables, indexes, RLS policies, profile trigger, storage bucket, and admin RPCs. The script is safe to re-run.
2. Copy [`.env.example`](./.env.example) to `.env.local` and set the project URL and publishable key. These two `VITE_` values are public browser configuration, not secrets. Set optional `VITE_APP_URL` to the public site origin when testing locally; do not use `localhost` if opening email links on another device.
3. In **Authentication → URL Configuration**, set the site URL and allow the app's `login.html`, `profile.html`, and `reset-password.html` redirect URLs for local and deployed origins.
4. Enable email/password and phone/SMS sign-in in **Authentication → Providers**. Configure Supabase email delivery and an SMS provider before using email confirmation, password reset, or phone verification.
5. Register your account, then promote it to admin in the SQL Editor:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'you@example.com';
   ```

Existing SQL Server accounts and data are not copied automatically. Password hashes from the old custom login system are not Supabase Auth credentials; users must register again or receive invitations and set new passwords.

## Edge Functions

Install and authenticate with the Supabase CLI, link the project, then deploy the functions used by the app:

```powershell
npx supabase login
npx supabase link --project-ref sezhdqityobfnkpoqslw
npx supabase functions deploy create-wire-transfer
npx supabase functions deploy initialize-donation
npx supabase functions deploy verify-donation
npx supabase functions deploy report-wire-transfer
npx supabase functions deploy admin-review-wires
npx supabase functions deploy invite-member
npx supabase functions deploy send-scriptures
npx supabase functions deploy push-key
npx supabase functions deploy send-daily
npx supabase functions deploy paystack-webhook
```

Set secrets in Supabase, not in `.env.local` or `VITE_` variables:

| Secret | Used for |
|---|---|
| `APP_URL` | Invitation and Paystack return URLs |
| `PAYSTACK_SECRET_KEY` | Donation checkout and verification |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM` | Scripture email and invitations |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | Scripture SMS |
| `DEFAULT_COUNTRY_CODE` | Local phone number normalization; defaults to `233` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push notifications |
| `CRON_SECRET` | Protects the scheduled `send-daily` function |

Configure them with `npx supabase secrets set NAME=value ...`. Set the Paystack webhook URL to `https://sezhdqityobfnkpoqslw.supabase.co/functions/v1/paystack-webhook`.

## Local development

Run `npm run dev` for the Vite app and `npm run build` to build the static site. The app talks directly to the linked Supabase project; Edge Functions must be deployed and their secrets configured for payment, invitations, scripture email/SMS, and push features.

## Features

- Supabase email and phone authentication, profile management, password recovery, and avatar storage.
- Row-level-security protected scriptures, broadcasts, saved deliveries, feedback, and admin operations.
- Supabase Edge Functions for donations, invitations, admin wire review, scripture email/SMS, and push notifications.

The old SQL Server schema and Netlify functions remain as historical migration references; they are not used by the current browser app.
