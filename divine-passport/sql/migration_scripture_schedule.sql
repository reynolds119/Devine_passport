alter table public.scriptures
    add column if not exists schedule_order integer;

with current_max as (
    select coalesce(max(schedule_order), 0) as value
    from public.scriptures
    where schedule_order > 0
),
missing_order as (
    select id, row_number() over (order by created_at, id) as sort_index
    from public.scriptures
    where schedule_order is null or schedule_order <= 0
)
update public.scriptures sc
set schedule_order = current_max.value + missing_order.sort_index
from current_max, missing_order
where sc.id = missing_order.id;

alter table public.scriptures
    alter column schedule_order set default 0,
    alter column schedule_order set not null;

create index if not exists scriptures_schedule_idx
    on public.scriptures (active, schedule_order, created_at);

create or replace function public.set_scripture_schedule_order()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' and new.schedule_order <= 0 then
        perform pg_advisory_xact_lock(7002);
        select coalesce(max(schedule_order), 0) + 1
        into new.schedule_order
        from public.scriptures;
    elsif tg_op = 'UPDATE' and new.active is distinct from old.active then
        perform pg_advisory_xact_lock(7002);
        if new.active then
            select coalesce(max(schedule_order), 0) + 1
            into new.schedule_order
            from public.scriptures;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists scripture_schedule_order on public.scriptures;
create trigger scripture_schedule_order
before insert on public.scriptures
for each row execute function public.set_scripture_schedule_order();
drop trigger if exists scripture_schedule_reactivation_order on public.scriptures;
create trigger scripture_schedule_reactivation_order
before update of active on public.scriptures
for each row execute function public.set_scripture_schedule_order();

create table if not exists public.scripture_delivery_settings (
    singleton boolean primary key default true check (singleton),
    interval_hours integer not null default 24 check (interval_hours between 1 and 8760),
    updated_at timestamptz not null default now()
);

insert into public.scripture_delivery_settings (singleton, interval_hours)
values (true, 24)
on conflict (singleton) do nothing;

alter table public.scripture_delivery_settings enable row level security;
drop policy if exists scripture_settings_admin_select on public.scripture_delivery_settings;
create policy scripture_settings_admin_select on public.scripture_delivery_settings for select
    using (public.is_admin());
drop policy if exists scripture_settings_admin_update on public.scripture_delivery_settings;
create policy scripture_settings_admin_update on public.scripture_delivery_settings for update
    using (public.is_admin()) with check (public.is_admin());

grant select, update on public.scripture_delivery_settings to authenticated;

create or replace function public.reorder_scriptures(p_scripture_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    active_count integer;
begin
    if not public.is_admin() then
        raise exception 'Only admins can reorder the scripture schedule.';
    end if;

    perform pg_advisory_xact_lock(7002);

    select count(*) into active_count
    from public.scriptures
    where active;

    if p_scripture_ids is null
        or cardinality(p_scripture_ids) <> active_count
        or (select count(distinct scripture_id) from unnest(p_scripture_ids) as ids(scripture_id)) <> active_count
        or exists (
            select 1
            from unnest(p_scripture_ids) as ids(scripture_id)
            left join public.scriptures sc on sc.id = ids.scripture_id
            where sc.id is null or not sc.active
        )
    then
        raise exception 'The schedule must contain every active scripture exactly once.';
    end if;

    update public.scriptures sc
    set schedule_order = ids.ord::integer,
        updated_at = now()
    from unnest(p_scripture_ids) with ordinality as ids(scripture_id, ord)
    where sc.id = ids.scripture_id;
end;
$$;

revoke all on function public.reorder_scriptures(uuid[]) from public, anon;
grant execute on function public.reorder_scriptures(uuid[]) to authenticated;

create or replace function public.claim_scripture_for(uid uuid)
returns public.deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
    delivery public.deliveries;
    scripture uuid;
    last_order integer;
    interval_duration interval;
begin
    if uid is null then
        return null;
    end if;

    perform pg_advisory_xact_lock(7001);

    select make_interval(hours => interval_hours)
    into interval_duration
    from public.scripture_delivery_settings
    where singleton;
    if not found then
        raise exception 'Scripture delivery interval has not been configured.';
    end if;

    select * into delivery
    from public.deliveries
    where user_id = uid
    order by delivered_at desc, id desc
    limit 1;
    if found and delivery.delivered_at + interval_duration > now() then
        return delivery;
    end if;

    if found then
        select sc.schedule_order into last_order
        from public.scriptures sc
        where sc.id = delivery.scripture_id;
    end if;

    select sc.id into scripture
    from public.scriptures sc
    where sc.active
    order by
        case when sc.schedule_order > coalesce(last_order, 0) then 0 else 1 end,
        sc.schedule_order,
        sc.created_at,
        sc.id
    limit 1;
    if scripture is null then
        return null;
    end if;

    insert into public.deliveries (user_id, scripture_id)
    values (uid, scripture)
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
