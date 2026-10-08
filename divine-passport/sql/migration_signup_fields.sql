-- Run once on an existing project (new projects: schema.sql already includes this).
alter table profiles add column if not exists nationality text, add column if not exists occupation text;
create or replace function handle_new_user() returns trigger language plpgsql security definer as $$begin
insert into profiles(user_id,email,full_name,phone,nationality,occupation) values(new.id,new.email,new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'phone',new.raw_user_meta_data->>'nationality',new.raw_user_meta_data->>'occupation');return new;end$$;
