-- Run after schema.sql. Enable pg_cron and pg_net in the Supabase Dashboard first.
create table if not exists public.push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users on delete cascade,
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists ps_own on public.push_subscriptions;
create policy ps_own on public.push_subscriptions for all
    using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- claim_scripture_for() and claim_scripture() are installed by schema.sql or
-- migration_scripture_broadcast.sql so app and push share the current broadcast.
revoke all on function public.claim_scripture_for(uuid) from public, anon, authenticated;
grant execute on function public.claim_scripture_for(uuid) to service_role;

-- Daily delivery at 06:00 UTC (= 06:00 Accra). Replace both values before running.
-- A guard prevents accidentally scheduling the literal placeholders. Running
-- this block again updates the named pg_cron job instead of adding another one.
do $$
declare
    project_ref text := 'YOUR_PROJECT_REF';
    cron_secret text := 'YOUR_CRON_SECRET';
begin
    if left(project_ref, 5) = 'YOUR_'
        or left(cron_secret, 5) = 'YOUR_'
        or btrim(project_ref) = ''
        or btrim(cron_secret) = '' then
        raise exception 'Set project_ref and cron_secret in sql/push.sql before scheduling daily-scripture.';
    end if;

    perform cron.schedule(
        'daily-scripture',
        '0 6 * * *',
        format(
            'select net.http_post(url := %L, headers := %L::jsonb)',
            format('https://%s.supabase.co/functions/v1/send-daily', project_ref),
            jsonb_build_object('x-cron-secret', cron_secret)::text
        )
    );
end;
$$;

select jobname, schedule, active
from cron.job
where jobname = 'daily-scripture';
