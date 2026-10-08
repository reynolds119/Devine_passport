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
    check (nullif(trim(account_number), '') is not null or nullif(trim(iban), '') is not null)
);

alter table public.donation_bank_accounts enable row level security;
grant select on public.donation_bank_accounts to anon, authenticated;
grant insert, update, delete on public.donation_bank_accounts to authenticated;
drop policy if exists donation_bank_accounts_read on public.donation_bank_accounts;
create policy donation_bank_accounts_read on public.donation_bank_accounts for select to anon, authenticated
    using (is_active or public.is_admin());
drop policy if exists donation_bank_accounts_admin on public.donation_bank_accounts;
create policy donation_bank_accounts_admin on public.donation_bank_accounts for all to authenticated
    using (public.is_admin()) with check (public.is_admin());

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

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'donations_bank_account_id_fkey'
          and conrelid = 'public.donations'::regclass
    ) then
        alter table public.donations
            add constraint donations_bank_account_id_fkey
            foreign key (bank_account_id) references public.donation_bank_accounts(id);
    end if;
end;
$$;

create index if not exists donations_wire_review_idx
    on public.donations (created_at desc) where payment_method = 'bank_transfer' and status = 'pending_review';

grant select on public.donations to authenticated;
drop policy if exists donations_admin_read on public.donations;
create policy donations_admin_read on public.donations for select to authenticated
    using (public.is_admin());
