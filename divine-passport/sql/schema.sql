create extension if not exists pgcrypto;

create table profiles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users on delete cascade,
    full_name text,
    email text,
    phone text,
    nationality text,
    occupation text,
    profile_photo text,
    registration_status text not null default 'APPROVED' check (registration_status in ('PENDING', 'APPROVED', 'REJECTED')),
    role text not null default 'member' check (role in ('member', 'admin')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table scriptures (
    id uuid primary key default gen_random_uuid(),
    reference text not null,
    body text not null,
    note text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table scripture_broadcast (
    singleton boolean primary key default true check (singleton),
    scripture_id uuid references scriptures on delete restrict,
    broadcast_at timestamptz
);

create or replace function set_scripture_broadcast_time()
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

create trigger scripture_broadcast_timestamp
before update on scripture_broadcast
for each row execute function public.set_scripture_broadcast_time();

insert into scripture_broadcast (singleton)
values (true);

create table deliveries (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users on delete cascade,
    scripture_id uuid not null references scriptures on delete cascade,
    delivered_at timestamptz not null default now(),
    read_at timestamptz,
    saved boolean not null default false
);

create table feedback (
    id uuid primary key default gen_random_uuid(),
    delivery_id uuid not null references deliveries on delete cascade,
    user_id uuid not null references auth.users on delete cascade,
    message text not null check (length(trim(message)) > 0),
    created_at timestamptz not null default now()
);

create index deliveries_user_day_idx on deliveries (user_id, delivered_at desc);
create index deliveries_saved_idx on deliveries (user_id, delivered_at desc) where saved;
create index deliveries_scripture_idx on deliveries (scripture_id);
create index feedback_delivery_idx on feedback (delivery_id, created_at);
create index scriptures_active_idx on scriptures (active, created_at desc);

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.profiles
        where user_id = auth.uid() and role = 'admin'
    );
$$;

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (user_id, email, full_name, phone, nationality, occupation)
    values (
        new.id,
        new.email,
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'phone',
        new.raw_user_meta_data ->> 'nationality',
        new.raw_user_meta_data ->> 'occupation'
    );
    return new;
end;
$$;

create trigger on_signup
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function guard_profile()
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

create trigger guard_profile_update
before update on profiles
for each row execute function public.guard_profile();

create or replace function claim_scripture_for(uid uuid)
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

    select * into delivery
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

create or replace function claim_scripture()
returns public.deliveries
language sql
security definer
set search_path = ''
as $$
    select * from public.claim_scripture_for(auth.uid());
$$;

alter table profiles enable row level security;
alter table scriptures enable row level security;
alter table scripture_broadcast enable row level security;
alter table deliveries enable row level security;
alter table feedback enable row level security;

create policy p_sel on profiles for select
    using (user_id = auth.uid() or public.is_admin());
create policy p_upd on profiles for update
    using (user_id = auth.uid() or public.is_admin())
    with check (user_id = auth.uid() or public.is_admin());
create policy s_adm on scriptures for all
    using (public.is_admin()) with check (public.is_admin());
create policy s_mine on scriptures for select
    using (exists (
        select 1 from public.deliveries d
        where d.scripture_id = scriptures.id and d.user_id = auth.uid()
    ));
create policy scripture_broadcast_admin_select on scripture_broadcast for select
    using (public.is_admin());
create policy scripture_broadcast_admin_update on scripture_broadcast for update
    using (public.is_admin()) with check (public.is_admin());
create policy d_sel on deliveries for select
    using (user_id = auth.uid() or public.is_admin());
create policy d_admin_ins on deliveries for insert
    with check (public.is_admin());
create policy d_upd on deliveries for update
    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy f_ins on feedback for insert
    with check (
        user_id = auth.uid()
        and exists (
            select 1 from public.deliveries d
            where d.id = feedback.delivery_id and d.user_id = auth.uid()
        )
    );
create policy f_sel on feedback for select
    using (user_id = auth.uid() or public.is_admin());

grant select, update on profiles to authenticated;
grant select, insert, update, delete on scriptures to authenticated;
grant select, update on scripture_broadcast to authenticated;
grant select, insert, update on deliveries to authenticated;
grant select, insert on feedback to authenticated;
revoke all on function public.claim_scripture_for(uuid) from public, anon, authenticated;
grant execute on function public.claim_scripture_for(uuid) to service_role;
revoke all on function public.claim_scripture() from public, anon;
grant execute on function public.claim_scripture() to authenticated;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

create policy avatar_upload_own_folder on storage.objects for insert to authenticated
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatar_update_own_folder on storage.objects for update to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- First admin: register, then run:
-- update public.profiles set role = 'admin' where email = 'you@example.com';
