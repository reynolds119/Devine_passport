-- Divine Passport complete database setup.
-- Safe to re-run: this script creates missing objects and refreshes the
-- app-owned policies/functions. It does not delete user or app data.
-- Run in Supabase Dashboard -> SQL Editor.
--
-- This app uses church-wide scripture broadcasts. Do not also run
-- migration_scripture_schedule.sql; it replaces the broadcast delivery model.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users on delete cascade,
    full_name text,
    email text,
    phone text,
    delivery_channel text not null default 'email' check (delivery_channel in ('email', 'phone')),
    nationality text,
    occupation text,
    profile_photo text,
    registration_status text not null default 'APPROVED'
        check (registration_status in ('PENDING', 'APPROVED', 'REJECTED')),
    role text not null default 'member'
        check (role in ('member', 'admin')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.profiles
    add column if not exists delivery_channel text not null default 'email'
    check (delivery_channel in ('email', 'phone'));

create table if not exists public.scriptures (
    id uuid primary key default gen_random_uuid(),
    reference text not null,
    body text not null,
    note text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.scripture_broadcast (
    singleton boolean primary key default true check (singleton),
    scripture_id uuid references public.scriptures on delete restrict,
    broadcast_at timestamptz
);

insert into public.scripture_broadcast (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.deliveries (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users on delete cascade,
    scripture_id uuid not null references public.scriptures on delete cascade,
    delivered_at timestamptz not null default now(),
    read_at timestamptz,
    saved boolean not null default false
);

create table if not exists public.feedback (
    id uuid primary key default gen_random_uuid(),
    delivery_id uuid not null references public.deliveries on delete cascade,
    user_id uuid not null references auth.users on delete cascade,
    message text not null check (length(trim(message)) > 0),
    created_at timestamptz not null default now()
);

create index if not exists deliveries_user_day_idx
    on public.deliveries (user_id, delivered_at desc);
create index if not exists deliveries_saved_idx
    on public.deliveries (user_id, delivered_at desc) where saved;
create index if not exists deliveries_scripture_idx
    on public.deliveries (scripture_id);
create index if not exists feedback_delivery_idx
    on public.feedback (delivery_id, created_at);
create index if not exists scriptures_active_idx
    on public.scriptures (active, created_at desc);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles
        where user_id = auth.uid()
            and role = 'admin'
            and registration_status = 'APPROVED'
    );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (
        user_id, email, full_name, phone, delivery_channel, nationality, occupation
    )
    values (
        new.id,
        coalesce(new.email, new.raw_user_meta_data ->> 'email'),
        new.raw_user_meta_data ->> 'full_name',
        coalesce(new.phone, new.raw_user_meta_data ->> 'phone'),
        coalesce(new.raw_user_meta_data ->> 'delivery_channel', 'email'),
        new.raw_user_meta_data ->> 'nationality',
        new.raw_user_meta_data ->> 'occupation'
    )
    on conflict (user_id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_signup on auth.users;
create trigger on_signup
after insert on auth.users
for each row execute function public.handle_new_user();

insert into public.profiles (
    user_id, email, full_name, phone, delivery_channel, nationality, occupation
)
select
    u.id,
    coalesce(u.email, u.raw_user_meta_data ->> 'email'),
    u.raw_user_meta_data ->> 'full_name',
    coalesce(u.phone, u.raw_user_meta_data ->> 'phone'),
    case
        when u.raw_user_meta_data ->> 'delivery_channel' in ('email', 'phone')
            then u.raw_user_meta_data ->> 'delivery_channel'
        else 'email'
    end,
    u.raw_user_meta_data ->> 'nationality',
    u.raw_user_meta_data ->> 'occupation'
from auth.users u
on conflict (user_id) do nothing;

create or replace function public.guard_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if auth.uid() is not null and not public.is_admin() then
        new.role := old.role;
        new.registration_status := old.registration_status;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists guard_profile_update on public.profiles;
create trigger guard_profile_update
before update on public.profiles
for each row execute function public.guard_profile();

create or replace function public.set_scripture_broadcast_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    perform pg_advisory_xact_lock(7001);
    new.broadcast_at := clock_timestamp();
    return new;
end;
$$;

drop trigger if exists scripture_broadcast_timestamp on public.scripture_broadcast;
create trigger scripture_broadcast_timestamp
before update on public.scripture_broadcast
for each row execute function public.set_scripture_broadcast_time();

create or replace function public.claim_scripture_for(uid uuid)
returns public.deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
    delivery public.deliveries;
    broadcast_scripture uuid;
    broadcast_time timestamptz;
begin
    if uid is null then
        return null;
    end if;

    perform pg_advisory_xact_lock(7001);

    select scripture_id, broadcast_at
    into broadcast_scripture, broadcast_time
    from public.scripture_broadcast
    where singleton;

    if not found or broadcast_scripture is null or broadcast_time is null then
        return null;
    end if;

    select *
    into delivery
    from public.deliveries
    where user_id = uid
        and scripture_id = broadcast_scripture
        and delivered_at >= broadcast_time
    order by delivered_at desc, id desc
    limit 1;

    if found then
        return delivery;
    end if;

    insert into public.deliveries (user_id, scripture_id)
    values (uid, broadcast_scripture)
    returning * into delivery;
    return delivery;
end;
$$;

create or replace function public.claim_scripture()
returns public.deliveries
language sql
security definer
set search_path = ''
as $$
    select * from public.claim_scripture_for(auth.uid());
$$;

alter table public.profiles enable row level security;
alter table public.scriptures enable row level security;
alter table public.scripture_broadcast enable row level security;
alter table public.deliveries enable row level security;
alter table public.feedback enable row level security;

drop policy if exists p_sel on public.profiles;
create policy p_sel on public.profiles for select
    using (user_id = auth.uid() or public.is_admin());
drop policy if exists p_upd on public.profiles;
create policy p_upd on public.profiles for update
    using (user_id = auth.uid() or public.is_admin())
    with check (user_id = auth.uid() or public.is_admin());

drop policy if exists s_adm on public.scriptures;
create policy s_adm on public.scriptures for all
    using (public.is_admin()) with check (public.is_admin());
drop policy if exists s_mine on public.scriptures;
create policy s_mine on public.scriptures for select
    using (exists (
        select 1
        from public.deliveries d
        where d.scripture_id = scriptures.id
            and d.user_id = auth.uid()
    ));

drop policy if exists scripture_broadcast_admin_select on public.scripture_broadcast;
create policy scripture_broadcast_admin_select on public.scripture_broadcast for select
    using (public.is_admin());
drop policy if exists scripture_broadcast_admin_update on public.scripture_broadcast;
create policy scripture_broadcast_admin_update on public.scripture_broadcast for update
    using (public.is_admin()) with check (public.is_admin());

drop policy if exists d_sel on public.deliveries;
create policy d_sel on public.deliveries for select
    using (user_id = auth.uid() or public.is_admin());
drop policy if exists d_admin_ins on public.deliveries;
create policy d_admin_ins on public.deliveries for insert
    with check (public.is_admin());
drop policy if exists d_upd on public.deliveries;
create policy d_upd on public.deliveries for update
    using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists f_ins on public.feedback;
create policy f_ins on public.feedback for insert
    with check (
        user_id = auth.uid()
        and exists (
            select 1
            from public.deliveries d
            where d.id = feedback.delivery_id
                and d.user_id = auth.uid()
        )
    );
drop policy if exists f_sel on public.feedback;
create policy f_sel on public.feedback for select
    using (user_id = auth.uid() or public.is_admin());

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.scriptures to authenticated;
grant select, update on public.scripture_broadcast to authenticated;
grant select, insert, update on public.deliveries to authenticated;
grant select, insert on public.feedback to authenticated;
revoke all on function public.claim_scripture_for(uuid) from public, anon, authenticated;
grant execute on function public.claim_scripture_for(uuid) to service_role;
revoke all on function public.claim_scripture() from public, anon;
grant execute on function public.claim_scripture() to authenticated;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists avatar_upload_own_folder on storage.objects;
create policy avatar_upload_own_folder on storage.objects for insert to authenticated
    with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
drop policy if exists avatar_update_own_folder on storage.objects;
create policy avatar_update_own_folder on storage.objects for update to authenticated
    using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    )
    with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

create or replace function public.manage_admin_role(target_user_id uuid, make_admin boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_role text;
    target_status text;
    approved_admin_count bigint;
begin
    if auth.uid() is null or not exists (
        select 1
        from public.profiles
        where user_id = auth.uid()
            and role = 'admin'
            and registration_status = 'APPROVED'
    ) then
        raise exception 'Only approved admins can manage admin access.';
    end if;

    if target_user_id is null or make_admin is null then
        raise exception 'A target account and requested admin status are required.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(7002);

    select role, registration_status
    into target_role, target_status
    from public.profiles
    where user_id = target_user_id
    for update;

    if not found then
        raise exception 'The selected account was not found.';
    end if;
    if target_status <> 'APPROVED' then
        raise exception 'Only approved accounts can be admins.';
    end if;
    if (make_admin and target_role = 'admin')
        or (not make_admin and target_role = 'member') then
        return;
    end if;
    if target_role not in ('admin', 'member') then
        raise exception 'The selected account has an unsupported role.';
    end if;

    if not make_admin then
        select count(*)
        into approved_admin_count
        from public.profiles
        where role = 'admin'
            and registration_status = 'APPROVED';

        if approved_admin_count <= 1 then
            raise exception 'The last approved admin cannot be removed.';
        end if;
    end if;

    update public.profiles
    set role = case when make_admin then 'admin' else 'member' end
    where user_id = target_user_id;
end;
$$;

revoke all on function public.manage_admin_role(uuid, boolean) from public, anon;
grant execute on function public.manage_admin_role(uuid, boolean) to authenticated;

create table if not exists public.donations (
    id uuid primary key default gen_random_uuid(),
    reference text not null unique,
    donor_email text not null,
    donor_name text,
    amount_minor bigint not null check (amount_minor between 100 and 10000000),
    currency text not null default 'GHS',
    status text not null default 'pending',
    payment_method text not null default 'paystack',
    bank_account_id uuid,
    transfer_reference text,
    created_at timestamptz not null default now(),
    paid_at timestamptz
);

alter table public.donations
    add column if not exists payment_method text not null default 'paystack',
    add column if not exists bank_account_id uuid,
    add column if not exists transfer_reference text;
alter table public.donations drop constraint if exists donations_currency_check;
alter table public.donations add constraint donations_currency_check
    check (currency in ('GHS', 'USD', 'GBP', 'EUR'));
alter table public.donations drop constraint if exists donations_status_check;
alter table public.donations add constraint donations_status_check
    check (status in ('pending', 'awaiting_transfer', 'pending_review', 'success', 'failed'));
alter table public.donations drop constraint if exists donations_payment_method_check;
alter table public.donations add constraint donations_payment_method_check
    check (payment_method in ('paystack', 'bank_transfer'));
create index if not exists donations_status_created_idx
    on public.donations (status, created_at desc);
create index if not exists donations_wire_review_idx
    on public.donations (created_at desc)
    where payment_method = 'bank_transfer' and status = 'pending_review';

create table if not exists public.donation_bank_accounts (
    id uuid primary key default gen_random_uuid(),
    currency text not null unique check (currency in ('USD', 'GBP', 'EUR')),
    beneficiary_name text not null,
    bank_name text not null,
    account_number text,
    iban text,
    swift_bic text,
    routing_number text,
    bank_address text,
    payment_instructions text,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (
        nullif(trim(account_number), '') is not null
        or nullif(trim(iban), '') is not null
    )
);

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'donations_bank_account_id_fkey'
            and conrelid = 'public.donations'::regclass
    ) then
        alter table public.donations
            add constraint donations_bank_account_id_fkey
            foreign key (bank_account_id)
            references public.donation_bank_accounts(id);
    end if;
end;
$$;

alter table public.donations enable row level security;
revoke all on table public.donations from public, anon, authenticated;
grant all on table public.donations to service_role;
grant select on public.donations to authenticated;
drop policy if exists donations_admin_read on public.donations;
create policy donations_admin_read on public.donations for select to authenticated
    using (public.is_admin());

alter table public.donation_bank_accounts enable row level security;
grant select on public.donation_bank_accounts to anon, authenticated;
grant insert, update, delete on public.donation_bank_accounts to authenticated;
drop policy if exists donation_bank_accounts_read on public.donation_bank_accounts;
create policy donation_bank_accounts_read
    on public.donation_bank_accounts for select to anon, authenticated
    using (is_active or public.is_admin());
drop policy if exists donation_bank_accounts_admin on public.donation_bank_accounts;
create policy donation_bank_accounts_admin
    on public.donation_bank_accounts for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

create table if not exists public.push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users on delete cascade,
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
    on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists ps_own on public.push_subscriptions;
create policy ps_own on public.push_subscriptions for all
    using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated;

create table if not exists public.scripture_sends (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users on delete cascade,
    scripture_id uuid references public.scriptures on delete set null,
    channel text not null check (channel in ('email', 'phone')),
    destination text not null,
    status text not null check (status in ('sent', 'failed')),
    error text,
    sent_by uuid references auth.users on delete set null,
    created_at timestamptz not null default now()
);

create index if not exists scripture_sends_user_created_idx
    on public.scripture_sends (user_id, created_at desc);
alter table public.scripture_sends enable row level security;
revoke all on public.scripture_sends from public, anon, authenticated;
grant select on public.scripture_sends to authenticated;
grant all on public.scripture_sends to service_role;
drop policy if exists scripture_sends_admin_read on public.scripture_sends;
create policy scripture_sends_admin_read on public.scripture_sends for select to authenticated
    using (public.is_admin());

create or replace function public.admin_signup_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'Administrator access is required.';
    end if;

    return jsonb_build_object(
        'awaiting', (
            select count(*)
            from public.profiles p
            where p.role = 'member'
                and p.registration_status = 'APPROVED'
                and not exists (
                    select 1 from public.scripture_sends s
                    where s.user_id = p.user_id and s.status = 'sent'
                )
        ),
        'total', (
            select count(*)
            from public.profiles p
            where p.role = 'member' and p.registration_status = 'APPROVED'
        )
    );
end;
$$;

create or replace function public.admin_signups(only_awaiting boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    signup_rows jsonb;
    signup_counts jsonb;
begin
    if not public.is_admin() then
        raise exception 'Administrator access is required.';
    end if;

    select coalesce(jsonb_agg(to_jsonb(rows) order by rows.created_at desc), '[]'::jsonb)
    into signup_rows
    from (
        select p.user_id, p.full_name, p.email, p.phone, p.delivery_channel,
            p.nationality, p.occupation, p.created_at,
            exists (
                select 1 from public.scripture_sends s
                where s.user_id = p.user_id and s.status = 'sent'
            ) as has_sent,
            latest.status as last_status,
            latest.error as last_error,
            latest.created_at as last_attempt_at,
            latest.channel as last_channel
        from public.profiles p
        left join lateral (
            select s.status, s.error, s.created_at, s.channel
            from public.scripture_sends s
            where s.user_id = p.user_id
            order by s.created_at desc
            limit 1
        ) latest on true
        where p.role = 'member'
            and p.registration_status = 'APPROVED'
            and (not coalesce(only_awaiting, true) or not exists (
                select 1 from public.scripture_sends s
                where s.user_id = p.user_id and s.status = 'sent'
            ))
        order by p.created_at desc
        limit 200
    ) rows;

    signup_counts := public.admin_signup_summary();
    return jsonb_build_object(
        'signups', signup_rows,
        'awaiting', (signup_counts ->> 'awaiting')::bigint,
        'total', (signup_counts ->> 'total')::bigint
    );
end;
$$;

revoke all on function public.admin_signup_summary() from public, anon;
revoke all on function public.admin_signups(boolean) from public, anon;
grant execute on function public.admin_signup_summary() to authenticated;
grant execute on function public.admin_signups(boolean) to authenticated;

-- Verification: each required relation should be non-NULL.
select name, to_regclass('public.' || name) as relation
from (values
    ('profiles'),
    ('scriptures'),
    ('scripture_broadcast'),
    ('deliveries'),
    ('feedback'),
    ('donations'),
    ('donation_bank_accounts'),
    ('push_subscriptions'),
    ('scripture_sends')
) as required(name)
order by name;

select
    exists (
        select 1
        from pg_trigger
        where tgrelid = 'auth.users'::regclass
            and tgname = 'on_signup'
            and not tgisinternal
    ) as signup_profile_trigger_installed,
    to_regprocedure('public.claim_scripture()') is not null
        as claim_scripture_rpc_installed,
    to_regprocedure('public.manage_admin_role(uuid,boolean)') is not null
        as admin_management_rpc_installed,
    to_regprocedure('public.admin_signup_summary()') is not null
        as signup_summary_rpc_installed,
    to_regprocedure('public.admin_signups(boolean)') is not null
        as signups_rpc_installed;
