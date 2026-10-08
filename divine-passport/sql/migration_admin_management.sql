-- Run after schema.sql. The existing profile trigger already permits admins
-- to update protected role fields while preventing members from doing so.

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
