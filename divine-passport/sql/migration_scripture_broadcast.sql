drop trigger if exists scripture_schedule_order on public.scriptures;
drop trigger if exists scripture_schedule_reactivation_order on public.scriptures;
drop function if exists public.set_scripture_schedule_order();
drop function if exists public.reorder_scriptures(uuid[]);

create table if not exists public.scripture_broadcast (
    singleton boolean primary key default true check (singleton),
    scripture_id uuid,
    broadcast_at timestamptz
);

alter table public.scripture_broadcast
    drop constraint if exists scripture_broadcast_scripture_id_fkey;
alter table public.scripture_broadcast
    add constraint scripture_broadcast_scripture_id_fkey
    foreign key (scripture_id) references public.scriptures on delete restrict;

insert into public.scripture_broadcast (singleton)
values (true)
on conflict (singleton) do nothing;

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

alter table public.scripture_broadcast enable row level security;
drop policy if exists scripture_broadcast_admin_select on public.scripture_broadcast;
create policy scripture_broadcast_admin_select on public.scripture_broadcast for select
    using (public.is_admin());
drop policy if exists scripture_broadcast_admin_update on public.scripture_broadcast;
create policy scripture_broadcast_admin_update on public.scripture_broadcast for update
    using (public.is_admin()) with check (public.is_admin());

grant select, update on public.scripture_broadcast to authenticated;

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

create or replace function public.claim_scripture()
returns public.deliveries
language sql
security definer
set search_path = ''
as $$
    select * from public.claim_scripture_for(auth.uid());
$$;

revoke all on function public.claim_scripture_for(uuid) from public, anon, authenticated;
grant execute on function public.claim_scripture_for(uuid) to service_role;
revoke all on function public.claim_scripture() from public, anon;
grant execute on function public.claim_scripture() to authenticated;
