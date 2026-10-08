create table if not exists public.donations (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    donor_email text not null,
    donor_name text,
    amount_minor bigint not null check (amount_minor between 100 and 10000000),
    currency text not null default 'GHS' check (currency = 'GHS'),
    status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
    created_at timestamptz not null default now(),
    paid_at timestamptz
);

create index if not exists donations_status_created_idx
    on public.donations (status, created_at desc);

alter table public.donations enable row level security;
revoke all on table public.donations from public, anon, authenticated;
grant all on table public.donations to service_role;
